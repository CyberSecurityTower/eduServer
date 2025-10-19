'use strict';

/**
 * EduAI Brain V12.1 — Final (V11 intelligence + V12 performance)
 *
 * تحسينات:
 * - موجه ذكي مستمد من V11 في /chat و handleUpdateTasks
 * - كاش LRU TTL للقراءات من Firestore
 * - retries مع exponential backoff للنماذج والعمليات الحساسة
 * - تحليل JSON مُحسّن من مخرجات النماذج
 * - نقاط نهاية: /chat, /update-daily-tasks, /generate-daily-tasks, /generate-title, /health
 * - عمليات خلفية غير محظورة (setImmediate)
 * - graceful shutdown، logging محسّن
 *
 * ملاحظة: تأكد من ضبط المتغيرات البيئية:
 * - GOOGLE_API_KEY
 * - FIREBASE_SERVICE_ACCOUNT_KEY (base64-encoded JSON أو raw JSON)
 * - PORT, REQUEST_TIMEOUT_MS, CACHE_TTL_MS, MAX_MODEL_RETRIES إن رغبت
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIG ---
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  CHAT_MODEL: process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash',
  TITLE_MODEL: process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite',
  TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  CACHE_TTL: Number(process.env.CACHE_TTL_MS || 30 * 1000), // 30s
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
  BODY_LIMIT: process.env.BODY_LIMIT || '200kb',
  SHUTDOWN_TIMEOUT: Number(process.env.SHUTDOWN_TIMEOUT || 10000),
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

// --- Simple LRU TTL Cache (in-memory, non-distributed) ---
class LRUCache {
  constructor(limit = 500, ttl = CONFIG.CACHE_TTL) {
    this.limit = limit;
    this.ttl = ttl;
    this.map = new Map(); // preserves insertion order
  }
  _isExpired(entry) {
    return Date.now() - entry.t > this.ttl;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (this._isExpired(e)) {
      this.map.delete(key);
      return null;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  set(key, value) {
    if (this.map.size >= this.limit) {
      // remove oldest
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { v: value, t: Date.now() });
  }
  del(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const cache = {
  profile: new LRUCache(500, CONFIG.CACHE_TTL),
  progress: new LRUCache(500, CONFIG.CACHE_TTL),
};

// --- FIREBASE INIT (robust parsing for service account key) ---
let db;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount;

  // Try: raw JSON, repaired JSON with escaped newlines, base64
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e1) {
    try {
      const repaired = raw.replace(/\r?\n/g, '\\n');
      serviceAccount = JSON.parse(repaired);
    } catch (e2) {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
      } catch (e3) {
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', e3.message || e3);
        throw e3;
      }
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
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

// --- Metrics (simple) ---
const metrics = {
  requests: 0,
  errors: 0,
  avgLatencyMs: 0,
};
function observeLatency(latMs) {
  const n = metrics.requests;
  metrics.avgLatencyMs = n === 0 ? latMs : Math.round(((metrics.avgLatencyMs * n) + latMs) / (n + 1));
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

// retry with exponential backoff
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

// Extract text from various model result shapes (robust)
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

    if (Array.isArray(resp.content) && resp.content.length) {
      return resp.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    }

    if (Array.isArray(resp.candidates) && resp.candidates.length) {
      return resp.candidates.map((c) => c?.text || '').join('').trim();
    }

    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

// Robust JSON extractor: finds first JSON object and tries basic repairs
function parseJSONFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0];

  // strip fenced blocks and common markup
  candidate = candidate.replace(/```(?:json)?/g, '').trim();

  // remove trailing commas before } or ]
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // last attempt: remove suspicious control chars
    const cleaned = candidate.replace(/[\u0000-\u001F]+/g, '');
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      return null;
    }
  }
}

// safe prompt escape
function escapeForPrompt(s) {
  if (!s) return '';
  return String(s).replace(/<\/+/g, '<\\/').replace(/"/g, '\\"');
}

// snippet limiter
function safeSnippet(text, max = 6000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n... [truncated]';
}

// --- Local fast language detection (cheap) with model fallback ---
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

// --- Firestore helpers with caching (V12 style) ---
async function getProfile(userId) {
  try {
    const key = `profile:${userId}`;
    const cached = cache.profile.get(key);
    if (cached) return cached;
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = doc.exists && doc.data()?.profileSummary ? String(doc.data().profileSummary) : 'No available memory.';
    cache.profile.set(key, val);
    return val;
  } catch (err) {
    console.error(`Error fetching memory profile for ${userId}:`, err && err.message ? err.message : err);
    return 'No available memory.';
  }
}

async function getProgress(userId) {
  try {
    const key = `progress:${userId}`;
    const cached = cache.progress.get(key);
    if (cached) return cached;
    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) {
      const data = doc.data() || {};
      cache.progress.set(key, data);
      return data;
    }
  } catch (err) {
    console.error(`Error fetching progress for ${userId}:`, err && err.message ? err.message : err);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
}

// fetch lesson content (straightforward)
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

// fetch weaknesses (V11 logic)
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
            weaknesses.push({
              lessonId,
              subjectId,
              masteryScore,
              suggestedReview: lessonData.suggestedReview || 'Review needed',
            });
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

// --- Business logic (merged intelligence) ---

// Allowed task types (V11 extended)
const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);

/**
 * handleUpdateTasks
 * - uses V11-style detailed prompt and strict "type" rule
 * - saves with merge and invalidates cache
 */
async function handleUpdateTasks({ userId, userRequest }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');
  console.log(`[${iso()}] 🔧 handleUpdateTasks for user=${userId}`);

  // read current tasks (single read)
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

    // Normalize tasks
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

    // save using merge
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    // invalidate caches
    cache.progress.del(`progress:${userId}`);

    console.log(`[${iso()}] ✅ Updated tasks for user=${userId}. New count: ${normalized.length}`);
    return normalized;
  } catch (err) {
    console.error('handleUpdateTasks error:', err && err.message ? err.message : err);
    throw err;
  }
}

/**
 * handleGenerateDailyTasks
 * - uses weaknesses (V11) to ask model to generate tasks
 * - fallback to safe tasks on failure
 */
async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID is required');
  console.log(`[${iso()}] 📅 handleGenerateDailyTasks for ${userId}`);

  try {
    const weaknesses = await fetchUserWeaknesses(userId);
    const weaknessesPrompt = weaknesses.length > 0
      ? `<user_weaknesses>\n${weaknesses.map(w => `- Lesson ID: ${w.lessonId}, Subject: ${w.subjectId}, Mastery: ${w.masteryScore}%`).join('\n')}\n</user_weaknesses>`
      : '<user_weaknesses>User has no specific weaknesses. Suggest a new lesson.</user_weaknesses>';

    const taskPrompt = `
<role>You are an expert academic planner. Generate a personalized daily study plan. Respond ONLY with a valid JSON object: { "tasks": [...] }.</role>
${weaknessesPrompt}
<instructions>
1. Create 3-4 tasks based on weaknesses.
2. Titles must be in Arabic.
3. Each task needs: id, title, type, status ('pending'), relatedLessonId, and relatedSubjectId.
</instructions>
`.trim();

    const modelCall = () => chatModel.generateContent(taskPrompt);
    const raw = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'task generation'));
    const rawText = await extractTextFromResult(raw);
    const parsed = parseJSONFromText(rawText);

    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('Model did not return a valid tasks array.');

    const tasksToSave = parsed.tasks.slice(0, 6).map((task) => ({
      ...task,
      id: task.id || (String(Date.now()) + Math.random().toString(36).substring(7)),
      status: task.status || 'pending',
      type: VALID_TASK_TYPES.has((task.type || '').toString().toLowerCase()) ? (task.type || '').toString().toLowerCase() : 'review',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    cache.progress.del(`progress:${userId}`);

    console.log(`[${iso()}] ✅ Generated ${tasksToSave.length} tasks for ${userId}`);
    return tasksToSave;
  } catch (err) {
    console.error('handleGenerateDailyTasks error:', err && err.message ? err.message : err);
    // fallback
    const fallbackTasks = [{
      id: String(Date.now()),
      title: 'مراجعة سريعة',
      type: 'review',
      status: 'pending',
      relatedLessonId: null,
      relatedSubjectId: null,
      description: 'قم بمراجعة سريعة لموضوع مهم لمدة 30 دقيقة.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }];
    try {
      await db.collection('userProgress').doc(userId).set({
        dailyTasks: { tasks: fallbackTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
      }, { merge: true });
      cache.progress.del(`progress:${userId}`);
    } catch (saveErr) {
      console.error('⚠️ Failed to save fallback task:', saveErr && saveErr.message ? saveErr.message : saveErr);
    }
    return fallbackTasks;
  }
}

// ----------------- ROUTES -----------------

/**
 * /chat
 * - uses V11-style full prompt (context, profile, dynamic data)
 * - detects manage_tasks action via JSON returned by model
 */
app.post('/chat', async (req, res) => {
  const start = Date.now();
  metrics.requests += 1;

  try {
    const { userId, message, history = [], lessonId = null } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    const [profile, progress, detectedLang] = await Promise.all([
      getProfile(userId),
      getProgress(userId),
      detectLanguage(message),
    ]);

    const safeMessage = safeSnippet(message, 6000);
    const formattedHistory = (history || []).slice(-5).map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${String(h.text || '').replace(/\n/g, ' ')}`).join('\n');

    const finalPrompt = `
<role>
You are 'EduAI' (nickname: "owl"), a smart, warm, and empathetic study companion. Speak naturally and emotionally, not robotic.
</role>

<user_profile>
  <dynamic_data>
    - Current Points: ${Number(progress.stats?.points || 0)}
    - Daily Streak: ${Number(progress.streakCount || 0)}
  </dynamic_data>
  <static_memory>
    ${escapeForPrompt(safeSnippet(profile || '', 1000))}
  </static_memory>
</user_profile>

<conversation_context>
${formattedHistory || 'This is a new conversation.'}
User: ${escapeForPrompt(safeMessage)}
</conversation_context>

<capabilities>
If the user's message is a command about managing tasks, respond ONLY with this JSON:
{ "action": "manage_tasks", "userRequest": "<the user's full request>" }
Otherwise, reply normally in ${detectedLang}.
</capabilities>
`.trim();

    const modelCall = () => chatModel.generateContent(finalPrompt);
    const modelRes = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'chat model'));
    const rawReply = await extractTextFromResult(modelRes);

    // Try to extract JSON action
    let actionResponse = null;
    try {
      const parsed = parseJSONFromText((rawReply || '').trim());
      if (parsed && parsed.action === 'manage_tasks' && parsed.userRequest) actionResponse = parsed;
    } catch (e) { actionResponse = null; }

    if (actionResponse) {
      console.log(`[${iso()}] 🧠 Action detected for ${userId}: manage_tasks`);
      // background update (non-blocking)
      setImmediate(() => {
        handleUpdateTasks({ userId, userRequest: actionResponse.userRequest }).catch(err => {
          console.error(`[${iso()}] ❌ Background task update failed for ${userId}:`, err && err.message ? err.message : err);
        });
      });
      const confirmationMessage = "بالتأكيد! أنا أعمل على تحديث مهامك الآن. ستراها في شاشتك الرئيسية بعد لحظات.";
      res.json({ reply: confirmationMessage });
      observeLatency(Date.now() - start);
      return;
    }

    res.json({ reply: rawReply || "لم أستطع توليد رد مناسب." });
    observeLatency(Date.now() - start);
  } catch (err) {
    metrics.errors += 1;
    console.error(`[${iso()}] ❌ /chat error:`, err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Model request timed out.' });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * /update-daily-tasks
 * HTTP wrapper that delegates to internal handler
 */
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

/**
 * /generate-daily-tasks
 * uses user weaknesses to generate a daily plan
 */
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    const tasks = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, tasks });
  } catch (err) {
    console.error(`[${iso()}] ❌ Error in /generate-daily-tasks:`, err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

/**
 * /generate-title
 * small utility endpoint to produce a short chat title
 */
app.post('/generate-title', async (req, res) => {
  const { message, language } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  try {
    const lang = language || 'Arabic';
    const prompt = `Summarize this message into a short, engaging chat title in ${lang}. Respond with ONLY the title text. Message: "${escapeForPrompt(safeSnippet(message, 1000))}"`;
    const modelCall = () => titleModel.generateContent(prompt);
    const modelRes = await retry(() => withTimeout(modelCall(), CONFIG.TIMEOUT_MS, 'title generation'));
    const titleText = await extractTextFromResult(modelRes);
    res.json({ title: (titleText || '').trim() });
  } catch (err) {
    console.error(`[${iso()}] ❌ Title generation failed:`, err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to generate title.' });
  }
});

/**
 * Health + metrics
 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    metrics,
    time: iso(),
  });
});

// --- Graceful shutdown ---
let server = null;
function shutdown(signal) {
  console.log(`[${iso()}] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log(`[${iso()}] HTTP server closed.`);
      process.exit(0);
    });
    setTimeout(() => {
      console.warn(`[${iso()}] Forcing shutdown.`);
      process.exit(1);
    }, CONFIG.SHUTDOWN_TIMEOUT).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Start server ---
server = app.listen(CONFIG.PORT, () => {
  console.log(`🚀 EduAI Brain V12.1 running on port ${CONFIG.PORT}`);
  console.log(`💬 Chat model: ${CONFIG.CHAT_MODEL}`);
  console.log(`🏷️ Title model: ${CONFIG.TITLE_MODEL}`);
});

// Export for tests / using internal handlers
module.exports = {
  app,
  handleUpdateTasks,
  handleGenerateDailyTasks,
  getProgress,
  getProfile,
};
