'use strict';

/**
 * EduAI Brain — V14 Multi-Model Async (Ultra Max Stable) — REWRITTEN (cleaned + fixes)
 * - Keeps multi-key pools + failover
 * - Stronger prompts for task generation & action parsing (to reduce false positives)
 * - Better error logging and defensive handling
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
  return localCache[scope] ? localCache[scope].get(key) : null;
}
async function cacheSet(scope, key, value) {
  if (useRedis && redisClient) {
    try { await redisClient.set(`${scope}:${key}`, JSON.stringify(value), 'PX', CONFIG.CACHE_TTL); return; } catch (e) { /* ignore */ }
  }
  if (localCache[scope]) localCache[scope].set(key, value);
}
async function cacheDel(scope, key) {
  if (useRedis && redisClient) {
    try { await redisClient.del(`${scope}:${key}`); } catch (e) { /* ignore */ }
  }
  if (localCache[scope]) localCache[scope].del(key);
}
async function cacheClear(scope) {
  if (useRedis && redisClient) {
    try {
      // omit pattern deletion for safety
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

// Build model pools
const chatPool = [];
const taskPool = [];
const titlePool = [];

for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
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

if (chatPool.length === 0 || taskPool.length === 0 || titlePool.length === 0) {
  console.warn('Model pools may be incomplete. Some features might fail. Check API keys and model availability.');
}

// helpers
function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function withTimeout(promise, ms = CONFIG.TIMEOUT_MS, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

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
      console.warn(`[${new Date().toISOString()}] ${label} call failed for key idx=${idx} (${inst.key}):`, err && err.message ? err.message : err);
      // try next
    }
  }
  throw lastErr || new Error(`${label} failed with no specific error`);
}

async function retry(fn, attempts = CONFIG.MAX_RETRIES, initialDelay = 400) {
  let lastErr;
  let delay = initialDelay;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
      delay = Math.round(delay * 1.8);
    }
  }
  throw lastErr;
}

// extract helper — robust across various response shapes
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
  try { return JSON.parse(candidate); } catch (e) {
    const cleaned = candidate.replace(/[\u0000-\u001F]+/g, '');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

// language detection (keeps original heuristic)
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
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${(text || '').replace(/"/g, '\\"')}"`;
    const res = await generateWithFailover(titlePool, prompt, 'language detection', 5000);
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
    console.error(`[${new Date().toISOString()}] Failed to write notification for ${userId}:`, err && err.message ? err.message : err);
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
  } catch (e) { /* ignore */ }
}

// --- Tasks formatting ---
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

// --- Business logic (with stricter prompt rules) ---
const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);
const VALID_STATUS = new Set(['pending', 'completed']);

async function handleUpdateTasks({ userId, userRequest }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');
  console.log(`[${new Date().toISOString()}] 🔧 handleUpdateTasks for user=${userId}`);

  const progressDocSnap = await db.collection('userProgress').doc(userId).get();
  const currentTasks = progressDocSnap.exists ? (progressDocSnap.data().dailyTasks?.tasks || []) : [];

  const modificationPrompt = `
You are an intelligent and conservative task manager. Modify the provided user's task list based ONLY on the user's explicit instructions.
RESPOND EXACTLY with a JSON object: { "tasks": [ ... ] } and NOTHING else.

CURRENT TASKS:
${JSON.stringify(currentTasks)}

USER REQUEST (raw):
"${escapeForPrompt(userRequest)}"

INSTRUCTIONS (CRITICAL — follow exactly):
1) The output MUST be a single valid JSON object with key "tasks" containing an array.
2) Each task object MUST have these properties: id, title (string), type (one of 'review','quiz','new_lesson','practice','study'), status (either 'pending' or 'completed'), relatedLessonId (string|null), relatedSubjectId (string|null).
3) **TYPE RULE:** If the user asks for a test/exam/quiz use 'quiz'. If asks for practice use 'practice'. If ambiguous, prefer 'review'.
4) **STATUS RULE:** Use 'completed' only when the user explicitly indicates they finished the task. Use 'pending' otherwise.
5) **DELETIONS:** If the user asks to delete a specific task by id/title, remove it. If the user asks to delete ALL tasks, return { "tasks": [] }.
6) Preserve tasks not mentioned by the user unless user explicitly asks to modify or delete them.
7) Titles should be short and in Arabic if the user's message is in Arabic; otherwise keep language consistent with the user's message.
8) Do NOT include any explanation, metadata, or extra fields — only the tasks array with the specified fields.
9) If uncertain, return the existing tasks unchanged (still inside the JSON object).

Output example:
{ "tasks": [ { "id": "123", "title": "مراجعة الوحدة 1", "type": "review", "status": "pending", "relatedLessonId": null, "relatedSubjectId": null } ] }
`.trim();

  try {
    const res = await retry(() => generateWithFailover(taskPool, modificationPrompt, 'task modification', CONFIG.TIMEOUT_MS), CONFIG.MAX_RETRIES, 500);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);

    if (!parsed || !Array.isArray(parsed.tasks)) {
      console.error(`[${new Date().toISOString()}] ❌ Task model returned invalid tasks for ${userId}. raw: ${rawText}`);
      throw new Error('Model returned invalid tasks array');
    }

    const normalized = parsed.tasks.map((t) => {
      const type = (t.type || '').toString().toLowerCase();
      const status = (t.status || '').toString().toLowerCase();
      return {
        id: t.id || (String(Date.now()) + Math.random().toString(36).slice(2, 9)),
        title: (t.title || 'مهمة جديدة').toString(),
        type: VALID_TASK_TYPES.has(type) ? type : 'review',
        status: VALID_STATUS.has(status) ? status : 'pending',
        relatedLessonId: t.relatedLessonId || null,
        relatedSubjectId: t.relatedSubjectId || null,
      };
    });

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    try { await cacheSet('progress', userId, Object.assign({}, progressDocSnap.exists ? progressDocSnap.data() : {}, { dailyTasks: { tasks: normalized } })); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${new Date().toISOString()}] ✅ Updated tasks for user=${userId}. New count: ${normalized.length}`);
    return normalized;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] handleUpdateTasks error for ${userId}:`, err && err.stack ? err.stack : err);
    throw err;
  }
}

async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID is required');
  console.log(`[${new Date().toISOString()}] 📅 handleGenerateDailyTasks for ${userId}`);

  try {
    const weaknesses = await fetchUserWeaknesses(userId);
    const weaknessesPrompt = weaknesses.length > 0
      ? `${weaknesses.map(w => `- Lesson ID: ${w.lessonId}, Subject: ${w.subjectId}, Mastery: ${w.masteryScore}%`).join('\n')}`
      : 'User has no specific weaknesses. Suggest relevant introductory tasks.';

    const taskPrompt = `
You are an expert academic planner. Generate a personalized daily study plan for the user.
Respond ONLY with a JSON object: { "tasks": [ ... ] }.

CONTEXT:
${weaknessesPrompt}

INSTRUCTIONS:
1) Produce 2-4 tasks suitable for a single study session.
2) Each task must have: id, title, type (one of 'review','quiz','new_lesson','practice','study'), status ('pending'), relatedLessonId, relatedSubjectId.
3) Titles should be short and in Arabic when appropriate.
4) Output only JSON.
`.trim();

    const res = await retry(() => generateWithFailover(taskPool, taskPrompt, 'task generation', CONFIG.TIMEOUT_MS), CONFIG.MAX_RETRIES, 500);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);

    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      console.warn(`[${new Date().toISOString()}] ⚠️ Model returned empty/invalid tasks for ${userId}. Using fallback.`);
      throw new Error('Model returned empty tasks');
    }

    const tasksToSave = parsed.tasks.slice(0, 5).map((task, i) => ({
      id: task.id || (String(Date.now() + i)),
      title: (task.title || 'مهمة تعليمية').toString(),
      type: VALID_TASK_TYPES.has((task.type || '').toString().toLowerCase()) ? (task.type || '').toString().toLowerCase() : 'review',
      status: 'pending',
      relatedLessonId: task.relatedLessonId || null,
      relatedSubjectId: task.relatedSubjectId || null,
    }));

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    try { await cacheSet('progress', userId, { dailyTasks: { tasks: tasksToSave } }); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${new Date().toISOString()}] ✅ Generated ${tasksToSave.length} tasks for ${userId}`);
    return { tasks: tasksToSave, source: 'AI', generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ handleGenerateDailyTasks (${userId}) failed:`, err && err.stack ? err.stack : err);
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
      console.log(`[${new Date().toISOString()}] ✅ Saved fallback task for ${userId}`);
      return { tasks: fallbackTasks, source: 'fallback', generatedAt: new Date().toISOString() };
    } catch (saveErr) {
      console.error(`[${new Date().toISOString()}] ⚠️ CRITICAL: Failed to save fallback task for ${userId}:`, saveErr && saveErr.stack ? saveErr.stack : saveErr);
      return { tasks: fallbackTasks, source: 'fallback_unsaved', generatedAt: new Date().toISOString() };
    }
  }
}

// --- parseUserAction: stricter, fewer false positives ---
async function parseUserAction(userRequest, currentTasks) {
  const prompt = `
Your job: classify the user's intent. Decide if the request is exactly one of: "manage_tasks", "generate_plan", or "none".
RETURN EXACTLY and ONLY a JSON object like: { "action": "manage_tasks", "userRequest": "…short summary…" }

IMPORTANT RULES:
- If the message is a greeting (hello, good morning), a casual chat, or a general question (how are you?, what's up?), return "none".
- If the message explicitly requests adding, creating, removing, deleting, updating, marking complete/incomplete, or otherwise modifying tasks, return "manage_tasks".
- If the message explicitly asks for a schedule, plan, or to generate a study plan (phrases like "plan my day", "what should I study today", "generate a plan"), return "generate_plan".
- Be conservative: when in doubt, return "none".
- Keep "userRequest" short and precise (one sentence) and in the user's original language if possible.

User message:
"${escapeForPrompt(userRequest)}"

Current tasks (for context):
${JSON.stringify(currentTasks || [])}
`.trim();

  try {
    const res = await retry(() => generateWithFailover(taskPool, prompt, 'action parser', 4000), 2, 200);
    const raw = await extractTextFromResult(res);
    const parsed = parseJSONFromText(raw);
    if (!parsed || !parsed.action) return { action: 'none', userRequest };
    const action = (parsed.action || 'none').toString().trim();
    if (!['manage_tasks', 'generate_plan', 'none'].includes(action)) return { action: 'none', userRequest };
    return { action, userRequest: parsed.userRequest || userRequest };
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Action parsing failed, defaulting to none:`, err && err.message ? err.message : err);
    return { action: 'none', userRequest };
  }
}

// --- backgroundProcessor (keeps previous behavior) ---
async function backgroundProcessor({ userId, userRequest, profile, progress, detectedLang }) {
  try {
    const currentTasks = (progress && progress.dailyTasks && Array.isArray(progress.dailyTasks.tasks)) ? progress.dailyTasks.tasks : [];
    const parse = await parseUserAction(userRequest, currentTasks);

    if (parse.action === 'manage_tasks') {
      let updatedTasks;
      try {
        updatedTasks = await handleUpdateTasks({ userId, userRequest: parse.userRequest });
      } catch (err) {
        const failMsg = detectedLang === 'English' ? `⚠️ Failed to update tasks: ${err.message}` : detectedLang === 'French' ? `⚠️ Échec de la mise à jour des tâches: ${err.message}` : `⚠️ فشل تحديث المهام: ${err.message}`;
        await sendUserNotification(userId, { message: failMsg, lang: detectedLang });
        return;
      }
      const humanSummary = formatTasksHuman(updatedTasks, detectedLang === 'Arabic' ? 'Arabic' : (detectedLang === 'French' ? 'French' : 'English'));
      const followPrompt = `
You are EduAI, a warm study companion. Summarize the updated tasks concisely and warmly in ${detectedLang}.
Do NOT output JSON — only a short human-friendly message (max 60 words).

Tasks:
${humanSummary}
`.trim();
      try {
        const followRes = await retry(() => generateWithFailover(chatPool, followPrompt, 'chat followup', CONFIG.TIMEOUT_MS), 2, 200);
        const followText = await extractTextFromResult(followRes);
        await sendUserNotification(userId, { message: followText || (detectedLang === 'Arabic' ? '✅ تم تحديث مهامك.' : detectedLang === 'French' ? '✅ Tâches mises à jour.' : '✅ Tasks updated.'), lang: detectedLang });
      } catch (err) {
        const simple = detectedLang === 'Arabic' ? `✅ تم تحديث مهامك.\n${humanSummary}` : detectedLang === 'French' ? `✅ Tâches mises à jour.\n${humanSummary}` : `✅ Tasks updated.\n${humanSummary}`;
        await sendUserNotification(userId, { message: simple, lang: detectedLang });
      }
      return;
    }

    if (parse.action === 'generate_plan') {
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
        const followRes = await retry(() => generateWithFailover(chatPool, followPrompt, 'chat followup', CONFIG.TIMEOUT_MS), 2, 200);
        const followText = await extractTextFromResult(followRes);
        await sendUserNotification(userId, { message: followText || (detectedLang === 'Arabic' ? '✅ تم إنشاء خطة اليوم.' : detectedLang === 'French' ? '✅ Plan créé.' : '✅ Plan created.'), lang: detectedLang });
      } catch (err) {
        const simple = detectedLang === 'Arabic' ? `✅ تم إنشاء خطة اليوم.\n${humanSummary}` : detectedLang === 'French' ? `✅ Plan créé.\n${humanSummary}` : `✅ Plan created.\n${humanSummary}`;
        await sendUserNotification(userId, { message: simple, lang: detectedLang });
      }
      return;
    }

    // action none -> do nothing
    return;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] backgroundProcessor error for ${userId}:`, err && err.stack ? err.stack : err);
    try { await sendUserNotification(userId, { message: detectedLang === 'Arabic' ? '⚠️ حدث خطأ غير متوقع أثناء معالجة طلبك.' : detectedLang === 'French' ? '⚠️ Une erreur est survenue.' : '⚠️ An unexpected error occurred.' , lang: detectedLang }); } catch (e) {}
  }
}

// ----------------- ROUTES -----------------

/**
 * /chat
 * - Returns immediate ack and processes in background.
 */
app.post('/chat', async (req, res) => {
  const start = Date.now();
  try {
    const { userId, message, history = [] } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request. userId and message are required.' });

    const [profile, progress, detectedLang] = await Promise.all([getProfile(userId), getProgress(userId), detectLanguage(message)]);

    const ackPrompt = `
You are EduAI, a warm and empathetic study companion. Provide a SHORT (max 25 words) acknowledgement in ${detectedLang} indicating you will process the request and notify when finished. Do NOT perform the task here.
User message: "${escapeForPrompt(safeSnippet(message, 300))}"
`.trim();

    let ackText = detectedLang === 'Arabic' ? 'جاري العمل على طلبك الآن — سأخبرك عند الانتهاء.' : detectedLang === 'French' ? "Je m'occupe de votre demande — je vous informerai dès que c'est prêt." : 'Working on your request — I will notify you when done.';
    try {
      if (chatPool.length > 0) {
        const ackRes = await retry(() => generateWithFailover(chatPool, ackPrompt, 'chat ack', Math.round(CONFIG.TIMEOUT_MS * 0.7)), 2, 200);
        const t = await extractTextFromResult(ackRes);
        if (t && t.trim()) ackText = t.trim();
      } else {
        req.log('No chatPool available; using default ack text.');
      }
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] ack generation failed, using fallback ack text for user=${userId}:`, e && e.message ? e.message : e);
    }

    // send ACK immediately
    res.json({ reply: ackText });
    // Launch background processing (non-blocking)
    setImmediate(() => {
      backgroundProcessor({ userId, userRequest: message, profile, progress, detectedLang })
        .catch(err => console.error(`[${new Date().toISOString()}] backgroundProcessor top-level error for ${userId}:`, err && err.stack ? err.stack : err));
    });

    return;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ /chat error:`, err && err.stack ? err.stack : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) return res.status(504).json({ error: 'Model request timed out.' });
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * /update-daily-tasks
 */
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });
    const updated = await handleUpdateTasks({ userId, userRequest });
    return res.status(200).json({ success: true, tasks: updated, generatedAt: new Date().toISOString(), source: 'AI' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Error in /update-daily-tasks:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to update daily tasks.' });
  }
});

/**
 * /generate-daily-tasks
 */
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const result = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, generatedAt: result.generatedAt || new Date().toISOString(), source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Error in /generate-daily-tasks:`, err && err.stack ? err.stack : err);
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
    if (titlePool.length === 0) {
      console.warn('Title pool empty — returning fallback title.');
      return res.status(200).json({ title: 'محادثة جديدة' });
    }
    const modelRes = await retry(() => generateWithFailover(titlePool, prompt, 'title generation', 5000), 2, 200);
    let titleText = await extractTextFromResult(modelRes);
    if (!titleText) { console.warn(`[${new Date().toISOString()}] ⚠️ Title model returned empty. Using fallback.`); titleText = 'محادثة جديدة'; }
    return res.status(200).json({ title: titleText.trim() });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Title generation failed:`, err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'محادثة جديدة' });
  }
});

/**
 * /metrics
 */
const metrics = { requests: 0, errors: 0, avgLatencyMs: 0, sampleCount: 0 };
app.get('/metrics', (req, res) => {
  res.json(metrics);
});

/**
 * /health
 */
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development', metrics, time: new Date().toISOString() });
});

// --- Graceful shutdown ---
let server = null;
function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      console.log(`[${new Date().toISOString()}] HTTP server closed.`);
      if (redisClient) {
        try { await redisClient.quit(); } catch (e) { /* ignore */ }
      }
      process.exit(0);
    });
    setTimeout(() => { console.warn(`[${new Date().toISOString()}] Forcing shutdown.`); process.exit(1); }, CONFIG.SHUTDOWN_TIMEOUT).unref();
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
