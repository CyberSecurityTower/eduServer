'use strict';

/**
 * server_merged_v18_final.js — EduAI Brain V18.0 (Final Integrated)
 *
 * - Merges V18.0 features and restores missing manager implementations
 *   (review, notification, todo, planner, job worker, enqueue).
 * - Includes LRUCache fixes and robust extractTextFromResult.
 * - Health, /chat route, background job worker, and graceful shutdown.
 *
 * Required env:
 * - FIREBASE_SERVICE_ACCOUNT_KEY
 * - GOOGLE_API_KEY or GOOGLE_API_KEY_1 .. GOOGLE_API_KEY_5
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
    chat: process.env.MODEL_CHAT || 'gemini-2.5-pro',
    todo: process.env.MODEL_TODO || 'gemini-2.5-flash',
    planner: process.env.MODEL_PLANNER || 'gemini-2.5-flash',
    titleIntent: process.env.MODEL_TITLE || 'gemini-2.5-flash-lite',
    notification: process.env.MODEL_NOTIFICATION || 'gemini-2.5-flash-lite',
    review: process.env.MODEL_REVIEW || 'gemini-2.5-flash',
    analysis: process.env.MODEL_ANALYSIS || 'gemini-2.5-flash-lite',
  },
  TIMEOUTS: {
    default: Number(process.env.TIMEOUT_DEFAULT_MS || 25000),
    chat: Number(process.env.TIMEOUT_CHAT_MS || 30000),
    notification: Number(process.env.TIMEOUT_NOTIFICATION_MS || 7000),
    review: Number(process.env.TIMEOUT_REVIEW_MS || 20000),
    analysis: Number(process.env.TIMEOUT_ANALYSIS_MS || 24000),
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

const apiKeyCandidates = Array.from({ length: 5 }, (_, i) => process.env[`GOOGLE_API_KEY_${i + 1}`]).filter(Boolean);
if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
if (apiKeyCandidates.length === 0) {
  console.error('No Google API keys found (GOOGLE_API_KEY or GOOGLE_API_KEY_1..5). Exiting.');
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
  console.error('❌ Firebase init failed:', err.message || err);
  process.exit(1);
}

// ---------------- MODEL POOLS & KEY HEALTH ----------------
const poolNames = ['chat', 'todo', 'planner', 'titleIntent', 'notification', 'review', 'analysis'];
const modelPools = poolNames.reduce((acc, p) => ({ ...acc, [p]: [] }), {});
const keyStates = {};

for (const key of apiKeyCandidates) {
  try {
    const client = new GoogleGenerativeAI(key);
    keyStates[key] = { fails: 0, backoffUntil: 0 };
    for (const pool of poolNames) {
      try {
        const instance = client.getGenerativeModel({ model: CONFIG.MODEL[pool] });
        modelPools[pool].push({ model: instance, key });
      } catch (e) {
        console.warn(`Failed to create model instance for pool ${pool} with key:`, e.message);
      }
    }
  } catch (e) {
    console.warn('GoogleGenerativeAI init failed for a key:', e.message);
  }
}
poolNames.forEach(p => {
  if (!modelPools[p] || modelPools[p].length === 0) {
    console.error(`Model pool "${p}" is empty. Check API keys & model names. Requires: ${CONFIG.MODEL[p]}`);
    process.exit(1);
  }
});
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
      if (keyStates[inst.key]?.backoffUntil > Date.now()) continue;
      const res = await withTimeout(inst.model.generateContent(prompt), timeoutMs, `${label} (key:${inst.key.slice(-4)})`);
      keyStates[inst.key].fails = 0;
      return res;
    } catch (err) {
      lastErr = err;
      if (inst.key && keyStates[inst.key]) {
        const fails = (keyStates[inst.key].fails || 0) + 1;
        const backoff = Math.min(1000 * (2 ** fails), 10 * 60 * 1000);
        keyStates[inst.key] = { fails, backoffUntil: Date.now() + backoff };
        console.warn(`${iso()} ${label} failed for key (fails=${fails}), backoff ${backoff}ms:`, err.message);
      } else {
        console.warn(`${iso()} ${label} failed for an instance:`, err.message);
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
      if (t) return String(t).trim();
    }

    if (typeof result === 'string') return result.trim();
    if (result.text && typeof result.text === 'string') return result.text.trim();
    if (result.outputText && typeof result.outputText === 'string') return result.outputText.trim();
    if (result.output && typeof result.output === 'string') return result.output.trim();
    if (result.data && typeof result.data === 'string') return result.data.trim();

    if (Array.isArray(result.output)) {
      const collected = [];
      for (const block of result.output) {
        if (block.content && Array.isArray(block.content)) {
          for (const c of block.content) {
            if (typeof c.text === 'string' && c.text.trim()) collected.push(c.text.trim());
            else if (c.parts && Array.isArray(c.parts)) collected.push(c.parts.join('').trim());
          }
        } else if (typeof block.text === 'string' && block.text.trim()) {
          collected.push(block.text.trim());
        }
      }
      if (collected.length) return collected.join('\n').trim();
    }

    if (result.candidates && Array.isArray(result.candidates) && result.candidates.length) {
      const candTexts = result.candidates.map(c => {
        if (typeof c.text === 'string') return c.text;
        if (c.message && c.message.content && Array.isArray(c.message.content)) {
          return c.message.content.map(cc => cc.text || (cc.parts && cc.parts.join(''))).filter(Boolean).join('');
        }
        return '';
      }).filter(Boolean);
      if (candTexts.length) return candTexts.join('\n').trim();
    }

    if (result.output && result.output[0] && result.output[0].content) {
      const parts = result.output[0].content.map(c => c.text || (c.parts && c.parts.join(''))).filter(Boolean);
      if (parts.length) return parts.join('\n').trim();
    }

   let dumped = '';
try {
  dumped = JSON.stringify(result);
} catch (e) {
  try {
    dumped = String(result);
  } catch (e2) {
    dumped = '';
  }
}
return dumped ? dumped.slice(0, 2000) : '';

  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

function parseJSONFromText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    let candidate = match[0].replace(/```(?:json)?/g, '').trim();
    candidate = candidate.replace(/,\s*([}\]])/g, '$1'); // Fix trailing commas
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
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
async function cacheGet(scope, key) { return localCache[scope]?.get(key); }
async function cacheSet(scope, key, value) { localCache[scope]?.set(key, value); }
async function cacheDel(scope, key) { localCache[scope]?.del(key); }

// ---------------- DATA HELPERS ----------------
async function getUserDisplayName(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    if (userData.displayName?.trim()) return userData.displayName.split(' ')[0];
    if (userData.firstName?.trim()) return userData.firstName;
    return null;
  } catch (err) {
    console.error(`Error fetching user display name for ${userId}:`, err.message);
    return null;
  }
}

async function formatProgressForAI(userId) {
  try {
    const userProgressDoc = await db.collection('userProgress').doc(userId).get();
    if (!userProgressDoc.exists) return 'No progress data found.';
    const userProgressData = userProgressDoc.data()?.pathProgress || {};
    if (Object.keys(userProgressData).length === 0) return 'User has not started any educational path yet.';

    const summaryLines = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathDoc = await db.collection('educationalPaths').doc(pathId).get();
        pathDataCache.set(pathId, pathDoc.exists ? pathDoc.data() : null);
      }
      const educationalPath = pathDataCache.get(pathId);
      if (!educationalPath) continue;

      const subjectsProgress = userProgressData[pathId]?.subjects || {};
      for (const subjectId in subjectsProgress) {
        const subjectData = educationalPath.subjects?.find(s => s.id === subjectId);
        const subjectTitle = subjectData?.title || subjectId;
        const masteryScore = subjectsProgress[subjectId]?.masteryScore || 0;
        summaryLines.push(`- Subject: "${subjectTitle}", Mastery: ${masteryScore}%`);
      }
    }
    return summaryLines.length > 0 ? summaryLines.join('\n') : 'No specific subject progress to show.';
  } catch (err) {
    console.error('Error in formatProgressForAI:', err.stack);
    return 'Could not format user progress.';
  }
}

async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    const val = doc.exists ? String(doc.data()?.profileSummary || 'No available memory.') : 'No available memory.';
    await cacheSet('profile', userId, val);
    return val;
  } catch (err) {
    console.error('getProfile error:', err.message);
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
    console.error('getProgress error:', err.message);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
}

async function fetchUserWeaknesses(userId) {
  try {
    const userProgressDoc = await db.collection('userProgress').doc(userId).get();
    if (!userProgressDoc.exists) return [];
    const userProgressData = userProgressDoc.data()?.pathProgress || {};
    const weaknesses = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathDoc = await db.collection('educationalPaths').doc(pathId).get();
        pathDataCache.set(pathId, pathDoc.exists ? pathDoc.data() : null);
      }
      const educationalPath = pathDataCache.get(pathId);
      if (!educationalPath) continue;

      const subjectsProgress = userProgressData[pathId]?.subjects || {};
      for (const subjectId in subjectsProgress) {
        const lessonsProgress = subjectsProgress[subjectId]?.lessons || {};
        for (const lessonId in lessonsProgress) {
          const masteryScore = Number(lessonsProgress[lessonId]?.masteryScore || 0);
          if (masteryScore < 75) {
            const subjectData = educationalPath.subjects?.find(s => s.id === subjectId);
            const lessonData = subjectData?.lessons?.find(l => l.id === lessonId);
            weaknesses.push({
              lessonId, subjectId, masteryScore,
              lessonTitle: lessonData?.title || lessonId,
              subjectTitle: subjectData?.title || subjectId,
            });
          }
        }
      }
    }
    return weaknesses;
  } catch (err) {
    console.error('Critical error in fetchUserWeaknesses:', err.stack);
    return [];
  }
}

async function sendUserNotification(userId, payload) {
  try {
    await db.collection('userNotifications').doc(userId).collection('inbox').add({
      message: payload.message || '',
      meta: payload.meta || {},
      read: false,
      lang: payload.lang || 'Arabic',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('sendUserNotification write failed:', err.message);
  }
}

// ---------------- MANAGERS (restored + new) ----------------
async function runTrafficManager(message, lang = 'Arabic') {
  const prompt = `You are an expert intent classification system. Analyze the user's message and return a structured JSON object.\n<rules>\n1.  **Intent Classification:** Classify the intent into ONE of the following: 'analyze_performance', 'question', 'manage_todo', 'generate_plan', or 'unclear'.\n2.  **Title Generation:** Create a short title (2-4 words) in the detected language.\n3.  **Language Detection:** Identify the primary language (e.g., 'Arabic', 'English').\n4.  **Output Format:** Respond with ONLY a single, valid JSON object: { "intent": "...", "title": "...", "language": "..." }\n</rules>\nUser Message: "${escapeForPrompt(message)}"`;
  try {
    const res = await generateWithFailover('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'titleIntent');
    if (parsed?.intent) return parsed;
    console.warn(`TrafficManager fallback for: "${message}"`);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  } catch (err) {
    console.error('runTrafficManager critical failure:', err.message);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  }
}

// Review manager: score an assistant reply and provide feedback
async function runReviewManager(userMessage, assistantReply) {
  try {
    const prompt = `You are a quality reviewer. Rate the assistant reply from 1 to 10 and provide concise feedback to improve it. Return ONLY a JSON object {"score": number, "feedback": "..."}.\n\nUser Message:\n${escapeForPrompt(safeSnippet(userMessage, 2000))}\n\nAssistant Reply:\n${escapeForPrompt(safeSnippet(assistantReply, 4000))}`;
    const res = await generateWithFailover('review', prompt, { label: 'RunReview', timeoutMs: CONFIG.TIMEOUTS.review });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'review');
    if (parsed && typeof parsed.score === 'number') return parsed;
    // fallback minimal scoring
    return { score: 10, feedback: 'Good answer.' };
  } catch (err) {
    console.error('runReviewManager error:', err.message);
    return { score: 10, feedback: 'No review available.' };
  }
}

// Notification manager: produce quick acknowledgement or notification text
async function runNotificationManager(type = 'ack', language = 'Arabic') {
  try {
    if (type === 'ack') {
      const prompt = `Return a short acknowledgement in ${language} (max 12 words) confirming the user's action was received, e.g., \"تم استلام طلبك، جاري العمل عليه\". Return ONLY the sentence.`;
      const res = await generateWithFailover('notification', prompt, { label: 'NotificationAck', timeoutMs: CONFIG.TIMEOUTS.notification });
      const txt = await extractTextFromResult(res);
      return txt || (language === 'Arabic' ? 'تم الاستلام.' : 'Acknowledged.');
    }
    // other notification types could be handled here
    return language === 'Arabic' ? 'تمت المعالجة.' : 'Processed.';
  } catch (err) {
    console.error('runNotificationManager error:', err.message);
    return language === 'Arabic' ? 'تم الاستلام.' : 'Acknowledged.';
  }
}

// ToDo manager: interpret todo instructions and return an action summary (lightweight implementation)
async function runToDoManager(userId, message, extra = {}) {
  try {
    const prompt = `You are a task manager. The user (id: ${userId}) sent: "${escapeForPrompt(message)}".\nReturn a JSON object: {"action":"add|remove|update|none","task": {"title":"...","status":"pending|done"},"message":"user-facing message"}`;
    const res = await generateWithFailover('todo', prompt, { label: 'ToDoManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'todo');
    if (parsed) return parsed;
    return { action: 'none', task: null, message: 'Could not parse todo.' };
  } catch (err) {
    console.error('runToDoManager error:', err.message);
    return { action: 'none', task: null, message: 'Error processing todo.' };
  }
}

// Planner manager: create a simple study plan JSON
async function runPlannerManager(userId, message, weaknesses = []) {
  try {
    const prompt = `Create a short study plan (3-7 steps) for user ${userId} based on: ${escapeForPrompt(message)} and weaknesses: ${JSON.stringify(weaknesses.slice(0,5))}. Return ONLY a JSON {"plan":[{"title":"...","duration":"...","notes":"..."}]}`;
    const res = await generateWithFailover('planner', prompt, { label: 'PlannerManager', timeoutMs: CONFIG.TIMEOUTS.chat });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'planner');
    if (parsed) return parsed;
    return { plan: [] };
  } catch (err) {
    console.error('runPlannerManager error:', err.message);
    return { plan: [] };
  }
}

// ---------------- JOB QUEUE HELPERS & WORKER ----------------
async function enqueueJob(job) {
  try {
    const doc = await db.collection('jobs').add({
      ...job,
      status: 'queued',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return doc.id;
  } catch (err) {
    console.error('enqueueJob failed:', err.message);
    return null;
  }
}

let workerStopped = false;
async function processJob(jobDoc) {
  const id = jobDoc.id;
  const data = jobDoc.data();
  try {
    await jobDoc.ref.update({ status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() });
    const { userId, type, payload } = data;

    if (type === 'background_chat') {
      // payload.intent may guide the job
      if (payload.intent === 'manage_todo') {
        const todoResult = await runToDoManager(userId, payload.message, payload);
        // store result and notify user
        await jobDoc.ref.update({ result: todoResult, status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        await sendUserNotification(userId, { message: todoResult.message || 'Task processed', meta: { jobId: id } });
      } else if (payload.intent === 'generate_plan') {
        const plan = await runPlannerManager(userId, payload.message);
        await jobDoc.ref.update({ result: plan, status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        await sendUserNotification(userId, { message: 'تم إنشاء الخطة الدراسية.', meta: { plan, jobId: id } });
      } else {
        // default: generate an assistant reply and save
        const [userProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
          getProfile(userId), getProgress(userId), fetchUserWeaknesses(userId), formatProgressForAI(userId), getUserDisplayName(userId)
        ]);
        const reply = await handleGeneralQuestion(payload.message, payload.language || 'Arabic', payload.history || [], userProfile, userProgress, weaknesses, formattedProgress, userName);
        await jobDoc.ref.update({ result: { reply }, status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        await sendUserNotification(userId, { message: reply, meta: { jobId: id } });
      }
    } else {
      await jobDoc.ref.update({ status: 'skipped', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } catch (err) {
    console.error('processJob error for', id, err.message || err);
    const attempts = (data.attempts || 0) + 1;
    const update = { attempts, lastError: String(err.message || err), status: attempts >= 3 ? 'failed' : 'queued' };
    if (attempts >= 3) update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
    await jobDoc.ref.update(update);
  }
}

async function jobWorkerLoop() {
  if (workerStopped) return;
  try {
    const q = await db.collection('jobs').where('status', '==', 'queued').orderBy('createdAt').limit(5).get();
    if (!q.empty) {
      const promises = [];
      q.forEach(doc => { promises.push(processJob(doc)); });
      await Promise.all(promises);
    }
  } catch (err) {
    console.error('jobWorkerLoop error:', err.message || err);
  } finally {
    if (!workerStopped) setTimeout(jobWorkerLoop, CONFIG.JOB_POLL_MS);
  }
}

// start worker
setTimeout(jobWorkerLoop, 1000);

// ---------------- HANDLERS ----------------

async function handlePerformanceAnalysis(language, weaknesses = [], formattedProgress = '', tasksSummary = '', studentName = null) {
  const prompt = `You are an AI actor playing "EduAI," a warm, encouraging, and sharp academic advisor in a fictional simulation.\nYour task is to analyze academic data for a student and present a personalized, actionable performance review.\n\n<rules>\n1.  **Persona & Personalization:** Your tone MUST be positive and empowering.\n    *   **If a student name is provided ("${studentName || 'NONE'}"), you MUST address them by their name.**\n    *   **You MUST adapt your language (masculine/feminine grammatical forms in Arabic) to match the gender suggested by the name.**\n    *   **If no name is provided, use a welcoming, gender-neutral greeting** like "أهلاً بك! دعنا نلقي نظرة على أدائك..." and continue with gender-neutral language.\n\n2.  **CRITICAL RULE - NO IDs:** You are FORBIDDEN from ever displaying technical IDs like 'sub1'. You MUST ONLY use the human-readable subject and lesson titles provided.\n\n3.  **Structure the Analysis:** Present your analysis in three clear sections: "نقاط القوة", "مجالات تتطلب التطوير والتحسين", and "الخطوة التالية المقترحة".\n\n4.  **Language:** Respond ONLY in ${language}. Your language must be natural and encouraging.\n</rules>\n\n<simulation_data student_name="${studentName || 'Unknown'}">\n  <current_tasks>\n    ${tasksSummary}\n  </current_tasks>\n  <identified_weaknesses>\n    ${weaknesses.map(w => `- In subject "${w.subjectTitle}", the lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore || 0}%.`).join('\n')}\n  </identified_weaknesses>\n  <overall_subject_mastery>\n    ${formattedProgress}\n  </overall_subject_mastery>\n</simulation_data>\n\nYour personalized and encouraging analysis for ${studentName || 'the student'}:`;

  const modelResp = await generateWithFailover('chat', prompt, { label: 'AnalysisHandler', timeoutMs: CONFIG.TIMEOUTS.chat });
  return await extractTextFromResult(modelResp) || (language === 'Arabic' ? 'لم أتمكن من تحليل الأداء حاليًا.' : 'Could not analyze performance right now.');
}

async function handleGeneralQuestion(message, language, history = [], userProfile = 'No profile.', userProgress = {}, weaknesses = [], formattedProgress = '', studentName = null) {
  const lastFive = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`).join('\n');
  const tasksSummary = userProgress?.dailyTasks?.tasks?.length > 0 ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user currently has no tasks.';
  const weaknessesSummary = weaknesses.length > 0 ? `Identified Weaknesses:\n${weaknesses.map(w => `- In "${w.subjectTitle}", lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore}%.`).join('\n')}` : 'No specific weaknesses identified.';
  const gamificationSummary = `User Stats:\n- Points: ${userProgress?.stats?.points || 0}\n- Rank: "${userProgress?.stats?.rank || 'Beginner'}"\n- Current Streak: ${userProgress?.streakCount || 0} days`;

  const prompt = `You are EduAI, a specialized AI tutor. The information in <user_context> is YOUR MEMORY of the student. Use it to provide personalized, direct answers.\n\n<rules>\n1.  **Persona & Personalization:** Your tone is helpful and encouraging.\n    *   **If a student name is provided ("${studentName || 'NONE'}"), you may address them by their name in a friendly way.**\n    *   **Adapt your language (masculine/feminine forms in Arabic) to the gender suggested by the name.**\n    *   **If no name is provided, use gender-neutral language.**\n\n2.  **ABSOLUTE RULE:** You are FORBIDDEN from saying "I cannot access your data" or any similar phrase. The user's data (streak, points, etc.) IS provided below. Your primary job is to find it and report it when asked.\n\n3.  **Action:** For specific questions about points, streak, or tasks, locate the answer in the <user_context> and state it directly. For general knowledge questions, answer them helpfully.\n\n4.  **Language:** Your response MUST be in ${language}.\n</rules>\n\n<user_context student_name="${studentName || 'Unknown'}">\n  <gamification_stats>${gamificationSummary}</gamification_stats>\n  <learning_focus>${tasksSummary}\n${weaknessesSummary}</learning_focus>\n  <user_profile_summary>${safeSnippet(userProfile, 1000)}</user_profile_summary>\n  <detailed_progress_summary>${formattedProgress}</detailed_progress_summary>\n</user_context>\n\n<conversation_history>${lastFive}</conversation_history>\n\nThe user's new message is: "${escapeForPrompt(safeSnippet(message, 2000))}"\nYour response as EduAI:`;

  const modelResp = await generateWithFailover('chat', prompt, { label: 'ResponseManager', timeoutMs: CONFIG.TIMEOUTS.chat });
  let replyText = await extractTextFromResult(modelResp);

  // Optional: Review and refine the answer
  const review = await runReviewManager(message, replyText);
  if (review?.score < CONFIG.REVIEW_THRESHOLD) {
    const correctivePrompt = `Previous reply scored ${review.score}/10. Improve it based on: ${escapeForPrompt(review.feedback)}. User: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
    const res2 = await generateWithFailover('chat', correctivePrompt, { label: 'ResponseRetry', timeoutMs: CONFIG.TIMEOUTS.chat });
    replyText = (await extractTextFromResult(res2)) || replyText;
  }
  return replyText || (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن.' : 'I could not generate an answer right now.');
}

// ---------------- ROUTES ----------------
app.get('/health', (req, res) => {
  try {
    res.json({ ok: true, pools: Object.fromEntries(poolNames.map(p => [p, modelPools[p].length])), time: iso() });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/chat', async (req, res) => {
  try {
    const userId = req.body.userId;
    const { message, history = [] } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });

    const traffic = await runTrafficManager(message);
    const { language = 'Arabic', intent = 'unclear' } = traffic;

    if (intent === 'manage_todo' || intent === 'generate_plan') {
      const ack = await runNotificationManager('ack', language);
      const payload = { message, intent, language, pathId: req.body.pathId };
      const jobId = await enqueueJob({ userId, type: 'background_chat', payload });
      return res.json({ reply: ack, jobId, isAction: true });
    }

    const [userProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
      getProfile(userId), getProgress(userId), fetchUserWeaknesses(userId), formatProgressForAI(userId), getUserDisplayName(userId)
    ]);

    let reply;
    if (intent === 'analyze_performance') {
      const tasksSummary = userProgress?.dailyTasks?.tasks?.length > 0 ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user has no tasks.';
      reply = await handlePerformanceAnalysis(language, weaknesses, formattedProgress, tasksSummary, userName);
    } else {
      reply = await handleGeneralQuestion(message, language, history, userProfile, userProgress, weaknesses, formattedProgress, userName);
    }

    return res.json({ reply, isAction: false });
  } catch (err) {
    console.error('/chat error:', err.stack);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// endpoint to enqueue an arbitrary job (admin use)
app.post('/enqueue-job', async (req, res) => {
  try {
    const job = req.body;
    if (!job) return res.status(400).json({ error: 'job body required' });
    const id = await enqueueJob(job);
    return res.json({ jobId: id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ---------------- STARTUP & SHUTDOWN ----------------
const server = app.listen(CONFIG.PORT, () => {
  console.log(`✅ EduAI Brain V18.0 running on port ${CONFIG.PORT}`);
  (async () => {
    try {
      await generateWithFailover('titleIntent', 'ping', { label: 'warmup', timeoutMs: 2000 });
      console.log('💡 Model warmup done.');
    } catch (e) {
      console.warn('💡 Model warmup failed (non-fatal):', e.message);
    }
  })();
});

function shutdown(sig) {
  console.log(`${iso()} Received ${sig}, shutting down...`);
  workerStopped = true;
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
      process.exit(1);
    }
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
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err.stack || err);
  process.exit(1);
});

module.exports = { app, server };
