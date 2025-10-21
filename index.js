'use strict';

/**
 * server.js — EduAI Brain V15.6
 * - Hybrid sync/async routing (/chat)
 * - Multi-model pools with key rotation & backoff
 * - Firestore-backed job queue worker (collection aiJobs)
 * - /generate-daily-tasks accepts optional pathId
 * - For general_question: model receives last 5 messages + full user context
 *
 * Required env:
 * - FIREBASE_SERVICE_ACCOUNT_KEY
 * - One or more GOOGLE_API_KEY, or GOOGLE_API_KEY_1..4
 *
 * npm deps:
 *   npm install express cors firebase-admin @google/generative-ai
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// ---------------- CONFIG ----------------
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  MODEL: {
    chat: process.env.MODEL_CHAT || 'gemini-2.5-flash',
    todo: process.env.MODEL_TODO || 'gemini-2.5-pro',
    planner: process.env.MODEL_PLANNER || 'gemini-2.5-pro',
    titleIntent: process.env.MODEL_TITLE || 'gemini-2.5-flash-lite',
    notification: process.env.MODEL_NOTIFICATION || 'gemini-2.5-flash-lite',
    review: process.env.MODEL_REVIEW || 'gemini-2.5-pro',
  },
  TIMEOUTS: {
    default: Number(process.env.TIMEOUT_DEFAULT_MS || 25000),
    chat: Number(process.env.TIMEOUT_CHAT_MS || 30000),
    notification: Number(process.env.TIMEOUT_NOTIFICATION_MS || 7000),
    review: Number(process.env.TIMEOUT_REVIEW_MS || 20000),
  },
  CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || 30000),
  JOB_POLL_MS: Number(process.env.JOB_WORKER_POLL_MS || 3000),
  REVIEW_THRESHOLD: Number(process.env.REVIEW_QUALITY_THRESHOLD || 6),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
};

// ---------------- BOOT & INIT ----------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
  process.exit(1);
}

// collect API keys (1..4) plus fallback GOOGLE_API_KEY
const apiKeyCandidates = Array.from({ length: 4 }, (_, i) => process.env[`GOOGLE_API_KEY_${i + 1}`]).filter(Boolean);
if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) {
  apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
}
if (apiKeyCandidates.length === 0) {
  console.error('No Google API keys found (GOOGLE_API_KEY or GOOGLE_API_KEY_1..4). Exiting.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: process.env.BODY_LIMIT || '300kb' }));
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  req.log = (...args) => console.log(new Date().toISOString(), `[req:${req.requestId}]`, ...args);
  next();
});

// initialize firebase admin
let db;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (e) {
    try { serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch (e2) { serviceAccount = JSON.parse(raw.replace(/\\n/g, '\n')); }
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized.');
} catch (err) {
  console.error('❌ Firebase init failed:', err && err.message ? err.message : err);
  process.exit(1);
}

// ---------------- MODEL POOLS & KEY HEALTH ----------------
const poolNames = ['chat', 'todo', 'planner', 'titleIntent', 'notification', 'review'];
const modelPools = poolNames.reduce((acc, p) => ({ ...acc, [p]: [] }), {});
const keyStates = {}; // { apiKey: { fails, backoffUntil } }

for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
    keyStates[key] = { fails: 0, backoffUntil: 0 };
    for (const pool of poolNames) {
      const instance = client.getGenerativeModel({ model: CONFIG.MODEL[pool] });
      modelPools[pool].push({ client, model: instance, key });
    }
  } catch (e) {
    console.warn('GoogleGenerativeAI init failed for a key — skipping it.', e && e.message ? e.message : e);
  }
}
for (const p of poolNames) {
  if (!modelPools[p] || modelPools[p].length === 0) {
    console.error(`Model pool "${p}" is empty. Check API keys & model names. Requires: ${CONFIG.MODEL[p]}`);
    process.exit(1);
  }
}
console.log('✅ Model pools ready:', Object.fromEntries(poolNames.map(p => [p, modelPools[p].length])));

// ---------------- UTILITIES ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const escapeForPrompt = (s) => (s ? String(s).replace(/"/g, '\\"') : '');
const safeSnippet = (text, max = 2000) => (typeof text === 'string' ? (text.length <= max ? text : `${text.slice(0, max)}...[truncated]`) : '');
const shuffled = (arr) => arr.slice().sort(() => Math.random() - 0.5);

async function withTimeout(promise, ms = CONFIG.TIMEOUTS.default, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function generateWithFailover(poolName, prompt, opts = {}) {
  const pool = modelPools[poolName];
  if (!pool || pool.length === 0) throw new Error(`No models for pool ${poolName}`);
  const timeoutMs = opts.timeoutMs || CONFIG.TIMEOUTS.default;
  const label = opts.label || poolName;

  let lastErr = null;
  for (const inst of shuffled(pool)) {
    try {
      const k = inst.key;
      if (keyStates[k] && keyStates[k].backoffUntil > Date.now()) continue;
      const call = inst.model.generateContent(prompt);
      const res = await withTimeout(call, timeoutMs, `${label} (key)`);
      if (keyStates[inst.key]) keyStates[inst.key].fails = 0;
      return res;
    } catch (err) {
      lastErr = err;
      if (inst && inst.key && keyStates[inst.key]) {
        keyStates[inst.key].fails = (keyStates[inst.key].fails || 0) + 1;
        const backoff = Math.min(1000 * (2 ** keyStates[inst.key].fails), 10 * 60 * 1000);
        keyStates[inst.key].backoffUntil = Date.now() + backoff;
        console.warn(`${iso()} ${poolName} failed for key (fails=${keyStates[inst.key].fails}), backoff ${backoff}ms:`, err && err.message ? err.message : err);
      } else {
        console.warn(`${iso()} ${poolName} failed for an instance:`, err && err.message ? err.message : err);
      }
    }
  }
  throw lastErr || new Error(`${label} failed for all available keys`);
}

async function extractTextFromResult(result) {
  try {
    if (!result) return '';
    if (result.response && typeof result.response.text === 'function') {
      const t = await result.response.text();
      return (t || '').toString().trim();
    }
    if (typeof result === 'string') return result.trim();
    if (result.text && typeof result.text === 'string') return result.text.trim();
    if (result.outputText && typeof result.outputText === 'string') return result.outputText.trim();
    return '';
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

function parseJSONFromText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0].replace(/```(?:json)?/g, '').trim();
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(candidate); } catch (e) { try { const cleaned = candidate.replace(/[\u0000-\u001F]+/g, ''); return JSON.parse(cleaned); } catch (e2) { return null; } }
}

async function ensureJsonOrRepair(rawText, repairPool = 'review') {
  const parsed = parseJSONFromText(rawText);
  if (parsed) return parsed;
  const repairPrompt = `The following text should be a single valid JSON object. Fix it and return ONLY the JSON. If impossible, return {}.\n\nTEXT:\n${rawText}`;
  try {
    const res = await generateWithFailover(repairPool, repairPrompt, { label: 'JSONRepair', timeoutMs: 5000 });
    const fixed = await extractTextFromResult(res);
    return parseJSONFromText(fixed);
  } catch (e) {
    return null;
  }
}

// ---------------- CACHE & FIRESTORE HELPERS ----------------
class LRUCache {
  constructor(limit = 500, ttl = CONFIG.CACHE_TTL_MS) { this.limit = limit; this.ttl = ttl; this.map = new Map(); }
  _isExpired(e) { return Date.now() - e.t > this.ttl; }
  get(k) { const e = this.map.get(k); if (!e) return null; if (this._isExpired(e)) { this.map.delete(k); return null; } this.map.delete(k); this.map.set(k, e); return e.v; }
  set(k, v) { if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value); this.map.set(k, { v, t: Date.now() }); }
  del(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const localCache = { profile: new LRUCache(), progress: new LRUCache() };
async function cacheGet(scope, key) { return localCache[scope] ? localCache[scope].get(key) : null; }
async function cacheSet(scope, key, value) { if (localCache[scope]) localCache[scope].set(key, value); }
async function cacheDel(scope, key) { if (localCache[scope]) localCache[scope].del(key); }

// profile, progress, weaknesses, notification helpers
async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = (doc.exists && doc.data()?.profileSummary) ? String(doc.data().profileSummary) : 'No available memory.';
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
    if (doc.exists) {
      const val = doc.data() || {};
      await cacheSet('progress', userId, val);
      return val;
    }
  } catch (err) {
    console.error('getProgress error:', err && err.message ? err.message : err);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
}

async function fetchUserWeaknesses(userId, pathId = null) {
  try {
    const doc = await db.collection('userProgress').doc(userId).get();
    if (!doc.exists) return [];
    const progressData = doc.data()?.pathProgress || {};
    const weaknesses = [];
    const pathsToScan = pathId ? [pathId] : Object.keys(progressData);
    for (const pid of pathsToScan) {
      const pathEntry = progressData[pid] || {};
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

async function sendUserNotification(userId, payload) {
  try {
    const inboxCol = db.collection('userNotifications').doc(userId).collection('inbox');
    await inboxCol.add({
      message: payload.message || '',
      meta: payload.meta || {},
      read: false,
      lang: payload.lang || 'Arabic',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('sendUserNotification write failed:', err && err.message ? err.message : err);
  }
}

function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

// ---------------- MANAGERS ----------------

async function runTrafficManager(userMessage) {
  const prompt = `You are a Traffic Manager. Identify dominant language ("Arabic","English","French"), intent from ["manage_todo","generate_plan","general_question","unclear"], and a short title (<=4 words) in that language.
Respond with EXACTLY a JSON object: {"language":"...","intent":"...","title":"..."}
User message: "${escapeForPrompt(safeSnippet(userMessage, 500))}"`;
  const res = await generateWithFailover('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUTS.notification });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'titleIntent');
  if (!parsed || !parsed.intent) return { language: 'Arabic', intent: 'unclear', title: 'محادثة' };
  return parsed;
}

async function runToDoManager(userId, userRequest, currentTasks = []) {
  const prompt = `You are an expert To-Do List Manager AI. Modify the CURRENT TASKS per USER REQUEST.
CURRENT TASKS: ${JSON.stringify(currentTasks)}
USER REQUEST: "${escapeForPrompt(userRequest)}"
Rules:
1) Respond ONLY with JSON: { "tasks": [ ... ] } and no extra text.
2) Each task must have id,title,type ('review'|'quiz'|'new_lesson'|'practice'|'study'),status ('pending'|'completed'),relatedLessonId (string|null),relatedSubjectId (string|null).
3) Preserve existing IDs for modified tasks. Create new UUIDs for new tasks.
If unclear, return current tasks unchanged.`;
  const res = await generateWithFailover('todo', prompt, { label: 'ToDoManager', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'todo');
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('ToDoManager returned invalid tasks.');

  const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);
  const normalized = parsed.tasks.map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || 'مهمة جديدة'),
    type: VALID_TASK_TYPES.has(String(t.type || '').toLowerCase()) ? String(t.type).toLowerCase() : 'review',
    status: String(t.status || 'pending').toLowerCase() === 'completed' ? 'completed' : 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  await db.collection('userProgress').doc(userId).set({
    dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
  }, { merge: true });
  try { await cacheSet('progress', userId, { dailyTasks: { tasks: normalized } }); } catch (e) {}
  await cacheDel('progress', userId);
  return normalized;
}

/**
 * runPlannerManager(userId, pathId)
 * - if pathId provided, uses weaknesses limited to that path
 * - returns { tasks, source }
 */
async function runPlannerManager(userId, pathId = null) {
  const weaknesses = await fetchUserWeaknesses(userId, pathId);
  const weaknessesPrompt = weaknesses.length > 0
    ? `<user_weaknesses>\n${weaknesses.map(w => `- Lesson: ${w.lessonId}, Subject: ${w.subjectId}, Mastery: ${w.masteryScore}%`).join('\n')}\n</user_weaknesses>`
    : '<user_weaknesses>No specific weaknesses found. Suggest a general introductory plan.</user_weaknesses>';

  const extraContext = pathId ? `Using pathId: ${pathId}` : '';
  const prompt = `You are an expert academic planner. ${weaknessesPrompt}
${extraContext}
Produce 2-4 personalized daily tasks. Respond ONLY with JSON: { "tasks": [ ... ] } where each task includes id, title (in Arabic), type, status ('pending'), relatedLessonId (nullable), relatedSubjectId (nullable).`;

  const res = await generateWithFailover('planner', prompt, { label: 'Planner', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'planner');

  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    const fallback = [{ id: crypto.randomUUID(), title: 'مراجعة درس مهم', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });
    await cacheDel('progress', userId);
    return { tasks: fallback, source: 'fallback' };
  }

  const tasksToSave = parsed.tasks.slice(0, 5).map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || t.name || 'مهمة تعليمية'),
    type: ['review', 'quiz', 'new_lesson', 'practice', 'study'].includes((t.type || '').toString().toLowerCase()) ? (t.type || '').toString().toLowerCase() : 'review',
    status: 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  await db.collection('userProgress').doc(userId).set({
    dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
  }, { merge: true });

  await cacheSet('progress', userId, { dailyTasks: { tasks: tasksToSave } });
  await cacheDel('progress', userId);
  return { tasks: tasksToSave, source: 'AI' };
}

async function runNotificationManager(purpose, language, context = {}) {
  let instruction = '';
  switch (purpose) {
    case 'ack': instruction = 'Acknowledge the user briefly (<=15 words).'; break;
    case 'todo_success': instruction = 'Confirm the to-do list was updated. Be brief and encouraging.'; break;
    case 'plan_success': instruction = 'Announce that a new daily plan has been created.'; break;
    case 'error': instruction = 'Apologize and say an unexpected error occurred.'; break;
    default: instruction = 'Provide a concise, helpful message.'; break;
  }
  const prompt = `You are a Notification Manager. Write one short message in ${language}. Instruction: ${instruction}. Context: ${JSON.stringify(context)}. Respond with only the plain text message.`;
  try {
    const res = await generateWithFailover('notification', prompt, { label: 'NotificationManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const text = await extractTextFromResult(res);
    return text || (language === 'Arabic' ? 'حسناً، أعمل على طلبك الآن.' : language === 'French' ? "Reçu, je m'en occupe." : 'Got it — working on that.');
  } catch (e) {
    return (language === 'Arabic' ? 'حسناً، أعمل على طلبك الآن.' : language === 'French' ? "Reçu, je m'en occupe." : 'Got it — working on that.');
  }
}

async function runReviewManager(userRequest, modelResponseText) {
  const prompt = `You are a Review Manager. Evaluate the AI response for correctness, completeness, and relevance. Score 1..10 and return ONLY JSON: {"score":<number>,"feedback":"..."}.
USER REQUEST: "${escapeForPrompt(safeSnippet(userRequest, 500))}"
AI RESPONSE: "${escapeForPrompt(safeSnippet(modelResponseText, 1000))}"`;
  try {
    const res = await generateWithFailover('review', prompt, { label: 'ReviewManager', timeoutMs: CONFIG.TIMEOUTS.review });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'review');
    if (!parsed || typeof parsed.score !== 'number') return { score: 10, feedback: 'No reviewer feedback.' };
    return parsed;
  } catch (e) {
    return { score: 10, feedback: 'Reviewer failed.' };
  }
}

// ---------------- JOB QUEUE & WORKER ----------------
async function enqueueJob(job) {
  try {
    const docRef = await db.collection('aiJobs').add({
      userId: job.userId,
      type: job.type,
      payload: job.payload || {},
      status: 'pending',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  } catch (err) {
    console.error('enqueueJob failed:', err && err.message ? err.message : err);
    throw err;
  }
}

async function processJob(jobDoc) {
  const docRef = jobDoc.ref;
  const data = jobDoc.data();
  if (!data) return;
  const { userId, type, payload = {} } = data;
  const message = payload.message || '';
  const intent = payload.intent || null;
  const language = payload.language || 'Arabic';
  const history = payload.history || [];

  try {
    if (type === 'background_chat') {
      if (intent === 'manage_todo') {
        const progress = await getProgress(userId);
        const currentTasks = progress?.dailyTasks?.tasks || [];
        const updated = await runToDoManager(userId, message, currentTasks);
        const notif = await runNotificationManager('todo_success', language, { count: updated.length });
        await sendUserNotification(userId, { message: notif, lang: language, meta: { source: 'todo' } });
      } else if (intent === 'generate_plan') {
        // payload may contain pathId
        const pathId = payload.pathId || null;
        const result = await runPlannerManager(userId, pathId);
        const humanSummary = formatTasksHuman(result.tasks, language);
        const notif = await runNotificationManager('plan_success', language, { count: result.tasks.length });
        await sendUserNotification(userId, { message: `${notif}\n${humanSummary}`, lang: language, meta: { source: 'planner' } });
      } else {
        // unsupported intent — ignore but mark done
        console.log(`processJob: unsupported intent "${intent}" for job ${docRef.id}`);
      }
      await docRef.update({ status: 'done', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      await docRef.update({ status: 'failed', error: 'Unknown job type', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } catch (err) {
    console.error(`processJob failed for job ${docRef.id}:`, err && err.stack ? err.stack : err);
    const attempts = (data.attempts || 0) + 1;
    if (attempts >= 3) {
      await docRef.update({ status: 'failed', error: (err && err.message) ? err.message.slice(0, 1000) : 'error', attempts, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await sendUserNotification(userId, { message: '⚠️ حدث خطأ أثناء معالجة طلبك. سنحاول لاحقًا.', lang: language });
    } else {
      await docRef.update({ status: 'pending', attempts, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
}

let workerStopped = false;
async function jobWorkerLoop() {
  while (!workerStopped) {
    try {
      const jobsSnap = await db.collection('aiJobs').where('status', '==', 'pending').orderBy('createdAt').limit(5).get();
      for (const jobDoc of jobsSnap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(jobDoc.ref);
            if (fresh.exists && fresh.data().status === 'pending') {
              tx.update(jobDoc.ref, { status: 'in_progress', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
              process.nextTick(() => processJob(jobDoc).catch((e) => console.error('Detached processJob error:', e && e.stack ? e.stack : e)));
            }
          });
        } catch (txErr) {
          console.warn('Transaction claim failed for job:', txErr && txErr.message ? txErr.message : txErr);
        }
      }
    } catch (err) {
      console.error('jobWorkerLoop error:', err && err.stack ? err.stack : err);
    }
    await sleep(CONFIG.JOB_POLL_MS);
  }
}
jobWorkerLoop().catch((err) => console.error('jobWorkerLoop startup failed:', err && err.stack ? err.stack : err));

// ---------------- SYNCHRONOUS QUESTION HANDLER ----------------
/**
 * handleGeneralQuestion(message, language, history, userProfile, userProgress)
 * - history: array of last messages objects { role, text } (we'll take last 5)
 * - userProfile: string summary
 * - userProgress: raw progress doc (contains dailyTasks, pathProgress, etc.)
 * The model receives last 5 messages + user context (tasks, profile, progress)
 */
async function handleGeneralQuestion(message, language, history = [], userProfile = 'No available memory.', userProgress = {}) {
  const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
    .map(h => {
      const who = (h.role === 'model' || h.role === 'assistant') ? 'Assistant' : 'User';
      return `${who}: ${escapeForPrompt(safeSnippet(h.text || '', 500))}`;
    })
    .join('\n');

  const tasksSummary = (userProgress && userProgress.dailyTasks && Array.isArray(userProgress.dailyTasks.tasks))
    ? JSON.stringify(userProgress.dailyTasks.tasks.map(t => ({ id: t.id, title: t.title, type: t.type, status: t.status })))
    : '[]';

  const pathProgressSnippet = safeSnippet(JSON.stringify(userProgress.pathProgress || {}), 2000);

  const historyBlock = lastFive ? `<conversation_history>\n${lastFive}\n</conversation_history>\n` : '';

  const prompt = `You are EduAI, a warm and precise educational assistant. Answer concisely in ${language}.
You are given:
1) Conversation history (last messages)
2) User profile (short summary)
3) Current tasks (ids, titles, types, statuses)
4) Path/progress summary (subjects/lessons truncated)
Use these to answer the user's question faithfully.

${historyBlock}
<user_profile>
${escapeForPrompt(safeSnippet(userProfile, 1000))}
</user_profile>

<current_tasks>
${tasksSummary}
</current_tasks>

<path_progress>
${pathProgressSnippet}
</path_progress>

User question: "${escapeForPrompt(safeSnippet(message, 2000))}"

Answer directly and helpfully (no commentary about internal state).`;

  const res = await generateWithFailover('chat', prompt, { label: 'ResponseManager', timeoutMs: CONFIG.TIMEOUTS.chat });
  let replyText = await extractTextFromResult(res);

  const review = await runReviewManager(message, replyText);
  if (review && typeof review.score === 'number' && review.score < CONFIG.REVIEW_THRESHOLD) {
    const correctivePrompt = `Previous reply scored ${review.score}/10. Improve it based on: ${escapeForPrompt(review.feedback)}. User: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
    const res2 = await generateWithFailover('chat', correctivePrompt, { label: 'ResponseRetry', timeoutMs: CONFIG.TIMEOUTS.chat });
    const improved = await extractTextFromResult(res2);
    if (improved) replyText = improved;
  }

  return replyText || (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن. هل تريد إعادة الصياغة؟' : 'I could not generate an answer right now.');
}

// ---------------- ROUTES ----------------

/**
 * /chat
 * - determines intent synchronously
 * - for actions (manage_todo, generate_plan): enqueue job (background) and return ack
 * - for general_question/unclear: reply synchronously using handleGeneralQuestion with full context
 * - client should send optional history array in body
 */
app.post('/chat', async (req, res) => {
  try {
    const userId = req.userId || req.body.userId;
    const { message, history = [] } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });

    // Determine intent
    const traffic = await runTrafficManager(message);
    const language = traffic.language || 'Arabic';
    const intent = traffic.intent || 'unclear';

    if (intent === 'manage_todo' || intent === 'generate_plan') {
      // Async: enqueue job
      const ack = await runNotificationManager('ack', language);
      // pass history and (optionally) pathId in payload (client may include pathId)
      const payload = { message, intent, language, history, pathId: req.body.pathId || null };
      const jobId = await enqueueJob({ userId, type: 'background_chat', payload });
      return res.json({ reply: ack, jobId, isAction: true });
    }

    // Synchronous path: build context and reply
    const userProfile = await getProfile(userId);
    const userProgress = await getProgress(userId);
    const reply = await handleGeneralQuestion(message, language, history, userProfile, userProgress);
    return res.json({ reply, isAction: false });
  } catch (err) {
    console.error('/chat error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'An internal server error occurred while processing your request.' });
  }
});

// update-daily-tasks (direct)
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });
    const progress = await getProgress(userId);
    const currentTasks = progress?.dailyTasks?.tasks || [];
    const updated = await runToDoManager(userId, userRequest, currentTasks);
    return res.status(200).json({ success: true, tasks: updated });
  } catch (err) {
    console.error('/update-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to update tasks.' });
  }
});

// generate-daily-tasks now accepts optional pathId and passes it to planner
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId, pathId = null } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const result = await runPlannerManager(userId, pathId);
    return res.status(200).json({ success: true, generatedAt: new Date().toISOString(), source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    console.error('/generate-daily-tasks error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

// generate-title uses Traffic Manager to return consistent title
app.post('/generate-title', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const traffic = await runTrafficManager(message);
    return res.status(200).json({ title: traffic.title || 'محادثة جديدة' });
  } catch (err) {
    console.error('/generate-title error:', err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'محادثة جديدة' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: iso() }));

// ---------------- STARTUP & SHUTDOWN ----------------
const server = app.listen(CONFIG.PORT, () => {
  console.log(`✅ EduAI Brain V15.6 running on port ${CONFIG.PORT}`);
  (async () => {
    try {
      await generateWithFailover('titleIntent', 'ping', { label: 'warmup', timeoutMs: 2000 });
      console.log('💡 Model warmup done.');
    } catch (e) { console.warn('💡 Model warmup skipped/failed (non-fatal).'); }
  })();
});

function shutdown(sig) {
  console.log(`${iso()} Received ${sig}, shutting down...`);
  workerStopped = true;
  server.close(async () => {
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
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));

module.exports = { app };
