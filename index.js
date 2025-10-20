'use strict';

/**
 * EduAI Brain — V14 Multi-Model Async (Integrated, Ambiguity-Guard + Intent-aware Notifications)
 *
 * This is the full server.js integrating:
 * - quickAmbiguityCheck used at /chat to block ambiguous inputs and return clarify:true
 * - parseUserAction returns details.intent and details.forceStatus (create/complete/delete/update/plan)
 * - backgroundProcessor consumes parse result, passes details to handleUpdateTasks
 * - tailored immediate notification messages based on intent (complete/delete/create/other)
 * - robust prompts: strict JSON-only outputs, exact fields, conservative parsing
 *
 * NOTE: keep environment variables configured and secrets safe (FIREBASE_SERVICE_ACCOUNT_KEY,
 * GOOGLE_API_KEY_*, etc.). The file is defensive and uses retry/failover for model calls.
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// ---------- CONFIG ----------
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  CHAT_MODEL_NAME: process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash',
  TASK_MODEL_NAME: process.env.TASK_MODEL_NAME || 'gemini-2.5-pro',
  TITLE_MODEL_NAME: process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite',
  TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 45000),
  TIMEOUT_CHAT_MS: Number(process.env.TIMEOUT_CHAT_MS || 60000),
  TIMEOUT_TASK_MS: Number(process.env.TIMEOUT_TASK_MS || 45000),
  TIMEOUT_ACTION_MS: Number(process.env.TIMEOUT_ACTION_MS || 15000),
  TIMEOUT_TITLE_MS: Number(process.env.TIMEOUT_TITLE_MS || 10000),
  CACHE_TTL: Number(process.env.CACHE_TTL_MS || 30 * 1000),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 4),
  BODY_LIMIT: process.env.BODY_LIMIT || '300kb',
  SHUTDOWN_TIMEOUT: Number(process.env.SHUTDOWN_TIMEOUT || 15000),
  REDIS_URL: process.env.REDIS_URL || null,
};

// ---------- Preconditions ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
  process.exit(1);
}

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: CONFIG.BODY_LIMIT }));

// request tracing
app.use((req, res, next) => {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  req.log = (...args) => console.log(`[${new Date().toISOString()}] [req:${reqId}]`, ...args);
  next();
});

// ---------- Simple LRU cache (fallback) ----------
let redisClient = null;
let useRedis = false;
if (process.env.REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    redisClient = new IORedis(process.env.REDIS_URL);
    useRedis = true;
    console.log(`[${new Date().toISOString()}] Redis enabled.`);
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] Redis init failed — using in-memory cache.`);
  }
}

class LRUCache {
  constructor(limit = 500, ttl = CONFIG.CACHE_TTL) { this.limit = limit; this.ttl = ttl; this.map = new Map(); }
  _isExpired(e) { return Date.now() - e.t > this.ttl; }
  get(k) { const e = this.map.get(k); if (!e) return null; if (this._isExpired(e)) { this.map.delete(k); return null; } this.map.delete(k); this.map.set(k, e); return e.v; }
  set(k, v) { if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value); this.map.set(k, { v, t: Date.now() }); }
  del(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const localCache = { profile: new LRUCache(500), progress: new LRUCache(500) };

async function cacheGet(scope, key) {
  if (useRedis && redisClient) {
    try { const v = await redisClient.get(`${scope}:${key}`); return v ? JSON.parse(v) : null; } catch (e) { /* ignore */ }
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

// ---------- Firebase Admin init ----------
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
  console.log(`[${new Date().toISOString()}] Firebase Admin initialized.`);
} catch (err) {
  console.error(`[${new Date().toISOString()}] Firebase init failed:`, err && err.message ? err.message : err);
  process.exit(1);
}

// ---------- Model pools ----------
const apiKeyCandidates = [];
for (let i = 1; i <= 4; i++) { const k = process.env[`GOOGLE_API_KEY_${i}`]; if (k && k.trim()) apiKeyCandidates.push(k.trim()); }
if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
if (apiKeyCandidates.length === 0) { console.error('No GOOGLE_API_KEY provided. Exiting.'); process.exit(1); }

const chatPool = [], taskPool = [], titlePool = [];
for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
    try { chatPool.push({ client, model: client.getGenerativeModel({ model: CONFIG.CHAT_MODEL_NAME }), key }); } catch (e) { }
    try { taskPool.push({ client, model: client.getGenerativeModel({ model: CONFIG.TASK_MODEL_NAME }), key }); } catch (e) { }
    try { titlePool.push({ client, model: client.getGenerativeModel({ model: CONFIG.TITLE_MODEL_NAME }), key }); } catch (e) { }
  } catch (e) {
    console.warn('A Google key failed to initialize — skipping it.');
  }
}
console.log(`[${new Date().toISOString()}] Model pools sizes — chat:${chatPool.length}, task:${taskPool.length}, title:${titlePool.length}`);

// ---------- Utilities ----------
function shuffledIndices(n) { const a = Array.from({ length: n }, (_, i) => i); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function withTimeout(promise, ms = CONFIG.TIMEOUT_MS, label = 'operation') {
  return Promise.race([ promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)) ]);
}
async function retry(fn, attempts = CONFIG.MAX_RETRIES, delay = 500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) { last = err; if (i < attempts - 1) await new Promise(r => setTimeout(r, delay)); delay = Math.round(delay * 1.8); }
  }
  throw last;
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
      console.warn(`[${new Date().toISOString()}] ${label} failed for keyIdx=${idx} key=${inst.key}:`, err && err.message ? err.message : err);
    }
  }
  throw lastErr || new Error(`${label} failed`);
}
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    const resp = result.response ? await result.response : result;
    if (!resp) return '';
    if (resp && typeof resp.text === 'function') { const t = await resp.text(); return (t || '').toString().trim(); }
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
  let c = match[0].replace(/```(?:json)?/g, '').trim().replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(c); } catch (e) { try { const cleaned = c.replace(/[\u0000-\u001F]+/g, ''); return JSON.parse(cleaned); } catch (e2) { return null; } }
}

// ---------- Language & Text helpers ----------
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

// ---------- Firestore helpers ----------
async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = doc.exists && doc.data()?.profileSummary ? String(doc.data().profileSummary) : 'No available memory.';
    await cacheSet('profile', userId, val);
    return val;
  } catch (err) {
    console.error('getProfile error:', err && err.message ? err.message : err);
    return 'No available memory.';
  }
}
async function getProgress(userId) {
  try {
    const cached = await cacheGet('progress', userId);
    if (cached) return cached;
    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) { const val = doc.data() || {}; await cacheSet('progress', userId, val); return val; }
  } catch (err) { console.error('getProgress error:', err && err.message ? err.message : err); }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
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
          if (!Number.isNaN(masteryScore) && masteryScore < 75) weaknesses.push({ lessonId, subjectId, masteryScore, suggestedReview: lessonData.suggestedReview || 'Review needed' });
        }
      }
    }
    return weaknesses;
  } catch (err) { console.error('fetchUserWeaknesses error:', err && err.message ? err.message : err); return []; }
}
async function sendUserNotification(userId, payload) {
  try {
    const notifRef = db.collection('userNotifications').doc(userId).collection('inbox');
    await notifRef.add({ message: payload.message, meta: payload.meta || {}, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp(), lang: payload.lang || 'Arabic' });
  } catch (err) {
    console.error('sendUserNotification write failed:', err && err.message ? err.message : err);
  }
  // optional FCM
  try {
    const profileDoc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const token = profileDoc.exists ? profileDoc.data()?.fcmToken : null;
    if (token) {
      const message = { token, notification: { title: payload.title || 'EduAI', body: payload.message }, data: payload.data || {} };
      try { await admin.messaging().send(message); } catch (e) { /* ignore FCM errors */ }
    }
  } catch (e) { /* ignore */ }
}

// ---------- Task helpers ----------
function formatTasksHuman(tasks, lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  if (lang === 'English' || lang === 'French') return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

// ---------- Normalization / Synonyms ----------
function normalizeArabic(text) {
  if (!text) return '';
  let t = text.normalize('NFC').replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, '');
  t = t.replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ـ+/g, '');
  return t.toLowerCase().trim();
}
const SYNONYMS = {
  create: ['اضف', 'أضف', 'انشئ', 'أنشئ', 'اضافة', 'أضفلي', 'أضف لي', 'إنشئ', 'أنشئ'],
  complete: ['انجز', 'أنجز', 'انتهى', 'انتهيت', 'أكملت', 'تم', 'أنجزت', 'أتممت', 'انتهت'],
  delete: ['حذف', 'امسح', 'أزل', 'ازل', 'امسحلي', 'امسح لي', 'امسح المهمة', 'أحذف'],
  update: ['عدل', 'عدّل', 'تعديل', 'غيّر', 'غير', 'حدّث', 'حدث'],
  plan: ['خطة', 'خطط', 'رتب', 'ضع خطة', 'خطتي', 'plan', 'خطه', 'خطة اليوم'],
};
function includesAnyToken(norm, arr) { return arr.some(k => norm.includes(k)); }

// ---------- quickAmbiguityCheck ----------
function quickAmbiguityCheck(rawMessage, detectedLang = 'Arabic') {
  if (!rawMessage || typeof rawMessage !== 'string') return null;
  const norm = normalizeArabic(rawMessage);

  const praiseTokens = ['رائع', 'مذهل', 'جميل', 'ممتاز', 'عظيم', 'حلو', 'مبهر', 'شكرا', 'شكرًا'];
  const pastTokens = ['امس', 'بالأمس', 'البارحة', 'مبارح', 'في الامس', 'في الأمس'];
  const explicitTaskTokens = [...SYNONYMS.create, ...SYNONYMS.complete, ...SYNONYMS.delete, ...SYNONYMS.update, ...SYNONYMS.plan];

  const hasPraise = praiseTokens.some(t => norm.includes(t));
  const hasPast = pastTokens.some(t => norm.includes(t));
  const hasTaskVerb = explicitTaskTokens.some(t => norm.includes(t));

  if ((hasPraise || hasPast) && !hasTaskVerb) {
    if (detectedLang === 'English') return "Thanks — would you like me to repeat the same plan for today, or were you just sharing feedback?";
    if (detectedLang === 'French') return "Merci — voulez-vous que je répète le même plan pour aujourd'hui, ou partagiez-vous فقط ملاحظة؟";
    return "رائع — هل تريد أن أعيد نفس الخطة لليوم أم أنك تشارك ملاحظة فقط؟";
  }
  return null;
}

// ---------- parseUserAction (heuristic then small-model fallback) ----------
async function parseUserAction(userRequest, currentTasks) {
  if (!userRequest || typeof userRequest !== 'string' || userRequest.trim() === '') return { action: 'none', userRequest: '', details: {} };
  const raw = userRequest;
  const norm = normalizeArabic(raw);

  const wantsCreate = includesAnyToken(norm, SYNONYMS.create);
  const wantsComplete = includesAnyToken(norm, SYNONYMS.complete);
  const wantsDelete = includesAnyToken(norm, SYNONYMS.delete);
  const wantsUpdate = includesAnyToken(norm, SYNONYMS.update);
  const wantsPlan = includesAnyToken(norm, SYNONYMS.plan);

  const details = {};
  if (wantsComplete) { details.intent = 'complete'; details.forceStatus = 'completed'; }
  if (wantsDelete) details.intent = 'delete';
  if (wantsCreate) details.intent = 'create';
  if (wantsUpdate) details.intent = 'update';

  if (wantsDelete || wantsComplete || wantsCreate || wantsUpdate) return { action: 'manage_tasks', userRequest: raw, details };
  if (wantsPlan) return { action: 'generate_plan', userRequest: raw, details: {} };

  // greetings detection
  const greetings = ['hello','hi','hey','مرحبا','صباح','مساء','سلام','كيف حالك','what\'s up','bonjour'];
  if (greetings.some(g => norm.includes(g))) return { action: 'none', userRequest: raw, details: {} };

  // fallback to small model (titlePool preferred)
  const fallbackPool = (Array.isArray(titlePool) && titlePool.length > 0) ? titlePool : taskPool;
  if (!fallbackPool || fallbackPool.length === 0) return { action: 'none', userRequest: raw, details: {} };

  const prompt = `
You are a conservative classifier. Decide if the user's message should trigger exactly one of:
"manage_tasks", "generate_plan", or "none".
Return EXACTLY and ONLY a JSON object like:
{ "action": "manage_tasks", "userRequest": "short summary", "details": { "intent": "create|complete|delete|update|null", "forceStatus": "completed|null" } }

RULES (follow strictly):
- If message is greeting, thanks, or feedback only -> "none".
- If it explicitly asks to add/remove/complete/update tasks -> "manage_tasks".
- If it asks for a plan or to plan the day -> "generate_plan".
- Be conservative: when in doubt return "none".
User message: "${escapeForPrompt(safeSnippet(userRequest, 500))}"
Current tasks: ${JSON.stringify(currentTasks || [])}
`.trim();

  try {
    const res = await retry(() => generateWithFailover(fallbackPool, prompt, 'action parser', CONFIG.TIMEOUT_ACTION_MS), 2, 300);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !parsed.action) return { action: 'none', userRequest: raw, details: {} };
    const action = parsed.action;
    if (!['manage_tasks','generate_plan','none'].includes(action)) return { action: 'none', userRequest: raw, details: {} };
    return { action, userRequest: parsed.userRequest || raw, details: parsed.details || {} };
  } catch (err) {
    console.warn('parseUserAction fallback failed — defaulting to none:', err && err.message ? err.message : err);
    return { action: 'none', userRequest: raw, details: {} };
  }
}

// ---------- handleUpdateTasks (strict prompt) ----------
const VALID_TASK_TYPES = new Set(['review','quiz','new_lesson','practice','study']);
const VALID_STATUS = new Set(['pending','completed']);

async function handleUpdateTasks({ userId, userRequest, details = {} }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');
  console.log(`[${new Date().toISOString()}] handleUpdateTasks user=${userId} details=${JSON.stringify(details)}`);

  const progressSnap = await db.collection('userProgress').doc(userId).get();
  const currentTasks = progressSnap.exists ? (progressSnap.data().dailyTasks?.tasks || []) : [];

  const modificationPrompt = `
You are a conservative task manager. Modify the user's task list BASED ONLY on the explicit instructions.
RETURN EXACTLY one JSON object and NOTHING ELSE:
{ "tasks": [ { "id": "...", "title": "...", "type": "...", "status": "...", "relatedLessonId": null|"id", "relatedSubjectId": null|"id" } ] }

CURRENT TASKS:
${JSON.stringify(currentTasks)}

USER REQUEST (raw):
"${escapeForPrompt(userRequest)}"

REQUIREMENTS (MUST follow):
1) Output MUST be a single JSON object with key "tasks".
2) Each task MUST include: id, title (string), type (one of 'review','quiz','new_lesson','practice','study'), status ('pending'|'completed'), relatedLessonId (string|null), relatedSubjectId (string|null).
3) TYPE RULE: 'quiz' for tests/quizzes, 'practice' for practice requests, ambiguous -> 'review'.
4) STATUS RULE: use 'completed' only when user explicitly indicates completion or if details.forceStatus === 'completed'.
5) DELETION: if user asked to delete a task by id/title, remove it. If asked to delete ALL, return { "tasks": [] }.
6) Preserve tasks not explicitly mentioned.
7) Titles short and in user's language.
8) DO NOT include extra fields or explanation.
9) If uncertain, return existing tasks unchanged.
`.trim();

  try {
    const res = await retry(() => generateWithFailover(taskPool, modificationPrompt, 'task modification', CONFIG.TIMEOUT_TASK_MS), CONFIG.MAX_RETRIES, 700);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('Model returned invalid tasks array');

    const normalized = parsed.tasks.map(t => {
      const type = (t.type || '').toString().toLowerCase();
      let status = (t.status || '').toString().toLowerCase();
      if (details && details.forceStatus) status = details.forceStatus;
      return {
        id: t.id || (String(Date.now()) + Math.random().toString(36).slice(2, 9)),
        title: (t.title || 'مهمة جديدة').toString(),
        type: VALID_TASK_TYPES.has(type) ? type : 'review',
        status: VALID_STATUS.has(status) ? status : 'pending',
        relatedLessonId: t.relatedLessonId || null,
        relatedSubjectId: t.relatedSubjectId || null,
      };
    });

    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    try { await cacheSet('progress', userId, Object.assign({}, progressSnap.exists ? progressSnap.data() : {}, { dailyTasks: { tasks: normalized } })); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${new Date().toISOString()}] Updated tasks saved for user=${userId}`);
    return normalized;
  } catch (err) {
    console.error('handleUpdateTasks failed:', err && err.message ? err.message : err);
    throw err;
  }
}

// ---------- handleGenerateDailyTasks ----------
async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID required');
  console.log(`[${new Date().toISOString()}] handleGenerateDailyTasks user=${userId}`);

  try {
    const weaknesses = await fetchUserWeaknesses(userId);
    const ctx = weaknesses.length > 0 ? `${weaknesses.map(w => `- ${w.lessonId} (${w.masteryScore}%)`).join('\n')}` : 'No specific weaknesses detected.';
    const taskPrompt = `
You are an academic planner. Generate 2-4 personalized tasks for a single study session.
RETURN EXACTLY one JSON object: { "tasks": [ ... ] } with same task schema as above.
Context:
${ctx}
`.trim();

    const res = await retry(() => generateWithFailover(taskPool, taskPrompt, 'task generation', CONFIG.TIMEOUT_TASK_MS), CONFIG.MAX_RETRIES, 700);
    const rawText = await extractTextFromResult(res);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) throw new Error('Model returned empty tasks');

    const tasksToSave = parsed.tasks.slice(0, 5).map((task, i) => ({
      id: task.id || (String(Date.now() + i)),
      title: (task.title || 'مهمة تعليمية').toString(),
      type: VALID_TASK_TYPES.has((task.type || '').toString().toLowerCase()) ? (task.type || '').toString().toLowerCase() : 'review',
      status: 'pending',
      relatedLessonId: task.relatedLessonId || null,
      relatedSubjectId: task.relatedSubjectId || null,
    }));

    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    try { await cacheSet('progress', userId, { dailyTasks: { tasks: tasksToSave } }); } catch (e) {}
    await cacheDel('progress', userId);

    console.log(`[${new Date().toISOString()}] Generated tasks for user=${userId}`);
    return { tasks: tasksToSave, source: 'AI', generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error('handleGenerateDailyTasks failed:', err && err.message ? err.message : err);
    const fallback = [{ id: String(Date.now()), title: 'مراجعة درس مهم', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    try {
      await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
      await cacheSet('progress', userId, { dailyTasks: { tasks: fallback } }).catch(()=>{});
      await cacheDel('progress', userId);
      return { tasks: fallback, source: 'fallback', generatedAt: new Date().toISOString() };
    } catch (e) { return { tasks: fallback, source: 'fallback_unsaved', generatedAt: new Date().toISOString() }; }
  }
}

// ---------- backgroundProcessor (uses parse result and intent-aware notifications) ----------
async function backgroundProcessor({ userId, userRequest, profile, progress, detectedLang }) {
  try {
    const currentTasks = (progress && progress.dailyTasks && Array.isArray(progress.dailyTasks.tasks)) ? progress.dailyTasks.tasks : [];
    const parseResult = await parseUserAction(userRequest, currentTasks);

    if (parseResult.action === 'manage_tasks') {
      let updatedTasks;
      try {
        updatedTasks = await handleUpdateTasks({ userId, userRequest: parseResult.userRequest, details: parseResult.details });
      } catch (err) {
        const failMsg = detectedLang === 'Arabic' ? `⚠️ فشل تحديث المهام: ${err.message}` : detectedLang === 'French' ? `⚠️ Échec mise à jour: ${err.message}` : `⚠️ Failed to update tasks: ${err.message}`;
        await sendUserNotification(userId, { message: failMsg, lang: detectedLang });
        return;
      }

      // Intent-aware quick notification
      const intent = parseResult.details?.intent || null;
      const forced = parseResult.details?.forceStatus === 'completed';
      let notificationMessage;
      if (intent === 'complete' || forced) {
        notificationMessage = detectedLang === 'Arabic' ? '🎉 رائع! لقد تم تسجيل إنجاز المهمة.' : detectedLang === 'French' ? '🎉 Super ! La tâche a été marquée comme terminée.' : '🎉 Great! Task marked as completed.';
      } else if (intent === 'delete') {
        notificationMessage = detectedLang === 'Arabic' ? '🗑️ تم حذف المهمة كما طلبت.' : detectedLang === 'French' ? '🗑️ Tâche supprimée.' : '🗑️ Task deleted.';
      } else if (intent === 'create') {
        notificationMessage = detectedLang === 'Arabic' ? '✅ تم إضافة المهمة إلى قائمتك.' : detectedLang === 'French' ? '✅ Tâche ajoutée à votre liste.' : '✅ Task added to your list.';
      } else {
        notificationMessage = detectedLang === 'Arabic' ? '✅ تم تحديث قائمة مهامك.' : detectedLang === 'French' ? '✅ Votre liste de tâches a été mise à jour.' : '✅ Your tasks have been updated.';
      }

      // Send quick notification
      await sendUserNotification(userId, { message: notificationMessage, lang: detectedLang });

      // Then attempt a friendly human follow-up using chat model (optional; non-blocking variant)
      try {
        const humanSummary = formatTasksHuman(updatedTasks, detectedLang === 'Arabic' ? 'Arabic' : (detectedLang === 'French' ? 'French' : 'English'));
        const followPrompt = `
You are EduAI, a warm study companion. Compose a concise friendly follow-up in ${detectedLang} (max 40 words) that:
- Confirms the operation (use a positive tone).
- Shows a short bulleted summary (2-4 items) of the updated tasks.
Return ONLY plain text (no JSON).
Updated tasks:
${humanSummary}
`.trim();
        const followRes = await retry(() => generateWithFailover(chatPool, followPrompt, 'followup', CONFIG.TIMEOUT_CHAT_MS), CONFIG.MAX_RETRIES, 700);
        const followText = await extractTextFromResult(followRes);
        if (followText && followText.trim()) {
          await sendUserNotification(userId, { message: followText.trim(), lang: detectedLang });
        } else {
          // already sent quick notification; nothing more
        }
      } catch (e) {
        // ignore follow-up failures (we already sent quick notification)
        console.warn('follow-up generation failed:', e && e.message ? e.message : e);
      }

      return;
    }

    if (parseResult.action === 'generate_plan') {
      let result;
      try {
        result = await handleGenerateDailyTasks(userId);
      } catch (err) {
        const failMsg = detectedLang === 'Arabic' ? `⚠️ فشل إنشاء الخطة: ${err.message}` : detectedLang === 'French' ? `⚠️ Échec génération: ${err.message}` : `⚠️ Failed to generate plan: ${err.message}`;
        await sendUserNotification(userId, { message: failMsg, lang: detectedLang });
        return;
      }
      const humanSummary = formatTasksHuman(result.tasks, detectedLang === 'Arabic' ? 'Arabic' : (detectedLang === 'French' ? 'French' : 'English'));
      const notify = detectedLang === 'Arabic' ? '✅ تم إنشاء خطة اليوم.' : detectedLang === 'French' ? '✅ Plan du jour créé.' : '✅ Today\'s plan created.';
      await sendUserNotification(userId, { message: `${notify}\n${humanSummary}`, lang: detectedLang });
      return;
    }

    // action none: nothing to do
    return;
  } catch (err) {
    console.error('[backgroundProcessor] unexpected error:', err && err.stack ? err.stack : err);
    try { await sendUserNotification(userId, { message: detectedLang === 'Arabic' ? '⚠️ حدث خطأ أثناء معالجة طلبك.' : '⚠️ An error occurred processing your request.', lang: detectedLang }); } catch (e) {}
  }
}

// ----------------- ROUTES -----------------

/**
 * POST /chat
 *  - Run ambiguity guard (quickAmbiguityCheck). If ambiguous -> return clarify:true and NO background processing.
 *  - Otherwise return an immediate ACK and launch backgroundProcessor asynchronously.
 */
app.post('/chat', async (req, res) => {
  const start = Date.now();
  try {
    const { userId, message, history = [] } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request. userId and message required.' });

    // gather profile/progress/detectedLang in parallel
    const [profile, progress, detectedLang] = await Promise.all([
      getProfile(userId),
      getProgress(userId),
      (async () => detectLangLocal(message))()
    ]);

    // --- Ambiguity guard: if ambiguous, return clarification question and DO NOT run backgroundProcessor
    const ambiguityQuestion = quickAmbiguityCheck(message, detectedLang);
    if (ambiguityQuestion) {
      req.log(`Ambiguity detected for user=${userId}. Asking clarification.`);
      return res.json({ reply: ambiguityQuestion, clarify: true });
    }

    // Not ambiguous: produce ACK (prefer generated ack)
    const ackPrompt = `
You are EduAI. Write a SHORT acknowledgement (<= 25 words) in ${detectedLang} telling the user: "I received your request and will process it; you'll get a notification when it's done."
Do NOT perform the task here.
User message: "${escapeForPrompt(safeSnippet(message, 300))}"
`.trim();

    let ackText = detectedLang === 'Arabic' ? 'جاري العمل على طلبك الآن — سأخبرك عند الانتهاء.' : detectedLang === 'French' ? "Je m'occupe de votre demande — je vous informerai dès que c'est prêt." : 'Working on your request — I will notify you when done.';
    try {
      if (chatPool.length > 0) {
        const ackRes = await retry(() => generateWithFailover(chatPool, ackPrompt, 'ack', Math.round(CONFIG.TIMEOUT_CHAT_MS * 0.6)), 2, 200);
        const t = await extractTextFromResult(ackRes);
        if (t && t.trim()) ackText = t.trim();
      }
    } catch (e) {
      console.warn('ack generation failed, using fallback ackText.');
    }

    // send ACK
    res.json({ reply: ackText });

    // launch background processing non-blocking
    setImmediate(() => {
      backgroundProcessor({ userId, userRequest: message, profile, progress, detectedLang })
        .catch(err => console.error('backgroundProcessor top-level error:', err && err.stack ? err.stack : err));
    });

    console.log(`[${new Date().toISOString()}] /chat handled for user=${userId} in ${Date.now()-start}ms`);
    return;
  } catch (err) {
    console.error('/chat error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /update-daily-tasks
 */
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest, details = {} } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest required.' });
    const updated = await handleUpdateTasks({ userId, userRequest, details });
    return res.status(200).json({ success: true, tasks: updated, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('/update-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to update tasks.' });
  }
});

/**
 * POST /generate-daily-tasks
 */
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID required.' });
    const result = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, tasks: result.tasks, generatedAt: result.generatedAt });
  } catch (err) {
    console.error('/generate-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

/**
 * POST /generate-title
 */
app.post('/generate-title', async (req, res) => {
  try {
    const { message, language } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const lang = language || 'Arabic';
    if (titlePool.length === 0) return res.status(200).json({ title: 'محادثة جديدة' });

    const prompt = `Summarize into a short chat title in ${lang}. Return ONLY the title text. Message: "${escapeForPrompt(safeSnippet(message, 1000))}"`;
    const modelRes = await retry(() => generateWithFailover(titlePool, prompt, 'title', CONFIG.TIMEOUT_TITLE_MS), 2, 300);
    let titleText = await extractTextFromResult(modelRes);
    if (!titleText) titleText = 'محادثة جديدة';
    return res.status(200).json({ title: titleText.trim() });
  } catch (err) {
    console.error('/generate-title error:', err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'محادثة جديدة' });
  }
}

/** /health & /metrics */
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/metrics', (req, res) => res.json({ msg: 'metrics placeholder' }));

// ---------- Graceful shutdown ----------
let server = null;
function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] Received ${signal}. Shutting down...`);
  if (server) {
    server.close(async () => {
      if (redisClient) try { await redisClient.quit(); } catch (e) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), CONFIG.SHUTDOWN_TIMEOUT).unref();
  } else process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r, p) => console.error('UnhandledRejection', r, p));

// start
server = app.listen(CONFIG.PORT, () => {
  console.log(`[${new Date().toISOString()}] EduAI Brain running on port ${CONFIG.PORT}`);
  console.log(`Pools: chat=${chatPool.length} task=${taskPool.length} title=${titlePool.length}`);
});

module.exports = { app, handleUpdateTasks, handleGenerateDailyTasks, parseUserAction };
