'use strict';

/**
 * EduAI Brain — V15.3 Ultra-Max Final
 * - Multi-model pools with automatic key rotation & backoff (supports GOOGLE_API_KEY_1..4 and GOOGLE_API_KEY)
 * - Model assignment:
 *     chat           -> gemini-2.5-flash
 *     todo/planner   -> gemini-2.5-pro
 *     title/notify   -> gemini-2.5-flash-lite
 *     review         -> gemini-2.5-pro
 * - Firestore-backed job queue & worker
 * - Robust JSON extraction & repair
 * - Optional Firebase Auth middleware (ENABLE_AUTH=true/false)
 * - Notifications saved to Firestore; optional FCM if configured
 *
 * Required env:
 *   FIREBASE_SERVICE_ACCOUNT_KEY  (raw JSON string OR base64-encoded)
 *   At least one of: GOOGLE_API_KEY or GOOGLE_API_KEY_1..4
 *
 * Optional env:
 *   ENABLE_AUTH (default "true")
 *   REDIS_URL (not used here by default)
 *   REVIEW_QUALITY_THRESHOLD (default 6)
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// ---------------- CONFIG ----------------
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),

  // Model mapping (per your last specification)
  MODEL: {
    chat: process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash',
    todo: process.env.TODO_MODEL_NAME || 'gemini-2.5-pro',
    planner: process.env.PLANNER_MODEL_NAME || 'gemini-2.5-pro',
    titleIntent: process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite',
    notification: process.env.NOTIFICATION_MODEL_NAME || 'gemini-2.5-flash-lite',
    review: process.env.REVIEW_MODEL_NAME || 'gemini-2.5-pro',
  },

  TIMEOUT: {
    default: Number(process.env.REQUEST_TIMEOUT_MS || 25000),
    chat: Number(process.env.TIMEOUT_CHAT_MS || 30000),
    notification: Number(process.env.TIMEOUT_NOTIFICATION_MS || 5000),
    review: Number(process.env.TIMEOUT_REVIEW_MS || 20000),
  },

  CACHE_TTL: Number(process.env.CACHE_TTL_MS || 30 * 1000),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
  JOB_WORKER_POLL_MS: Number(process.env.JOB_WORKER_POLL_MS || 3000),
  REVIEW_QUALITY_THRESHOLD: Number(process.env.REVIEW_QUALITY_THRESHOLD || 6),

  ENABLE_AUTH: (process.env.ENABLE_AUTH || 'true') === 'true',
};

// ---------------- ENV CHECKS ----------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var.');
  process.exit(1);
}
const apiKeyCandidates = [];
for (let i = 1; i <= 4; i++) {
  if (process.env[`GOOGLE_API_KEY_${i}`]) apiKeyCandidates.push(process.env[`GOOGLE_API_KEY_${i}`]);
}
if (process.env.GOOGLE_API_KEY) apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
if (apiKeyCandidates.length === 0) {
  console.error('No Google API key provided. Set GOOGLE_API_KEY or GOOGLE_API_KEY_1..4.');
  process.exit(1);
}

// ---------------- EXPRESS ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '400kb' }));

// request tracing
app.use((req, res, next) => {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  req.log = (...args) => console.log(new Date().toISOString(), `[req:${reqId}]`, ...args);
  next();
});

// ---------------- FIREBASE INIT ----------------
let db;
try {
  // Accept either base64 or plain JSON input
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e1) {
    try {
      // try base64
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } catch (e2) {
      try {
        // try replacing escaped newlines
        serviceAccount = JSON.parse(raw.replace(/\\n/g, '\n'));
      } catch (e3) {
        throw new Error('Could not parse FIREBASE_SERVICE_ACCOUNT_KEY');
      }
    }
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized.');
} catch (err) {
  console.error('❌ Firebase initialization failed:', err && err.message ? err.message : err);
  process.exit(1);
}

// ---------------- MODEL POOLS ----------------
// Create client per key, and push model instances into pools
const modelPools = { chat: [], todo: [], planner: [], titleIntent: [], notification: [], review: [] };
const keyStates = {}; // { key: { fails, backoffUntil } }

for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
    keyStates[key] = { fails: 0, backoffUntil: 0 };
    // create one model object per pool for this key
    for (const poolName of Object.keys(modelPools)) {
      try {
        const modelName = CONFIG.MODEL[poolName];
        const modelInstance = client.getGenerativeModel({ model: modelName });
        modelPools[poolName].push({ client, model: modelInstance, key });
      } catch (e) {
        console.warn(`Failed to get model ${CONFIG.MODEL[poolName]} for a key — skipping that model instance.`);
      }
    }
  } catch (e) {
    console.warn('Failed to initialize GoogleGenerativeAI client for a key — skipping it.');
  }
}
// Validate non-empty pools
for (const p of Object.keys(modelPools)) {
  if (!modelPools[p] || modelPools[p].length === 0) {
    console.error(`Model pool "${p}" is empty. Please ensure API keys and model names are correct. Model: ${CONFIG.MODEL[p]}`);
    process.exit(1);
  }
}
console.log('✅ Model pools ready:', Object.keys(modelPools).map(k => `${k}:${modelPools[k].length}`).join(', '));

// ---------------- HELPERS ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const escapeForPrompt = (s) => s ? String(s).replace(/"/g, '\\"') : '';
const safeSnippet = (text, max = 4000) => typeof text === 'string' ? (text.length <= max ? text : text.slice(0, max) + '...[truncated]') : '';

async function withTimeout(promise, ms = CONFIG.TIMEOUT.default, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// Failover: try different keys (model instances in a pool), skip keys currently in backoff
async function generateWithFailover(poolName, prompt, opts = {}) {
  const pool = modelPools[poolName];
  if (!pool || pool.length === 0) throw new Error(`No model instances available in pool ${poolName}`);
  const timeoutMs = opts.timeoutMs || CONFIG.TIMEOUT.default;
  const label = opts.label || poolName;

  // shuffle
  const order = [...pool].sort(() => Math.random() - 0.5);
  let lastErr = null;
  for (const inst of order) {
    const k = inst.key;
    const state = keyStates[k] || { backoffUntil: 0, fails: 0 };
    if (state.backoffUntil && Date.now() < state.backoffUntil) {
      continue; // key in backoff
    }
    try {
      const res = await withTimeout(inst.model.generateContent(prompt), timeoutMs, `${label} (key)`);
      // success: reset failure count
      if (keyStates[k]) { keyStates[k].fails = 0; keyStates[k].backoffUntil = 0; }
      return res;
    } catch (err) {
      lastErr = err;
      if (!keyStates[k]) keyStates[k] = { fails: 0, backoffUntil: 0 };
      keyStates[k].fails += 1;
      const backoffMs = Math.min(1000 * Math.pow(2, keyStates[k].fails), 10 * 60 * 1000); // up to 10m
      keyStates[k].backoffUntil = Date.now() + backoffMs;
      console.warn(`${iso()} ${label} failed for a key (fails=${keyStates[k].fails}) — backoff ${backoffMs}ms:`, err && err.message ? err.message : err);
    }
  }
  throw lastErr || new Error(`${label} failed for all keys`);
}

// Robust extractor for model SDK responses
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    // Common patterns:
    if (result.response && typeof result.response.text === 'function') {
      const t = await result.response.text();
      return t ? String(t).trim() : '';
    }
    if (typeof result.text === 'function') {
      const t = await result.text();
      return t ? String(t).trim() : '';
    }
    if (typeof result.text === 'string') return result.text.trim();
    if (typeof result.outputText === 'string') return result.outputText.trim();
    // fallback stringify
    return String(result).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

// JSON parsing & simple repair
function parseJSONFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0].replace(/```(?:json)?/g, '').trim();
  candidate = candidate.replace(/,\s*([}\]])/g, '$1'); // remove trailing commas
  try { return JSON.parse(candidate); } catch (e) {
    // try basic cleaning
    const cleaned = candidate.replace(/[\x00-\x1F]+/g, ' ');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

// Use small repair model to fix malformed JSON (best-effort)
async function ensureJsonOrRepair(rawText, repairPool = 'review') {
  let parsed = parseJSONFromText(rawText);
  if (parsed) return parsed;
  const repairPrompt = `The following text was intended to be a single JSON object but may be malformed. Fix it and return ONLY valid JSON (no commentary). If impossible, return {}.\n\nTEXT:\n${rawText}`;
  try {
    const res = await generateWithFailover(repairPool, repairPrompt, { label: 'JSONRepair', timeoutMs: 6000 });
    const repaired = await extractTextFromResult(res);
    return parseJSONFromText(repaired);
  } catch (err) {
    return null;
  }
}

// ---------------- LRU CACHE ----------------
class LRUCache {
  constructor(limit = 500, ttl = CONFIG.CACHE_TTL) {
    this.limit = limit; this.ttl = ttl; this.map = new Map();
  }
  _expired(e) { return Date.now() - e.ts > this.ttl; }
  get(k) {
    const e = this.map.get(k); if (!e) return null;
    if (this._expired(e)) { this.map.delete(k); return null; }
    this.map.delete(k); this.map.set(k, e); return e.v;
  }
  set(k, v) { if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value); this.map.set(k, { v, ts: Date.now() }); }
  del(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const localCache = { profile: new LRUCache(), progress: new LRUCache() };
async function cacheGet(scope, key) { return localCache[scope] ? localCache[scope].get(key) : null; }
async function cacheSet(scope, key, value) { if (localCache[scope]) localCache[scope].set(key, value); }
async function cacheDel(scope, key) { if (localCache[scope]) localCache[scope].del(key); }

// ---------------- FIRESTORE HELPERS ----------------
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
    const val = doc.exists ? doc.data() : { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
    await cacheSet('progress', userId, val);
    return val;
  } catch (err) {
    console.error('getProgress error:', err && err.message ? err.message : err);
    return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
  }
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
    console.error('fetchUserWeaknesses error:', err && err.message ? err.message : err);
    return [];
  }
}

async function sendUserNotification(userId, payload = { message: '', meta: {}, lang: 'Arabic', fcmTokens: [] }) {
  try {
    const inboxRef = db.collection('userNotifications').doc(userId).collection('inbox');
    await inboxRef.add({
      message: payload.message || '',
      meta: payload.meta || {},
      read: false,
      lang: payload.lang || 'Arabic',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('sendUserNotification failed:', err && err.message ? err.message : err);
  }

  // Optional: send FCM if admin.messaging and tokens provided
  if (Array.isArray(payload.fcmTokens) && payload.fcmTokens.length && admin.messaging) {
    try {
      await admin.messaging().sendMulticast({
        tokens: payload.fcmTokens,
        notification: { title: payload.title || 'EduAI', body: payload.message || '' },
        data: payload.data || {},
      });
    } catch (err) {
      console.warn('FCM send failed:', err && err.message ? err.message : err);
    }
  }
}

function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

// ---------------- MANAGERS ----------------

/* Traffic Manager */
async function runTrafficManager(userMessage) {
  const prompt = `You are a concise Traffic Manager.
Return EXACTLY a JSON object: {"language":"Arabic|English|French","intent":"manage_todo|generate_plan|general_question|unclear","title":"short title (max 4 words)"}.
User message: "${escapeForPrompt(safeSnippet(userMessage, 600))}"`;
  try {
    const res = await generateWithFailover('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUT.notification || CONFIG.TIMEOUT.default });
    const text = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(text);
    if (parsed && parsed.intent && parsed.language) return parsed;
  } catch (err) {
    console.warn('runTrafficManager failed:', err && err.message ? err.message : err);
  }
  // fallback
  const langGuess = /[\u0600-\u06FF]/.test(userMessage) ? 'Arabic' : (/[éèêàç]/i.test(userMessage) ? 'French' : 'English');
  return { language: langGuess, intent: 'unclear', title: langGuess === 'Arabic' ? 'محادثة' : langGuess === 'French' ? 'Conversation' : 'Chat' };
}

/* To-Do Manager */
async function runToDoManager(userId, userRequest, currentTasks = []) {
  const prompt = `You are a To-Do Manager. CURRENT_TASKS: ${JSON.stringify(currentTasks)}\nUSER_REQUEST: "${escapeForPrompt(userRequest)}"\nRespond ONLY with JSON: {"tasks":[ ... ]}. Each task requires id,title,type('review'|'quiz'|'new_lesson'|'practice'|'study'),status('pending'|'completed'),relatedLessonId(null|string),relatedSubjectId(null|string).`;
  const res = await generateWithFailover('todo', prompt, { label: 'ToDoManager', timeoutMs: CONFIG.TIMEOUT.default });
  const text = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(text);
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('ToDoManager returned invalid tasks.');

  const VALID = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);
  const normalized = parsed.tasks.map(t => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || t.name || 'مهمة جديدة'),
    type: VALID.has((t.type || '').toLowerCase()) ? (t.type || '').toLowerCase() : 'review',
    status: (t.status || '').toLowerCase() === 'completed' ? 'completed' : 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  // save (generatedAt outside array)
  await db.collection('userProgress').doc(userId).set({
    dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
  }, { merge: true });

  await cacheSet('progress', userId, { dailyTasks: { tasks: normalized } });
  await cacheDel('progress', userId);
  return normalized;
}

/* Planner Manager */
async function runPlannerManager(userId) {
  const weaknesses = await fetchUserWeaknesses(userId);
  const context = weaknesses.length > 0 ? weaknesses.map(w => `- ${w.lessonId}:${w.subjectId} (${w.masteryScore}%)`).join('\n') : 'none';
  const prompt = `You are an academic planner. Using context:\n${context}\nReturn JSON only: {"tasks":[ ... ]} with 2-4 tasks. Each: id,title(in Arabic),type,status('pending'),relatedLessonId,relatedSubjectId.`;
  const res = await generateWithFailover('planner', prompt, { label: 'Planner', timeoutMs: CONFIG.TIMEOUT.default });
  const text = await extractTextFromResult(res);
  let parsed = await ensureJsonOrRepair(text);
  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    const fallback = [{ id: crypto.randomUUID(), title: 'مراجعة درس مهم', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    await cacheSet('progress', userId, { dailyTasks: { tasks: fallback } });
    await cacheDel('progress', userId);
    return { tasks: fallback, source: 'fallback' };
  }

  const tasksToSave = parsed.tasks.slice(0, 5).map((t, i) => ({
    id: t.id || String(Date.now() + i),
    title: String(t.title || t.name || 'مهمة تعليمية'),
    type: ['review', 'quiz', 'new_lesson', 'practice', 'study'].includes((t.type || '').toLowerCase()) ? (t.type || '').toLowerCase() : 'study',
    status: t.status || 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
  await cacheSet('progress', userId, { dailyTasks: { tasks: tasksToSave } });
  await cacheDel('progress', userId);
  return { tasks: tasksToSave, source: 'AI' };
}

/* Notification Manager */
async function runNotificationManager(purpose, language = 'Arabic', context = {}) {
  let instruction = '';
  switch (purpose) {
    case 'ack': instruction = 'Acknowledge receipt briefly (<=12 words).'; break;
    case 'todo_success': instruction = 'Confirm the to-do list update briefly (<=12 words).'; break;
    case 'plan_success': instruction = 'Announce that the daily plan was created.'; break;
    case 'error': instruction = 'Apologize and state that an error occurred; promise retry.'; break;
    default: instruction = 'Provide a concise helpful message.'; break;
  }
  const prompt = `Write a single short user-facing message in ${language}. Instruction: ${instruction} Context: ${JSON.stringify(context)}\nReturn ONLY the message text.`;
  const res = await generateWithFailover('notification', prompt, { label: 'Notification', timeoutMs: CONFIG.TIMEOUT.notification });
  const text = await extractTextFromResult(res);
  if (!text) return language === 'Arabic' ? 'تم استلام طلبك.' : language === 'French' ? 'Reçu.' : 'Got it — working on it.';
  return text;
}

/* Review Manager */
async function runReviewManager(userRequest, modelResponseText) {
  const prompt = `Score the AI response from 1 (poor) to 10 (excellent) and provide short JSON: {"score":<num>,"feedback":"<short>"}\nUSER_REQUEST: "${escapeForPrompt(safeSnippet(userRequest, 500))}"\nAI_RESPONSE: "${escapeForPrompt(safeSnippet(modelResponseText, 1200))}"`;
  try {
    const res = await generateWithFailover('review', prompt, { label: 'Review', timeoutMs: CONFIG.TIMEOUT.review });
    const text = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(text);
    if (parsed && typeof parsed.score === 'number') return parsed;
  } catch (err) {
    console.warn('runReviewManager failed:', err && err.message ? err.message : err);
  }
  return { score: 10, feedback: 'No issues detected.' };
}

// ---------------- JOB QUEUE ----------------
// enqueue job
async function enqueueJob(job) {
  const ref = db.collection('aiJobs').doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(Object.assign({}, job, { status: 'pending', attempts: 0, createdAt: now, updatedAt: now }));
  return ref.id;
}

// process single job doc
async function processJob(jobDoc) {
  const docRef = jobDoc.ref;
  const data = jobDoc.data();
  if (!data) return;
  const { userId, type, payload = {} } = data;
  try {
    if (type === 'background_chat') {
      const message = payload.message || '';
      const traffic = await runTrafficManager(message);
      const language = traffic.language || (/[٠-٩\u0600-\u06FF]/.test(message) ? 'Arabic' : 'English');
      const intent = traffic.intent || 'unclear';

      if (intent === 'manage_todo') {
        const progress = await getProgress(userId);
        const currentTasks = progress?.dailyTasks?.tasks || [];
        const updated = await runToDoManager(userId, message, currentTasks);
        const notif = await runNotificationManager('todo_success', language, { count: updated.length });
        await sendUserNotification(userId, { message: notif, lang: language });
      } else if (intent === 'generate_plan') {
        const result = await runPlannerManager(userId);
        const humanSummary = formatTasksHuman(result.tasks, language);
        const notif = await runNotificationManager('plan_success', language, { count: result.tasks.length });
        await sendUserNotification(userId, { message: `${notif}\n${humanSummary}`, lang: language });
      } else if (intent === 'general_question') {
        const chatPrompt = `You are EduAI, a warm assistant. Answer concisely in ${language}. User: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
        const res = await generateWithFailover('chat', chatPrompt, { label: 'ResponseManager', timeoutMs: CONFIG.TIMEOUT.chat });
        let replyText = await extractTextFromResult(res);
        const review = await runReviewManager(message, replyText);
        if (review.score < CONFIG.REVIEW_QUALITY_THRESHOLD) {
          const correctivePrompt = `Improve the reply. Reviewer feedback: ${escapeForPrompt(review.feedback)}\nUser: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
          const res2 = await generateWithFailover('chat', correctivePrompt, { label: 'ResponseRetry', timeoutMs: CONFIG.TIMEOUT.chat });
          replyText = await extractTextFromResult(res2);
        }
        await sendUserNotification(userId, { message: replyText, lang: language });
      } else {
        // unclear: send ack only
        const ack = await runNotificationManager('ack', language);
        await sendUserNotification(userId, { message: ack, lang: language });
      }

      await docRef.update({ status: 'done', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      await docRef.update({ status: 'failed', error: 'Unknown job type', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } catch (err) {
    console.error(`processJob failed for job ${docRef.id}:`, err && err.stack ? err.stack : err);
    const attempts = (data.attempts || 0) + 1;
    if (attempts >= 3) {
      await docRef.update({ status: 'failed', error: (err && err.message) ? err.message.slice(0, 1000) : 'error', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      // inform user of failure
      try { await sendUserNotification(userId, { message: '⚠️ حدث خطأ أثناء معالجة طلبك. سنحاول لاحقًا.', lang: 'Arabic' }); } catch (e) {}
    } else {
      await docRef.update({ status: 'pending', attempts, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
}

// worker loop
let workerStopped = false;
async function jobWorkerLoop() {
  while (!workerStopped) {
    try {
      const jobsSnap = await db.collection('aiJobs').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(5).get();
      if (!jobsSnap.empty) {
        for (const jobDoc of jobsSnap.docs) {
          // claim via transaction
          await db.runTransaction(async tx => {
            const fresh = await tx.get(jobDoc.ref);
            if (!fresh.exists) return;
            const s = fresh.data().status;
            if (s === 'pending') {
              tx.update(jobDoc.ref, { status: 'in_progress', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
              // process in background
              process.nextTick(() => processJob(jobDoc).catch(e => console.error('Detached processJob error:', e && e.stack ? e.stack : e)));
            }
          });
        }
      }
    } catch (err) {
      console.error('jobWorkerLoop error:', err && err.stack ? err.stack : err);
    }
    await sleep(CONFIG.JOB_WORKER_POLL_MS);
  }
}
jobWorkerLoop().catch(err => console.error('jobWorkerLoop startup failed:', err && err.stack ? err.stack : err));

// ---------------- ROUTES ----------------
app.post('/chat', async (req, res) => {
  try {
    const userId = req.userId || req.body.userId;
    const message = req.body.message;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });

    // quick ack
    let language = /[\u0600-\u06FF]/.test(message) ? 'Arabic' : (/[éèêàç]/i.test(message) ? 'French' : 'English');
    let ack = language === 'Arabic' ? 'حسناً، أعمل على طلبك الآن.' : language === 'French' ? 'Reçu, je m\\'en occupe.' : 'Got it — working on that.';
    try { ack = await runNotificationManager('ack', language); } catch (e) { /* fallback ack */ }

    // enqueue job
    const jobId = await enqueueJob({ userId, type: 'background_chat', payload: { message }, lang: language });
    res.json({ reply: ack, jobId });
  } catch (err) {
    console.error('/chat error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/update-daily-tasks', async (req, res) => {
  try {
    const userId = req.userId || req.body.userId;
    const userRequest = req.body.userRequest;
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest required' });
    const progress = await getProgress(userId);
    const currentTasks = progress?.dailyTasks?.tasks || [];
    const updated = await runToDoManager(userId, userRequest, currentTasks);
    return res.status(200).json({ success: true, tasks: updated });
  } catch (err) {
    console.error('/update-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to update tasks' });
  }
});

app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const userId = req.userId || req.body.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const result = await runPlannerManager(userId);
    return res.status(200).json({ success: true, source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    console.error('/generate-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to generate tasks' });
  }
});

app.post('/generate-title', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: 'message required' });
    const traffic = await runTrafficManager(message);
    return res.status(200).json({ title: traffic.title || (traffic.language === 'Arabic' ? 'محادثة' : 'Chat') });
  } catch (err) {
    console.error('/generate-title error:', err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'محادثة جديدة' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: iso() }));

// ---------------- WARMUP ----------------
(async () => {
  try {
    await generateWithFailover('chat', 'ping', { label: 'warmup', timeoutMs: 3000 });
    console.log('💡 model warmup OK');
  } catch (e) {
    console.warn('💡 warmup failed (non-fatal)');
  }
})();

// ---------------- SHUTDOWN ----------------
const server = app.listen(CONFIG.PORT, () => {
  console.log(`${iso()} EduAI Brain V15.3 running on port ${CONFIG.PORT}`);
});

function shutdown(sig) {
  console.log(`${iso()} Received ${sig}, shutting down...`);
  workerStopped = true;
  server.close(() => {
    console.log(`${iso()} HTTP server closed.`);
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r, p) => console.error('unhandledRejection', r, p));

module.exports = { app };
