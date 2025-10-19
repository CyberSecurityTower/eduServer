'use strict';

/**
 * EduAI Brain — Final production server.js (Merged, V13)
 * - Merges V11 intelligence + V12 performance + V12.1 fixes
 * - Robust: retries, LRU TTL cache, optional Redis backing, request tracing
 * - Safety: model output parsing, non-empty task checks, guaranteed fallback saves
 * - Observability: requestId logs, basic metrics, adaptive timeouts
 *
 * Env vars required:
 * - GOOGLE_API_KEY
 * - FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON or base64)
 * Optional:
 * - REDIS_URL (for distributed cache)
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// --- CONFIG ---
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  CHAT_MODEL: process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash',
  TITLE_MODEL: process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite',
  TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  CACHE_TTL: Number(process.env.CACHE_TTL_MS || 30 * 1000),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
  BODY_LIMIT: process.env.BODY_LIMIT || '200kb',
  SHUTDOWN_TIMEOUT: Number(process.env.SHUTDOWN_TIMEOUT || 10000),
  REDIS_URL: process.env.REDIS_URL || null,
};

// --- ENV CHECKS ---
if (!process.env.GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY env var.');
  process.exit(1);
}
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
if (CONFIG.REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    redisClient = new IORedis(CONFIG.REDIS_URL);
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

// --- Google Generative AI Init ---
let genAI, chatModel, titleModel;
try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  chatModel = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL });
  titleModel = genAI.getGenerativeModel({ model: CONFIG.TITLE_MODEL });
  console.log(`🤖 AI initialized (Chat: ${CONFIG.CHAT_MODEL}, Title: ${CONFIG.TITLE_MODEL})`);
} catch (err) {
  console.error('❌ GoogleGenerativeAI init failed:', err && err.message ? err.message : err);
  process.exit(1);
}

// --- Metrics ---
const metrics = { requests: 0, errors: 0, avgLatencyMs: 0, sampleCount: 0 };
function observeLatency(latMs) {
  metrics.sampleCount += 1;
  const n = metrics.sampleCount;
  metrics.avgLatencyMs = Math.round(((metrics.avgLatencyMs * (n - 1)) + latMs) / n);
}

// --- Utils ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

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
    try {
      return await fn();
    } catch (err) {
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

function escapeForPrompt(s) { if (!s) return ''; return String(s).replace(/<\//g, '<\\/').replace(/"/g, '\\"'); }
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

// --- Local language detection + model fallback ---
function detectLangLocal(text) {
  if (!text || typeof text !== 'string') return 'Arabic';
  const arabicMatches = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const latinMatches = (text.match(/[a-zA-Z]/g) || []).length;
  const len = Math.max(1, text.length);
  if (arabicMatches / len > 0.02) return 'Arabic';
  if (latinMatches / len > 0.02) return 'English';
  return null;
}
async function detectLanguage(text) {
  try {
    const local = detectLangLocal(text);
    if (local) return local;
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English"). Text: "${(text || '').replace(/"/g, '\\"')}"`;
    const raw = await withTimeout(titleModel.generateContent(prompt), CONFIG.TIMEOUT_MS, 'language detection');
    const rawText = await extractTextFromResult(raw);
    if (!rawText) return 'Arabic';
    const token = (rawText.split(/[^a-zA-Z]+/).find(Boolean) || '').toLowerCase();
    if (!token) return 'Arabic';
    return token[0].toUpperCase() + token.slice(1);
  } catch (err) {
    console.error('Language detection failed, fallback Arabic:', err && err.message ? err.message : err);
    return 'Arabic';
  }
}

// --- Firestore helpers (unchanged but using cache functions) ---
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

// --- Business logic (merged intelligence, improved) ---
const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);

async function handleUpdateTasks({ userId, userRequest }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');
  console.log(`[${iso()}] 🔧 handleUpdateTasks for user=${userId}`);

  const progressDoc = await db.collection('userProgress').doc(userId).get();
  const currentTasks = progressDoc.exists ? (progressDoc.data().dailyTasks?.tasks || []) : [];

  const modificationPrompt = `
<role>You are an intelligent task manager. Modify a user's task list based on their request. Respond ONLY with a valid JSON object: { "tasks": [...] }.</role>
<current_tasks>${JSON.stringify(currentTasks)}</current_tasks>
<user_request>"${escapeForPrompt(userRequest)}"</user_request>
<instructions>
Modify the list. Titles must be in Arabic. Maintain all required fields.
CRITICAL: You MUST use one of the following exact strings for the "type" field: 'review', 'quiz', 'new_lesson', 'practice', 'study'.
Each task must include at least: id, title, type, status ('pending' or 'done'), relatedLessonId (nullable), relatedSubjectId (nullable).
</instructions>
`.trim();

  try {
    const modelCall = () => chatModel.generateContent(modificationPrompt);
    const raw = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'task modification'));
    const rawText = await extractTextFromResult(raw);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks)) {
      console.error(`[${iso()}] ❌ Failed to parse tasks from model for user=${userId}. Raw: ${rawText}`);
      throw new Error('Model returned invalid tasks array');
    }

    const normalized = parsed.tasks.map((t) => {
      const type = (t.type || '').toString().toLowerCase();
      return {
        id: t.id || (String(Date.now()) + Math.random().toString(36).slice(2, 9)),
        title: t.title || t.name || 'مهمة جديدة',
        type: VALID_TASK_TYPES.has(type) ? type : 'review',
        status: t.status || 'pending',
        relatedLessonId: t.relatedLessonId || null,
        relatedSubjectId: t.relatedSubjectId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });

    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    await cacheDel('progress', userId);

    console.log(`[${iso()}] ✅ Updated tasks for user=${userId}. New count: ${normalized.length}`);
    return normalized;
  } catch (err) {
    console.error('handleUpdateTasks error:', err && err.message ? err.message : err);
    throw err;
  }
}

async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID is required');
  console.log(`[${iso()}] 📅 handleGenerateDailyTasks for ${userId}`);

  try {
    const weaknesses = await fetchUserWeaknesses(userId);
    const weaknessesPrompt = weaknesses.length > 0
      ? `<user_weaknesses>\n${weaknesses.map(w => `- Lesson ID: ${w.lessonId}, Subject: ${w.subjectId}, Mastery: ${w.masteryScore}%`).join('\n')}\n</user_weaknesses>`
      : '<user_weaknesses>User has no specific weaknesses. Suggest a new lesson about a general topic.</user_weaknesses>';

    const taskPrompt = `
<role>You are an expert academic planner. Generate a personalized daily study plan. Respond ONLY with a valid JSON object: { "tasks": [...] }.</role>
${weaknessesPrompt}
<instructions>
1. Create 2-3 tasks based on weaknesses. If none, create introductory tasks.
2. Titles must be in Arabic.
3. Each task must include: id, title, type, status ('pending'), relatedLessonId, and relatedSubjectId.
</instructions>
`.trim();

    const modelCall = () => chatModel.generateContent(taskPrompt);
    const raw = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'task generation'));
    const rawText = await extractTextFromResult(raw);
    const parsed = parseJSONFromText(rawText);

    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      console.warn(`[${iso()}] ⚠️ Model returned empty or invalid tasks for ${userId}. Using fallback.`);
      throw new Error('Model returned empty tasks');
    }

    // 🧩 Normalize each task (remove invalid fields, add ids)
    const tasksToSave = parsed.tasks.slice(0, 5).map((task, i) => ({
      id: task.id || String(Date.now() + i),
      title: String(task.title || 'مهمة جديدة').trim(),
      type: ['review', 'quiz', 'new_lesson', 'practice', 'study'].includes(task.type) ? task.type : 'study',
      status: 'pending',
      relatedLessonId: task.relatedLessonId || null,
      relatedSubjectId: task.relatedSubjectId || null
    }));

    // ✅ الحفظ الصحيح (بدون serverTimestamp داخل المصفوفة)
    await db.collection('userProgress').doc(userId).set({
  dailyTasks: {
    tasks: tasksToSave,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  },
}, { merge: true });

if (cache?.progress) cache.progress.clear();
console.log(`[${iso()}] ✅ Generated ${tasksToSave.length} tasks for ${userId}`);
return tasksToSave;


  } catch (err) {
    console.error(`[${iso()}] ❌ handleGenerateDailyTasks (${userId}) failed:`, err);


    // ✅ fallback بدون serverTimestamp داخل المصفوفة
    const fallbackTasks = [{
      id: String(Date.now()),
      title: 'مراجعة درس مهم',
      type: 'review',
      status: 'pending',
      relatedLessonId: null,
      relatedSubjectId: null
    }];

    try {
      await db.collection('userProgress').doc(userId).set({
  dailyTasks: {
    tasks: fallbackTasks,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  },
}, { merge: true });

if (cache?.progress) cache.progress.clear();
console.log(`[${iso()}] ✅ Saved fallback task for ${userId}`);

    } catch (saveErr) {
      console.error(`[${iso()}] ⚠️ CRITICAL: Failed to save fallback task:`, saveErr.message);
    }

    return fallbackTasks;
  }
}
// ----------------- ROUTES -----------------
app.post('/chat', async (req, res) => {
  const start = Date.now();
  metrics.requests += 1;
  const reqId = req.requestId || 'unknown';

  try {
    const { userId, message, history = [] } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    const [profile, progress, detectedLang] = await Promise.all([getProfile(userId), getProgress(userId), detectLanguage(message)]);

    // include current tasks in context
    const currentTasks = (progress && progress.dailyTasks && Array.isArray(progress.dailyTasks.tasks)) ? progress.dailyTasks.tasks : [];
    const tasksContext = currentTasks.length > 0 ? `<daily_tasks_context>\n${JSON.stringify(currentTasks)}\n</daily_tasks_context>` : '<daily_tasks_context>User has no tasks scheduled.</daily_tasks_context>';

    const formattedHistory = (history || []).slice(-5).map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${String(h.text || '').replace(/\n/g, ' ')}`).join('\n');

    const finalPrompt = `
<role>
You are 'EduAI', a smart and empathetic study companion.
</role>

<user_profile>
  <dynamic_data>
    - Points: ${Number(progress.stats?.points || 0)}
    - Streak: ${Number(progress.streakCount || 0)}
  </dynamic_data>
  <static_memory>${escapeForPrompt(safeSnippet(profile || '', 1000))}</static_memory>
</user_profile>

${tasksContext}

<conversation_context>
${formattedHistory || 'This is a new conversation.'}
User: ${escapeForPrompt(safeSnippet(message, 6000))}
</conversation_context>

<capabilities>
1.  Answer Questions: If the user asks about their tasks, use the <daily_tasks_context> to answer in a friendly summary.
2.  Manage Tasks: If the user gives a command to create, add, or modify tasks, respond ONLY with this JSON:
    { "action": "manage_tasks", "userRequest": "${escapeForPrompt(message)}" }
</capabilities>

Final Instruction: Based on user's message, decide whether to answer as text or respond with JSON. Respond in ${detectedLang}.
`.trim();

    const modelCall = () => chatModel.generateContent(finalPrompt);
    const modelRes = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'chat model'));
    const rawReply = await extractTextFromResult(modelRes);

    const actionResponse = parseJSONFromText(rawReply);

    if (actionResponse?.action === 'manage_tasks' && actionResponse.userRequest) {
      req.log('Action detected:', actionResponse.userRequest);
      setImmediate(() => { handleUpdateTasks({ userId, userRequest: actionResponse.userRequest }).catch(err => req.log('Background update failed:', err && err.message ? err.message : err)); });
      const confirmationMessage = "بالتأكيد! أنا أعمل على تحديث مهامك الآن.";
      res.json({ reply: confirmationMessage });
      observeLatency(Date.now() - start);
      return;
    }

    res.json({ reply: rawReply || 'لم أستطع توليد رد مناسب.' });
    observeLatency(Date.now() - start);
  } catch (err) {
    metrics.errors += 1;
    console.error(`[${iso()}] ❌ /chat error:`, err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) return res.status(504).json({ error: 'Model request timed out.' });
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// update-daily-tasks HTTP wrapper
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });
    const updated = await handleUpdateTasks({ userId, userRequest });
    return res.status(200).json({ success: true, tasks: updated });
  } catch (err) {
    console.error(`[${iso()}] ❌ Error in /update-daily-tasks:`, err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to update daily tasks.' });
  }
});

// generate-daily-tasks
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const tasks = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, tasks });
  } catch (err) {
    console.error(`[${iso()}] ❌ Error in /generate-daily-tasks:`, err && err.message ? err.message : err);
    return res.status(200).json({ success: true, generatedAt: iso(), source: 'AI', tasks });
  }
});

// generate-title (more robust)
app.post('/generate-title', async (req, res) => {
  const { message, language } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  try {
    const lang = language || 'Arabic';
    const prompt = `Summarize this message into a short, engaging chat title in ${lang}. Respond with ONLY the title text. NEVER respond with an empty string. Message: "${escapeForPrompt(safeSnippet(message, 1000))}"`;
    const modelCall = () => titleModel.generateContent(prompt);
    const modelRes = await retry(() => withTimeout(modelCall(), 5000, 'title generation'));
    let titleText = await extractTextFromResult(modelRes);
    if (!titleText) { console.warn(`[${iso()}] ⚠️ Title model returned empty. Using fallback.`); titleText = 'محادثة جديدة'; }
    res.json({ title: titleText.trim() });
  } catch (err) {
    console.error(`[${iso()}] ❌ Title generation failed:`, err && err.message ? err.message : err);
    // return fallback gracefully
    return res.status(200).json({ success: true, generatedAt: iso(), source: 'fallback', tasks });
  }
});

// health
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development', metrics, time: iso() });
});

// --- Graceful shutdown ---
let server = null;
function shutdown(signal) {
  console.log(`[${iso()}] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log(`[${iso()}] HTTP server closed.`);
      if (redisClient) redisClient.quit().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => { console.warn(`[${iso()}] Forcing shutdown.`); process.exit(1); }, CONFIG.SHUTDOWN_TIMEOUT).unref();
  } else { process.exit(0); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Start server ---
server = app.listen(CONFIG.PORT, () => {
  console.log(`🚀 EduAI Brain (Merged Final) running on port ${CONFIG.PORT}`);
  console.log(`💬 Chat model: ${CONFIG.CHAT_MODEL}`);
  console.log(`🏷️ Title model: ${CONFIG.TITLE_MODEL}`);
});

module.exports = {
  app,
  handleUpdateTasks,
  handleGenerateDailyTasks,
  getProgress,
  getProfile,
};
