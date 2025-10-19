'use strict';

/**
 * EduAI Brain — V14 Multi-Model Async (Ultra Max Stable)
 * - Multi-API-key pools with failover/rotation
 * - Dedicated models:
 *    chatModel => gemini-2.5-flash
 *    taskModel => gemini-2.5-pro
 *    titleModel => gemini-2.5-flash-lite
 *    plannerModel => gemini-2.5-pro (same pool as taskModel)
 * - Async progressive reply: initial ack -> background processing -> follow-up notification
 * - Supports Arabic, English, French
 *
 * Required env:
 * - FIREBASE_SERVICE_ACCOUNT_KEY
 * Optional:
 * - REDIS_URL
 * - GOOGLE_API_KEY_1 .. GOOGLE_API_KEY_4 (preferred)
 * - Fallback: GOOGLE_API_KEY
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// --- CONFIG ---
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  CHAT_MODEL_NAME: process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash',
  TASK_MODEL_NAME: process.env.TASK_MODEL_NAME || 'gemini-2.5-pro',
  TITLE_MODEL_NAME: process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite',
  TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  CACHE_TTL: Number(process.env.CACHE_TTL_MS || 30 * 1000),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
  BODY_LIMIT: process.env.BODY_LIMIT || '200kb',
  SHUTDOWN_TIMEOUT: Number(process.env.SHUTDOWN_TIMEOUT || 10000),
  REDIS_URL: process.env.REDIS_URL || null,
};

// --- sanity env check for firebase at least ---
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var.');
  process.exit(1);
}

// --- EXPRESS ---
const app = express();
app.use(cors());
app.use(express.json({ limit: CONFIG.BODY_LIMIT }));

// --- Request tracing middleware ---
app.use((req, res, next) => {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  req.log = (...args) => console.log(`[${new Date().toISOString()}] [req:${reqId}]`, ...args);
  next();
});

// --- Cache: optional Redis or in-memory LRU TTL ---
let redisClient = null;
let useRedis = false;
if (process.env.REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    redisClient = new IORedis(process.env.REDIS_URL);
    useRedis = true;
    console.log('Using Redis cache');
  } catch (e) {
    console.warn('ioredis not installed or failed to init, falling back to in-memory cache');
  }
}

class LRUCache {
  constructor(limit = 500, ttl = CONFIG.CACHE_TTL) {
    this.limit = limit;
    this.ttl = ttl;
    this.map = new Map();
  }
  _isExpired(entry) { return Date.now() - entry.t > this.ttl; }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (this._isExpired(e)) { this.map.delete(key); return null; }
    this.map.delete(key); this.map.set(key, e); return e.v;
  }
  set(key, value) {
    if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { v: value, t: Date.now() });
  }
  del(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

const localCache = { profile: new LRUCache(500), progress: new LRUCache(500) };

async function cacheGet(scope, key) {
  if (useRedis && redisClient) {
    try { const v = await redisClient.get(`${scope}:${key}`); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  return localCache[scope].get(key);
}
async function cacheSet(scope, key, value) {
  if (useRedis && redisClient) {
    try { await redisClient.set(`${scope}:${key}`, JSON.stringify(value), 'PX', CONFIG.CACHE_TTL); return; } catch (e) { /* ignore */ }
  }
  localCache[scope].set(key, value);
}
async function cacheDel(scope, key) {
  if (useRedis && redisClient) {
    try { await redisClient.del(`${scope}:${key}`); } catch (e) { /* ignore */ }
  }
  localCache[scope].del(key);
}
async function cacheClear(scope) {
  if (useRedis && redisClient) {
    try {
      // pattern deletion omitted for safety
    } catch (e) { /* ignore */ }
  }
  if (localCache[scope]) localCache[scope].clear();
}

// --- FIREBASE INIT (robust parsing) ---
let db;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e1) {
    try {
      const repaired = raw.replace(/\r?\n/g, '\\n');
      serviceAccount = JSON.parse(repaired);
    } catch (e2) {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    }
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized.');
} catch (err) {
  console.error('❌ Firebase initialization failed:', err && err.message ? err.message : err);
  process.exit(1);
}

// --- API key pools and model pools setup ---
// Gather keys from env variables in priority order
const apiKeyCandidates = [];
for (let i = 1; i <= 4; i++) {
  const k = process.env[`GOOGLE_API_KEY_${i}`];
  if (k && typeof k === 'string' && k.trim()) apiKeyCandidates.push(k.trim());
}
if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) {
  apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
}
if (apiKeyCandidates.length === 0) {
  console.error('No GOOGLE_API_KEY_* nor GOOGLE_API_KEY provided. Please set at least one.');
  process.exit(1);
}
console.log(`Using ${apiKeyCandidates.length} Google API key(s) for model pools.`);

// Build model pools: for each key create a generative client + model instance per role
const chatPool = [];   // gemini-2.5-flash
const taskPool = [];   // gemini-2.5-pro  (used for both task & planner)
const titlePool = [];  // gemini-2.5-flash-lite

for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
    // graceful: some keys might fail; wrap in try
    try {
      const chatM = client.getGenerativeModel({ model: CONFIG.CHAT_MODEL_NAME });
      chatPool.push({ client, model: chatM, key });
    } catch (e) { console.warn('Failed create chat model for key, skipping for chat role.'); }
    try {
      const taskM = client.getGenerativeModel({ model: CONFIG.TASK_MODEL_NAME });
      taskPool.push({ client, model: taskM, key });
    } catch (e) { console.warn('Failed create task model for key, skipping for task role.'); }
    try {
      const titleM = client.getGenerativeModel({ model: CONFIG.TITLE_MODEL_NAME });
      titlePool.push({ client, model: titleM, key });
    } catch (e) { console.warn('Failed create title model for key, skipping for title role.'); }
  } catch (err) {
    console.warn('Failed initialize GoogleGenerativeAI client for one key — skipping that key.', err && err.message ? err.message : err);
  }
}

// ensure pools have at least one element; otherwise fail
if (chatPool.length === 0 || taskPool.length === 0 || titlePool.length === 0) {
  console.error('Model pools incomplete. Ensure at least one API key works for each model type.');
  // but we won't exit; we'll attempt to continue — but warn
}

// helper: pick random start index array of indices shuffled
function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// generate with failover across pool
async function generateWithFailover(pool, prompt, label = 'model', timeoutMs = CONFIG.TIMEOUT_MS) {
  if (!pool || pool.length === 0) throw new Error('No model instances available in pool');
  const order = shuffledIndices(pool.length);
  let lastErr = null;
  for (const idx of order) {
    const inst = pool[idx];
    try {
      const call = inst.model.generateContent ? () => inst.model.generateContent(prompt) : () => inst.model.generate(prompt);
      const res = await withTimeout(call(), timeoutMs, `${label} (key ${idx})`);
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[${iso()}] ${label} call failed for key idx=${idx} (${inst.key}):`, err && err.message ? err.message : err);
      // try next key
    }
  }
  // if all keys failed, throw last error
  throw lastErr || new Error(`${label} failed with no specific error`);
}

// --- Google models warmup (best-effort, non-blocking) ---
(async () => {
  try {
    if (chatPool.length > 0) {
      try { await retry(() => withTimeout(chatPool[0].model.generateContent('ping'), adaptiveTimeout('chat model'), 'chat warmup'), 2, 200); console.log('💡 Chat model warmup OK'); } catch(e){ console.warn('⚠️ Chat warmup failed (non-fatal)'); }
    }
  } catch (e) { /* ignore */ }
})();

// --- Metrics ---
const metrics = { requests: 0, errors: 0, avgLatencyMs: 0, sampleCount: 0 };
function observeLatency(latMs) {
  metrics.sampleCount += 1;
  const n = metrics.sampleCount;
  metrics.avgLatencyMs = Math.round(((metrics.avgLatencyMs * (n - 1)) + latMs) / n);
}

// --- Utils (reused/extended) ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

function adaptiveTimeout(label) {
  if (label === 'chat model') return Math.round(CONFIG.TIMEOUT_MS * 1.2);
  if (label === 'task generation') return CONFIG.TIMEOUT_MS;
  if (label === 'task modification') return Math.round(CONFIG.TIMEOUT_MS * 1.0);
  if (label === 'title generation') return 5000;
  return CONFIG.TIMEOUT_MS;
}

async function withTimeout(promise, ms = CONFIG.TIMEOUT_MS, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function retry(fn, attempts = CONFIG.MAX_RETRIES, initialDelay = 400) {
  let lastErr;
  let delay = initialDelay;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delay);
      delay = Math.round(delay * 1.8);
    }
  }
  throw lastErr;
}

async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    const resp = result.response ? await result.response : result;
    if (!resp) return '';
    if (resp && typeof resp.text === 'function') {
      const t = await resp.text();
      return (t || '').toString().trim();
    }
    if (typeof resp.text === 'string' && resp.text.trim()) return resp.text.trim();
    if (typeof resp.outputText === 'string' && resp.outputText.trim()) return resp.outputText.trim();
    if (Array.isArray(resp.content) && resp.content.length) return resp.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    if (Array.isArray(resp.candidates) && resp.candidates.length) return resp.candidates.map(c => c?.text || '').join('').trim();
    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

function escapeForPrompt(s) { if (!s) return ''; return String(s).replace(/<\/+/g, '<\\/').replace(/"/g, '\\"'); }
function safeSnippet(text, max = 6000) { if (typeof text !== 'string') return ''; if (text.length <= max) return text; return text.slice(0, max) + '\n\n... [truncated]'; }

function parseJSONFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0];
  candidate = candidate.replace(/```(?:json)?/g, '').trim();
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(candidate); } catch (e) { const cleaned = candidate.replace(/[\u0000-\u001F]+/g, ''); try { return JSON.parse(cleaned); } catch (e2) { return null; } }
}

// --- Language detection (Arabic/English/French) ---
function detectLangLocal(text) {
  if (!text || typeof text !== 'string') return 'Arabic';
  const arabicMatches = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const frenchMatches = (text.match(/[éèêëàâôùûçœÉÈÀÂÔÇÛŒ]/g) || []).length;
  const latinMatches = (text.match(/[a-zA-Z]/g) || []).length;
  const len = Math.max(1, text.length);
  if (arabicMatches / len > 0.02) return 'Arabic';
  if (frenchMatches / len > 0.01) return 'French';
  if (latinMatches / len > 0.02) return 'English';
  return 'Arabic';
}
async function detectLanguage(text) {
  try {
    const local = detectLangLocal(text);
    if (local) return local;
    // fallback to titleModel (rare)
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${(text || '').replace(/"/g, '\\"')}"`;
    const res = await generateWithFailover(titlePool, prompt, 'language detection', adaptiveTimeout('title generation'));
    const rawText = await extractTextFromResult(res);
    if (!rawText) return 'Arabic';
    const token = (rawText.split(/[^a-zA-Z]+/).find(Boolean) || '').toLowerCase();
    if (!token) return 'Arabic';
    return token[0].toUpperCase() + token.slice(1);
  } catch (err) {
    console.error('Language detection failed, fallback Arabic:', err && err.message ? err.message : err);
    return 'Arabic';
  }
}

// --- Firestore helpers (with cache) ---
async function getProfile(userId) {
  try {
    const key = userId;
    const cached = await cacheGet('profile', key);
    if (cached) return cached;
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = doc.exists && doc.data()?.profileSummary ? String(doc.data().profileSummary) : 'No available memory.';
    await cacheSet('profile', key, val);
    return val;
  } catch (err) {
    console.error(`Error fetching memory profile for ${userId}:`, err && err.message ? err.message : err);
    return 'No available memory.';
  }
}

async function getProgress(userId) {
  try {
    const key = userId;
    const cached = await cacheGet('progress', key);
    if (cached) return cached;
    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) {
      const val = doc.data() || {};
      await cacheSet('progress', key, val);
      return val;
    }
  } catch (err) {
    console.error(`Error fetching progress for ${userId}:`, err && err.message ? err.message : err);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
}

async function getLessonContent(lessonId) {
  try {
    if (!lessonId) return null;
    const doc = await db.collection('lessonsContent').doc(lessonId).get();
    if (doc.exists && doc.data()?.content) return String(doc.data().content);
  } catch (err) {
    console.error(`Error fetching lesson content for ${lessonId}:`, err && err.message ? err.message : err);
  }
  return null;
}

async function fetchUserWeaknesses(userId) {
  try {
    const doc = await db.collection('userProgress').doc(userId).get();
    if (!doc.exists) return [];
    const progressData = doc.data()?.pathProgress || {};
    const weaknesses = [];
    for (const pathId of Object.keys(progressData)) {
      const pathEntry = progressData[pathId] || {};
      const subjects = pathEntry.subjects || {};
      for (const subjectId of Object.keys(subjects)) {
        const subjectEntry = subjects[subjectId] || {};
        const lessons = subjectEntry.lessons || {};
        for (const lessonId of Object.keys(lessons)) {
          const lessonData = lessons[lessonId] || {};
          const masteryScore = Number(lessonData.masteryScore || 0);
          if (!Number.isNaN(masteryScore) && masteryScore < 75) {
            weaknesses.push({ lessonId, subjectId, masteryScore, suggestedReview: lessonData.suggestedReview || 'Review needed' });
          }
        }
      }
    }
    return weaknesses;
  } catch (err) {
    console.error(`Error fetching weaknesses for ${userId}:`, err && err.message ? err.message : err);
    return [];
  }
}

// --- Notifications helper (writes to Firestore + optional FCM if token present) ---
async function sendUserNotification(userId, payload) {
  try {
    const notifRef = db.collection('userNotifications').doc(userId).collection('inbox');
    await notifRef.add({
      message: payload.message,
      meta: payload.meta || {},
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lang: payload.lang || 'Arabic',
    });
  } catch (err) {
    console.error(`[${iso()}] Failed to write notification for ${userId}:`, err && err.message ? err.message : err);
  }
  // Optionally: send FCM if fcmToken exists in aiMemoryProfiles
  try {
    const profileDoc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const token = profileDoc.exists ? profileDoc.data()?.fcmToken : null;
    if (token) {
      const message = {
        token,
        notification: {
          title: payload.title || 'EduAI',
          body: payload.message,
        },
        data: payload.data || {},
      };
      try { await admin.messaging().send(message); } catch (e) { /* ignore fcm errors */ }
    }
  } catch (e) {
    /* ignore */
  }
}

// --- Helpers to format tasks for human message ---
function formatTasksHuman(tasks, lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  if (lang === 'English') {
    return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
  } else if (lang === 'French') {
    return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
  } else {
    // Arabic
    return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
  }
}

// --- Business logic (adapted to use generateWithFailover pools) ---
const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);

// handleUpdateTasks: uses taskPool (gemini-2.5-pro)
async function handleUpdateTasks({ userId, userRequest }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');
  console.log(`[${iso()}] 🔧 handleUpdateTasks for user=${userId}`);
  const progressDoc = await db.collection('userProgress').doc(userId).get();
  const currentTasks = progressDoc.exists ? (progressDoc.data().dailyTasks?.tasks || []) : [];

  const modificationPrompt = `
You are an intelligent task manager. Modify a user's task list based on their request.
Respond ONLY with a valid JSON object: { "tasks": [...] }.

Current tasks:
${JSON.stringify(currentTasks)}

User request:
"${escapeForPrompt(userRequest)}"

Instructions:
- Titles must be in Arabic (if user used Arabic) but ensure task titles are short.
- Use one of the exact strings for the "type" field: 'review', 'quiz', 'new_lesson', 'practice', 'study'.
- Each task must include: id, title, type, status ('pending' or 'done'), relatedLessonId (nullable), relatedSubjectId (nullable).
- Output only a JSON object.
`.trim();

  try {
    const res = await retry(() => generateWithFailover(taskPool, modificationPrompt, 'task modification', adaptiveTimeout('task modification')), CONFIG.MAX_RETRIES, 500);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      console.error(`[${iso()}] ❌ Task model returned invalid tasks for ${userId}. raw: ${rawText}`);
      throw new Error('Model returned invalid tasks array');
    }
    const normalized = parsed.tasks.map((t) => {
      const type = (t.type || '').toString().toLowerCase();
      return {
        id: t.id || (String(Date.now()) + Math.random().toString(36).slice(2, 9)),
        title: (t.title || t.name || 'مهمة جديدة').toString(),
        type: VALID_TASK_TYPES.has(type) ? type : 'review',
        status: t.status || 'pending',
        relatedLessonId: t.relatedLessonId || null,
        relatedSubjectId: t.relatedSubjectId || null,
      };
    });

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    try { await cacheSet('progress', userId, Object.assign({}, progressDoc.exists ? progressDoc.data() : {}, { dailyTasks: { tasks: normalized } })); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${iso()}] ✅ Updated tasks for user=${userId}. New count: ${normalized.length}`);
    return normalized;
  } catch (err) {
    console.error(`[${iso()}] handleUpdateTasks error for ${userId}:`, err && err.stack ? err.stack : err);
    throw err;
  }
}

// handleGenerateDailyTasks: uses taskPool (planner)
async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID is required');
  console.log(`[${iso()}] 📅 handleGenerateDailyTasks for ${userId}`);

  try {
    const weaknesses = await fetchUserWeaknesses(userId);
    const weaknessesPrompt = weaknesses.length > 0
      ? `${weaknesses.map(w => `- Lesson ID: ${w.lessonId}, Subject: ${w.subjectId}, Mastery: ${w.masteryScore}%`).join('\n')}`
      : 'User has no specific weaknesses. Suggest a new lesson about a general topic.';

    const taskPrompt = `
You are an expert academic planner. Generate a personalized daily study plan. Respond ONLY with a valid JSON object: { "tasks": [...] }.

User weaknesses/context:
${weaknessesPrompt}

Instructions:
1. Create 2-3 tasks based on weaknesses. If none, create introductory tasks.
2. Titles must be in Arabic when appropriate.
3. Each task must include: id, title, type, status ('pending'), relatedLessonId, and relatedSubjectId.
4. Output only JSON.
`.trim();

    const res = await retry(() => generateWithFailover(taskPool, taskPrompt, 'task generation', adaptiveTimeout('task generation')), CONFIG.MAX_RETRIES, 500);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);

    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      console.warn(`[${iso()}] ⚠️ Model returned empty/invalid tasks for ${userId}. Using fallback.`);
      throw new Error('Model returned empty tasks');
    }

    const tasksToSave = parsed.tasks.slice(0, 5).map((task, i) => ({
      id: task.id || (String(Date.now() + i)),
      title: (task.title || task.name || 'مهمة تعليمية').toString(),
      type: VALID_TASK_TYPES.has((task.type || '').toString().toLowerCase()) ? (task.type || '').toString().toLowerCase() : 'review',
      status: task.status || 'pending',
      relatedLessonId: task.relatedLessonId || null,
      relatedSubjectId: task.relatedSubjectId || null,
    }));

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    try { await cacheSet('progress', userId, { dailyTasks: { tasks: tasksToSave } }); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${iso()}] ✅ Generated ${tasksToSave.length} tasks for ${userId}`);
    return { tasks: tasksToSave, source: 'AI', generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`[${iso()}] ❌ handleGenerateDailyTasks (${userId}) failed:`, err && err.stack ? err.stack : err);
    const fallbackTasks = [{
      id: String(Date.now()),
      title: 'مراجعة درس مهم',
      type: 'review',
      status: 'pending',
      relatedLessonId: null,
      relatedSubjectId: null,
    }];
    try {
      await db.collection('userProgress').doc(userId).set({
        dailyTasks: { tasks: fallbackTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
      }, { merge: true });
      try { await cacheSet('progress', userId, { dailyTasks: { tasks: fallbackTasks } }); } catch (e) {}
      await cacheDel('progress', userId);
      console.log(`[${iso()}] ✅ Saved fallback task for ${userId}`);
      return { tasks: fallbackTasks, source: 'fallback', generatedAt: new Date().toISOString() };
    } catch (saveErr) {
      console.error(`[${iso()}] ⚠️ CRITICAL: Failed to save fallback task for ${userId}:`, saveErr && saveErr.stack ? saveErr.stack : saveErr);
      return { tasks: fallbackTasks, source: 'fallback_unsaved', generatedAt: new Date().toISOString() };
    }
  }
}

// --- Parser for actions (background) ---
// This parser will detect 3 possible actions: manage_tasks, generate_plan, none
async function parseUserAction(userRequest, currentTasks) {
  const prompt = `
Decide if the user's request is one of: "manage_tasks", "generate_plan", or "none".
Respond EXACTLY with a JSON object: { "action": "...", "userRequest": "..." }.
- action should be one of "manage_tasks", "generate_plan", "none".
- userRequest should be a clean shorter description of user's intent in the original language.

User message:
"${escapeForPrompt(userRequest)}"

Current tasks (for context):
${JSON.stringify(currentTasks || [])}
`.trim();

  try {
    // Use taskPool (pro) to parse reliably
    const res = await retry(() => generateWithFailover(taskPool, prompt, 'action parser', adaptiveTimeout('task modification')), 2, 200);
    const raw = await extractTextFromResult(res);
    const parsed = parseJSONFromText(raw);
    if (!parsed || !parsed.action) return { action: 'none', userRequest };
    return { action: parsed.action || 'none', userRequest: parsed.userRequest || userRequest };
  } catch (err) {
    console.warn(`[${iso()}] Action parsing failed, defaulting to none:`, err && err.message ? err.message : err);
    return { action: 'none', userRequest };
  }
}

// --- Async background processor invoked after initial ack ---
async function backgroundProcessor({ userId, userRequest, profile, progress, detectedLang }) {
  try {
    const currentTasks = (progress && progress.dailyTasks && Array.isArray(progress.dailyTasks.tasks)) ? progress.dailyTasks.tasks : [];
    const parse = await parseUserAction(userRequest, currentTasks);

    if (parse.action === 'manage_tasks') {
      // perform update
      let updatedTasks;
      try {
        updatedTasks = await handleUpdateTasks({ userId, userRequest: parse.userRequest });
      } catch (err) {
        // notify failure
        const failMsg = detectedLang === 'English' ? `⚠️ Failed to update tasks: ${err.message}` : detectedLang === 'French' ? `⚠️ Échec de la mise à jour des tâches: ${err.message}` : `⚠️ فشل تحديث المهام: ${err.message}`;
        await sendUserNotification(userId, { message: failMsg, lang: detectedLang });
        return;
      }
      // build human summary and ask chat model to craft friendly follow-up
      const humanSummary = formatTasksHuman(updatedTasks, detectedLang === 'Arabic' ? 'Arabic' : (detectedLang === 'French' ? 'French' : 'English'));
      // craft follow-up prompt
      const followPrompt = `
You are EduAI, a warm study companion. The tasks for user ${userId} were just updated based on their request: "${escapeForPrompt(parse.userRequest)}".
Provide a short friendly follow-up message in ${detectedLang} confirming completion and show the updated tasks in a concise format.
Do not include JSON — produce human-readable friendly text.
Tasks:
${humanSummary}
`.trim();
      try {
        const followRes = await retry(() => generateWithFailover(chatPool, followPrompt, 'chat followup', adaptiveTimeout('chat model')), 2, 200);
        const followText = await extractTextFromResult(followRes);
        await sendUserNotification(userId, { message: followText || (detectedLang === 'Arabic' ? '✅ تم تحديث مهامك.' : detectedLang === 'French' ? '✅ Tâches mises à jour.' : '✅ Tasks updated.'), lang: detectedLang });
      } catch (err) {
        // fallback: simple notification
        const simple = detectedLang === 'Arabic' ? `✅ تم تحديث مهامك.\n${humanSummary}` : detectedLang === 'French' ? `✅ Tâches mises à jour.\n${humanSummary}` : `✅ Tasks updated.\n${humanSummary}`;
        await sendUserNotification(userId, { message: simple, lang: detectedLang });
      }
      return;
    }

    if (parse.action === 'generate_plan') {
      // generate plan
      let result;
      try {
        result = await handleGenerateDailyTasks(userId);
      } catch (err) {
        const failMsg = detectedLang === 'Arabic' ? `⚠️ فشل إنشاء الخطة: ${err.message}` : detectedLang === 'French' ? `⚠️ Échec de la génération du plan: ${err.message}` : `⚠️ Failed to generate plan: ${err.message}`;
        await sendUserNotification(userId, { message: failMsg, lang: detectedLang });
        return;
      }
      const humanSummary = formatTasksHuman(result.tasks, detectedLang === 'Arabic' ? 'Arabic' : (detectedLang === 'French' ? 'French' : 'English'));
      const followPrompt = `
You are EduAI. Inform the user in ${detectedLang} that their daily study plan has been created and present the tasks concisely.
Plan details:
${humanSummary}
`.trim();
      try {
        const followRes = await retry(() => generateWithFailover(chatPool, followPrompt, 'chat followup', adaptiveTimeout('chat model')), 2, 200);
        const followText = await extractTextFromResult(followRes);
        await sendUserNotification(userId, { message: followText || (detectedLang === 'Arabic' ? '✅ تم إنشاء خطة اليوم.' : detectedLang === 'French' ? '✅ Plan créé.' : '✅ Plan created.'), lang: detectedLang });
      } catch (err) {
        const simple = detectedLang === 'Arabic' ? `✅ تم إنشاء خطة اليوم.\n${humanSummary}` : detectedLang === 'French' ? `✅ Plan créé.\n${humanSummary}` : `✅ Plan created.\n${humanSummary}`;
        await sendUserNotification(userId, { message: simple, lang: detectedLang });
      }
      return;
    }

    // action none: optionally craft a second richer reply if desired (we'll do nothing)
    return;
  } catch (err) {
    console.error(`[${iso()}] backgroundProcessor error for ${userId}:`, err && err.stack ? err.stack : err);
    try { await sendUserNotification(userId, { message: detectedLang === 'Arabic' ? '⚠️ حدث خطأ غير متوقع أثناء معالجة طلبك.' : detectedLang === 'French' ? '⚠️ Une erreur est survenue.' : '⚠️ An unexpected error occurred.' , lang: detectedLang }); } catch (e) {}
  }
}

// ----------------- ROUTES -----------------

/**
 * /chat
 * - Generates an initial ack reply from chat model and returns it immediately.
 * - Performs parsing + actual operation in background and notifies user when done.
 */
app.post('/chat', async (req, res) => {
  const start = Date.now();
  metrics.requests += 1;

  try {
    const { userId, message, history = [] } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    const [profile, progress, detectedLang] = await Promise.all([getProfile(userId), getProgress(userId), detectLanguage(message)]);

    // create short initial acknowledgement (always generated)
    const ackPrompt = `
You are EduAI, a warm and empathetic study companion. Provide a SHORT (max 25 words) acknowledgement in ${detectedLang} to the user's message indicating you will process the request and notify them once finished. Do NOT perform the task here.
User message: "${escapeForPrompt(safeSnippet(message, 300))}"
`;
    let ackText = detectedLang === 'Arabic' ? 'جاري العمل على طلبك الآن — سأخبرك عند الانتهاء.' : detectedLang === 'French' ? "Je m'occupe de votre demande — je vous informerai dès que c'est prêt." : 'Working on your request — I will notify you when done.';
    try {
      const ackRes = await retry(() => generateWithFailover(chatPool, ackPrompt, 'chat ack', adaptiveTimeout('chat model')), 2, 200);
      const t = await extractTextFromResult(ackRes);
      if (t && t.trim()) ackText = t.trim();
    } catch (e) {
      // keep default ackText
      console.warn(`[${iso()}] ack generation failed, using fallback ack text for user=${userId}`);
    }

    // send ACK immediately
    res.json({ reply: ackText });
    observeLatency(Date.now() - start);

    // Launch background processing
    setImmediate(() => {
      backgroundProcessor({ userId, userRequest: message, profile, progress, detectedLang })
        .catch(err => console.error(`[${iso()}] backgroundProcessor top-level error for ${userId}:`, err && err.stack ? err.stack : err));
    });

    return;
  } catch (err) {
    metrics.errors += 1;
    console.error(`[${iso()}] ❌ /chat error:`, err && err.stack ? err.stack : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) return res.status(504).json({ error: 'Model request timed out.' });
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * /update-daily-tasks (direct HTTP wrapper, synchronous)
 */
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });
    const updated = await handleUpdateTasks({ userId, userRequest });
    return res.status(200).json({ success: true, tasks: updated, generatedAt: new Date().toISOString(), source: 'AI' });
  } catch (err) {
    console.error(`[${iso()}] ❌ Error in /update-daily-tasks:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to update daily tasks.' });
  }
});

/**
 * /generate-daily-tasks (direct HTTP wrapper)
 */
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const result = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, generatedAt: result.generatedAt || new Date().toISOString(), source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    console.error(`[${iso()}] ❌ Error in /generate-daily-tasks:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

/**
 * /generate-title
 */
app.post('/generate-title', async (req, res) => {
  const { message, language } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  try {
    const lang = language || 'Arabic';
    const prompt = `Summarize this message into a short, engaging chat title in ${lang}. Respond with ONLY the title text. NEVER respond with an empty string. Message: "${escapeForPrompt(safeSnippet(message, 1000))}"`;
    const modelRes = await retry(() => generateWithFailover(titlePool, prompt, 'title generation', adaptiveTimeout('title generation')), 2, 200);
    let titleText = await extractTextFromResult(modelRes);
    if (!titleText) { console.warn(`[${iso()}] ⚠️ Title model returned empty. Using fallback.`); titleText = 'محادثة جديدة'; }
    return res.status(200).json({ title: titleText.trim() });
  } catch (err) {
    console.error(`[${iso()}] ❌ Title generation failed:`, err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'محادثة جديدة' });
  }
});

/**
 * /metrics
 */
app.get('/metrics', (req, res) => {
  res.json(metrics);
});

/**
 * /health
 */
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development', metrics, time: iso() });
});

// --- Graceful shutdown ---
let server = null;
function shutdown(signal) {
  console.log(`[${iso()}] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      console.log(`[${iso()}] HTTP server closed.`);
      if (redisClient) {
        try { await redisClient.quit(); } catch (e) { /* ignore */ }
      }
      process.exit(0);
    });
    setTimeout(() => { console.warn(`[${iso()}] Forcing shutdown.`); process.exit(1); }, CONFIG.SHUTDOWN_TIMEOUT).unref();
  } else { process.exit(0); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Start server ---
server = app.listen(CONFIG.PORT, () => {
  console.log(`🚀 EduAI Brain (V14 Multi-Model Async) running on port ${CONFIG.PORT}`);
  console.log(`💬 Chat model (pool size): ${chatPool.length}`);
  console.log(`🧩 Task/Planner model (pool size): ${taskPool.length}`);
  console.log(`🏷️ Title model (pool size): ${titlePool.length}`);
});

module.exports = {
  app,
  handleUpdateTasks,
  handleGenerateDailyTasks,
  getProgress,
  getProfile,
};
