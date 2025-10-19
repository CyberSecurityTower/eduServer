'use strict';

/**
 * EduAI Brain V11 — High performance, production-ready server.js
 * تحسينات مُركزة على الأداء، الكفاءة، والموثوقية
 * - Caching (in-memory TTL)
 * - Local fast language detection (cheap) + model fallback
 * - Internal background handlers (no localhost fetch)
 * - Robust JSON extraction from model outputs
 * - Graceful shutdown and basic metrics
 * - Safer Firestore writes (set with merge)
 * - Retries for transient model / Firestore errors
 *
 * ملاحظة: هذه النسخة لا تعتمد على مكتبات خارجية إضافية.
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
// node-fetch is not required for internal calls anymore. If you need external HTTP requests, add it.

// --- Configuration ---
const PORT = Number(process.env.PORT || 3000);
const CHAT_MODEL_NAME = process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash';
const TITLE_MODEL_NAME = process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);
const BODY_LIMIT = process.env.BODY_LIMIT || '150kb';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 1000); // 30s default cache
const MAX_MODEL_RETRIES = Number(process.env.MAX_MODEL_RETRIES || 2);
const SHUTDOWN_TIMEOUT = Number(process.env.SHUTDOWN_TIMEOUT || 10000);

// --- Basic env checks ---
if (!process.env.GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY env var.');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var.');
  process.exit(1);
}

// --- Express Init ---
const app = express();
app.use(cors());
app.use(express.json({ limit: BODY_LIMIT }));

// --- Simple in-memory TTL cache (not clustered) ---
class TTLCache {
  constructor(ttl = CACHE_TTL_MS) {
    this.ttl = ttl;
    this.map = new Map();
  }
  get(key) {
    const ent = this.map.get(key);
    if (!ent) return null;
    if (Date.now() - ent.ts > this.ttl) {
      this.map.delete(key);
      return null;
    }
    return ent.value;
  }
  set(key, value) {
    this.map.set(key, { value, ts: Date.now() });
  }
  del(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const profileCache = new TTLCache();
const progressCache = new TTLCache();

// --- Firebase Init (robust parsing) ---
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
  chatModel = genAI.getGenerativeModel({ model: CHAT_MODEL_NAME });
  titleModel = genAI.getGenerativeModel({ model: TITLE_MODEL_NAME });
  console.log(`🤖 AI initialized (Chat: ${CHAT_MODEL_NAME}, Title: ${TITLE_MODEL_NAME})`);
} catch (err) {
  console.error('❌ GoogleGenerativeAI init failed:', err && err.message ? err.message : err);
  process.exit(1);
}

// --- Metrics (in-memory, simple) ---
const metrics = {
  requests: 0,
  errors: 0,
  avgLatencyMs: 0,
};

function observeLatency(latMs) {
  const n = metrics.requests;
  metrics.avgLatencyMs = n === 0 ? latMs : Math.round(((metrics.avgLatencyMs * n) + latMs) / (n + 1));
}

// --- Helpers ---
function nowIso() { return new Date().toISOString(); }

async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    // result might be a promise or contain response-like object
    const resp = result.response ? await result.response : result;

    if (!resp) return '';

    // If it's a fetch-like response
    if (resp && typeof resp.text === 'function') {
      const t = await resp.text();
      return (t || '').toString().trim();
    }

    // direct string fields
    if (typeof resp.text === 'string' && resp.text.trim()) return resp.text.trim();
    if (typeof resp.outputText === 'string' && resp.outputText.trim()) return resp.outputText.trim();

    // content arrays
    if (Array.isArray(resp.content) && resp.content.length) {
      return resp.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    }
    if (Array.isArray(resp.candidates) && resp.candidates.length) {
      return resp.candidates.map(c => c?.text || '').join('').trim();
    }

    // fallback to string conversion
    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function safeSnippet(text, max = 6000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n... [truncated]';
}

function escapeForPrompt(s) {
  if (!s) return '';
  return String(s).replace(/<\//g, '<\\/').replace(/"/g, '\\"');
}

function sanitizeLanguage(langCandidate) {
  if (!langCandidate || typeof langCandidate !== 'string') return 'Arabic';
  const token = langCandidate.split(/[^a-zA-Z]+/).find(Boolean);
  if (!token) return 'Arabic';
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

// Robust JSON extractor: finds the first JSON object in text
function parseJSONFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    // try to repair common issues (backticks, trailing commas)
    let cleaned = match[0].replace(/```json|```/g, '').trim();
    cleaned = cleaned.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

// Small retry helper for async operations
async function retry(fn, attempts = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// --- Fast local language detection (cheap) ---
function detectLanguageLocal(text) {
  if (!text || typeof text !== 'string') return null;
  // If contains many Arabic letters => Arabic
  const arabicMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || [];
  if (arabicMatches.length / Math.max(1, text.length) > 0.02) return 'Arabic';
  // If contains many latin letters => English
  const latinMatches = text.match(/[a-zA-Z]/g) || [];
  if (latinMatches.length / Math.max(1, text.length) > 0.02) return 'English';
  return null; // uncertain
}

async function detectLanguage(message) {
  try {
    const local = detectLanguageLocal(message);
    if (local) return local;
    // fallback to cheap model call (titleModel)
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., \"Arabic\", \"English\", \"French\"). Text: "${(message || '').replace(/"/g, '\\"')}"`;

    const rawResult = await withTimeout(titleModel.generateContent(prompt), REQUEST_TIMEOUT_MS, 'language detection');
    const rawText = await extractTextFromResult(rawResult);
    return sanitizeLanguage(rawText);
  } catch (err) {
    console.error('Language detection failed, fallback to Arabic:', err && err.message ? err.message : err);
    return 'Arabic';
  }
}

// --- Firestore helpers with caching ---
async function fetchMemoryProfile(userId) {
  try {
    const cacheKey = `profile:${userId}`;
    const cached = profileCache.get(cacheKey);
    if (cached) return cached;

    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = doc.exists && doc.data()?.profileSummary ? String(doc.data().profileSummary) : 'No available memory.';
    profileCache.set(cacheKey, val);
    return val;
  } catch (err) {
    console.error(`Error fetching memory profile for ${userId}:`, err && err.message ? err.message : err);
    return 'No available memory.';
  }
}

async function fetchUserProgress(userId) {
  try {
    const cacheKey = `progress:${userId}`;
    const cached = progressCache.get(cacheKey);
    if (cached) return cached;

    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() || {};
      const out = {
        points: d.stats?.points || 0,
        streak: d.streakCount || 0,
        fullDoc: d,
      };
      progressCache.set(cacheKey, out);
      return out;
    }
  } catch (err) {
    console.error(`Error fetching progress for ${userId}:`, err && err.message ? err.message : err);
  }
  return { points: 0, streak: 0, fullDoc: {} };
}

async function fetchLessonContent(lessonId) {
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
    const progressDoc = await db.collection('userProgress').doc(userId).get();
    if (!progressDoc.exists) return [];
    const progressData = progressDoc.data()?.pathProgress || {};
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

// --- Internal business logic (callable directly, no HTTP) ---

// Valid task types
const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson']);

async function handleUpdateDailyTasks({ userId, userRequest }) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required');

  console.log(`[${nowIso()}] 🔧 handleUpdateDailyTasks for user=${userId}`);

  try {
    // fetch current tasks (one read)
    const progressDoc = await db.collection('userProgress').doc(userId).get();
    const currentTasks = progressDoc.exists ? (progressDoc.data().dailyTasks?.tasks || []) : [];

    const modificationPrompt = `
<role>You are an intelligent task manager. Modify a user's task list based on their request. Respond ONLY with a valid JSON object: { "tasks": [...] }.</role>
<current_tasks>${JSON.stringify(currentTasks)}</current_tasks>
<user_request>"${escapeForPrompt(userRequest)}"</user_request>
<instructions>
Modify the list. Titles must be in Arabic. Maintain all required fields.
CRITICAL: Use one of these exact strings for the "type" field: 'review', 'quiz', 'new_lesson'.
</instructions>
`.trim();

    const modelCall = () => chatModel.generateContent(modificationPrompt);

    const rawRes = await retry(() => withTimeout(modelCall(), REQUEST_TIMEOUT_MS, 'task modification'), MAX_MODEL_RETRIES, 500);
    const rawText = await extractTextFromResult(rawRes);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('Model did not return valid tasks array');

    // normalize and enforce types/fields
    const normalized = parsed.tasks.map(t => {
      const type = (t.type || '').toString().toLowerCase();
      return {
        id: t.id || (String(Date.now()) + Math.random().toString(36).slice(2, 9)),
        title: t.title || (t.name || 'مهمة جديدة'),
        type: VALID_TASK_TYPES.has(type) ? type : 'review',
        status: t.status || 'pending',
        relatedLessonId: t.relatedLessonId || null,
        relatedSubjectId: t.relatedSubjectId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });

    // save (merge to avoid overwriting other fields)
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: normalized, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });

    // invalidate cache
    progressCache.del(`progress:${userId}`);

    console.log(`[${nowIso()}] ✅ Updated daily tasks for ${userId} (count=${normalized.length})`);
    return normalized;
  } catch (err) {
    console.error('handleUpdateDailyTasks error:', err && err.message ? err.message : err);
    throw err;
  }
}

async function handleGenerateDailyTasks(userId) {
  if (!userId) throw new Error('User ID is required');

  console.log(`[${nowIso()}] 📅 handleGenerateDailyTasks for ${userId}`);

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

    const rawRes = await retry(() => withTimeout(modelCall(), REQUEST_TIMEOUT_MS, 'task generation'), MAX_MODEL_RETRIES, 700);
    const rawText = await extractTextFromResult(rawRes);
    const parsed = parseJSONFromText(rawText);
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('Model did not return a valid tasks array.');

    const tasksToSave = parsed.tasks.slice(0, 6).map(task => ({
      ...task,
      id: task.id || (String(Date.now()) + Math.random().toString(36).substring(7)),
      status: task.status || 'pending',
      type: VALID_TASK_TYPES.has((task.type || '').toString().toLowerCase()) ? (task.type || '').toString().toLowerCase() : 'review',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));

    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });

    progressCache.del(`progress:${userId}`);

    console.log(`[${nowIso()}] ✅ Generated ${tasksToSave.length} tasks for ${userId}`);
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
        dailyTasks: { tasks: fallbackTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
      }, { merge: true });
      progressCache.del(`progress:${userId}`);
    } catch (saveErr) {
      console.error('⚠️ Failed to save fallback task:', saveErr && saveErr.message ? saveErr.message : saveErr);
    }
    return fallbackTasks;
  }
}

// --- Endpoints ---

app.post('/chat', async (req, res) => {
  const start = Date.now();
  metrics.requests += 1;

  try {
    const { userId, message, history = [], lessonId = null } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    // gather context (parallel)
    const [memorySummary, userProgress, detectedLangRaw, lessonContentRaw] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message),
      lessonId ? fetchLessonContent(lessonId) : Promise.resolve(null),
    ]);

    const detectedLang = sanitizeLanguage(detectedLangRaw);
    const safeMessage = escapeForPrompt(safeSnippet(message));
    const formattedHistory = (history || []).slice(-8).map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${String(h.text || '').replace(/\n/g, ' ')}`).join('\n');

    const finalPrompt = `
<role>
You are 'EduAI' (nickname: "owl"), a smart, warm, and empathetic study companion. Speak naturally and emotionally, not robotic.
</role>

<user_profile>
  <dynamic_data>
    - Current Points: ${Number(userProgress.points || 0)}
    - Daily Streak: ${Number(userProgress.streak || 0)}
  </dynamic_data>
  <static_memory>
    ${escapeForPrompt(safeSnippet(memorySummary || '', 1000))}
  </static_memory>
</user_profile>

<conversation_context>
${formattedHistory || 'This is a new conversation.'}
User: ${safeMessage}
</conversation_context>

<capabilities>
If the user's message is a command about managing tasks, respond ONLY with this JSON:
{ "action": "manage_tasks", "userRequest": "<the user's full request>" }
Otherwise, reply normally in ${detectedLang}.
</capabilities>
`.trim();

    // call model with retry
    const modelCall = () => chatModel.generateContent(finalPrompt);
    const modelResult = await retry(() => withTimeout(modelCall(), REQUEST_TIMEOUT_MS, 'chat model'), MAX_MODEL_RETRIES, 500);
    const rawReply = await extractTextFromResult(modelResult);

    // Try to parse JSON action
    let actionResponse = null;
    try {
      const parsed = parseJSONFromText((rawReply || '').trim());
      if (parsed && parsed.action === 'manage_tasks' && parsed.userRequest) actionResponse = parsed;
    } catch (e) {
      actionResponse = null;
    }

    if (actionResponse) {
      console.log(`[${nowIso()}] 🧠 Action detected for ${userId}: manage_tasks`);
      // trigger background update (non-blocking)
      setImmediate(() => {
        handleUpdateDailyTasks({ userId, userRequest: actionResponse.userRequest }).catch(err => {
          console.error('Background task update failed:', err && err.message ? err.message : err);
        });
      });

      const confirmationMessage = 'بالتأكيد! أنا أعدِّل مهامك الآن وسأعطيك تأكيدًا عندما تُحدَّث المهام.';
      res.json({ reply: confirmationMessage });
      observeLatency(Date.now() - start);
      return;
    }

    res.json({ reply: rawReply || 'لم أستطع توليد رد مناسب.' });
    observeLatency(Date.now() - start);
  } catch (err) {
    metrics.errors += 1;
    console.error('❌ /chat error:', err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Model request timed out.' });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Update daily tasks (HTTP wrapper) — delegates to internal handler
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body || {};
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });

    const updated = await handleUpdateDailyTasks({ userId, userRequest });
    return res.status(200).json({ success: true, tasks: updated });
  } catch (err) {
    console.error('❌ Error in /update-daily-tasks:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to update daily tasks.' });
  }
});

// Generate daily tasks endpoint
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    const tasks = await handleGenerateDailyTasks(userId);
    return res.status(200).json({ success: true, tasks });
  } catch (err) {
    console.error('❌ Error in /generate-daily-tasks:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

// --- Health + metrics endpoint ---
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development', metrics });
});

// --- Graceful shutdown ---
let server = null;
function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('Forcing shutdown.');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Start Server ---
server = app.listen(PORT, () => {
  console.log(`🚀 EduAI Brain V11 running on port ${PORT}`);
  console.log(`💬 Chat model: ${CHAT_MODEL_NAME}`);
  console.log(`🏷️ Title model: ${TITLE_MODEL_NAME}`);
});

// Export handlers for testing / reuse
module.exports = {
  app,
  handleUpdateDailyTasks,
  handleGenerateDailyTasks,
  fetchUserProgress,
  fetchMemoryProfile,
};
