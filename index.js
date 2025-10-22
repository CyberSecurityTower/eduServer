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
    notification: Number(process.env.TIMEOUT_NOTIFICATION_MS || 25000),
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
  const prompt = `You are an expert intent classification system. Analyze the user's message and return a structured JSON object.

<rules>
1.  **Intent Classification:** Classify the intent into ONE of the following: 'analyze_performance', 'question', 'manage_todo', 'generate_plan', or 'unclear'.
2.  **Title Generation:** Create a short title (2-4 words) in the detected language.
3.  **Language Detection:** Identify the primary language (e.g., 'Arabic', 'English').
4.  **Output Format:** Respond with ONLY a single, valid JSON object. Do not add any extra text or explanations.
</rules>

<example>
User Message: "مرحبا، كيف يمكنني مراجعة أدائي الدراسي لهذا الأسبوع؟"
Your JSON Response:
{
  "intent": "analyze_performance",
  "title": "مراجعة الأداء الدراسي",
  "language": "Arabic"
}
</example>

User Message: "${escapeForPrompt(message)}"
Your JSON Response:`;
  try {
    const res = await generateWithFailover('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'titleIntent');
    if (parsed?.intent) return parsed;
    console.warn(`TrafficManager fallback for: "${message}"`);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  } catch (err)
   {
    console.error('runTrafficManager critical failure:', err.message);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  }
}
function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

async function runQuizAnalyzer(quizPayload) {
  const { lessonTitle = '', quizQuestions = [], userAnswers = [], totalScore = 0 } = quizPayload || {};
  const totalQuestions = Array.isArray(quizQuestions) ? quizQuestions.length : 0;
  const masteryScore = totalQuestions > 0 ? Math.round((Number(totalScore) / totalQuestions) * 100) : 0;

  const performanceSummary = (Array.isArray(quizQuestions) ? quizQuestions : []).map((q, i) => {
    const ua = (userAnswers && userAnswers[i] !== undefined) ? userAnswers[i] : null;
    return `Q${i + 1}: ${q.question || 'N/A'}\n- user: ${ua}\n- correct: ${q.correctAnswer}`;
  }).join('\n');

  const prompt = `You are an expert educational analyst. Produce ONLY a single JSON object (no extra text) with fields:
- newMasteryScore (number)
- feedbackSummary (brief Arabic encouraging paragraph)
- suggestedNextStep (brief Arabic actionable step)
- dominantErrorType (one of ["مفهومي","حسابي","تنفيذي","قراءة/سهو","مختلط","غير محدد"])
- recommendedResource (short string)

CONTEXT:
Lesson Title: "${escapeForPrompt(lessonTitle || 'Unknown')}"
User Score: ${Number(totalScore)} / ${totalQuestions} (${masteryScore}%)
Detailed Performance:
${performanceSummary}

RULES:
1) Analyze incorrect answers to identify dominantErrorType.
2) Provide concise Arabic feedback and a clear next step.
3) Recommend one resource (lesson name or short id).
4) Output MUST be strict JSON with the required fields.
`;

  try {
    const res = await generateWithFailover('analysis', prompt, { label: 'QuizAnalyzer', timeoutMs: CONFIG.TIMEOUTS.analysis });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && typeof parsed === 'object' && parsed.feedbackSummary && parsed.suggestedNextStep) {
      return {
        newMasteryScore: Number(parsed.newMasteryScore || masteryScore),
        feedbackSummary: String(parsed.feedbackSummary),
        suggestedNextStep: String(parsed.suggestedNextStep),
        dominantErrorType: String(parsed.dominantErrorType || 'غير محدد'),
        recommendedResource: String(parsed.recommendedResource || `درس: ${lessonTitle || 'مراجعة الدرس'}`),
      };
    }
    throw new Error('Invalid JSON from analysis model');
  } catch (err) {
    console.error('[QuizAnalyzer] analysis failed:', err && err.message ? err.message : err);
    // fallback
    const incorrectCount = (Array.isArray(quizQuestions) ? quizQuestions : []).reduce((acc, q, idx) => {
      const ua = userAnswers && userAnswers[idx] !== undefined ? String(userAnswers[idx]) : null;
      return acc + ((ua === null || String(q.correctAnswer) !== ua) ? 1 : 0);
    }, 0);
    const fallbackDominant = incorrectCount === 0 ? 'غير محدد' : (incorrectCount / Math.max(totalQuestions, 1) > 0.6 ? 'مفهومي' : 'حسابي');
    const fallbackResource = `درس: ${lessonTitle || 'مراجعة الدرس'}`;
    return {
      newMasteryScore: masteryScore,
      feedbackSummary: incorrectCount === 0 ? 'عمل رائع — أجبت على جميع الأسئلة بشكل صحيح.' : `أجبت بشكل صحيح على ${totalQuestions - incorrectCount} من ${totalQuestions} أسئلة. ركز على الأسئلة الخاطئة وراجع المفاهيم المرتبطة.`,
      suggestedNextStep: incorrectCount === 0 ? 'استمر في التقدم.' : 'راجع الدرس المعني وأعد حل الأسئلة المشابهة.',
      dominantErrorType: fallbackDominant,
      recommendedResource: fallbackResource,
    };
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
async function runNotificationManager(type = 'ack', language = 'Arabic', data = {}) {
  let prompt;
  const commonRules = `\n<rules>\n1. Respond in natural, encouraging ${language}.\n2. Be concise and positive.\n3. Do NOT include any formatting like markdown or JSON.\n</rules>`;

  switch (type) {
    case 'task_completed':
      prompt = `Create a short, celebratory message in ${language} for completing a task. The task title is: "${data.taskTitle || 'a task'}". Example: "رائع! تم إنجاز مهمة: ${data.taskTitle}"`;
      break;
    case 'task_added':
      prompt = `Create a short, welcoming message in ${language} for adding a new task. The task title is: "${data.taskTitle || 'a new task'}". Example: "تمت إضافة مهمة جديدة: ${data.taskTitle}"`;
      break;
    case 'task_removed':
      prompt = `Create a short, neutral message in ${language} for removing a task. The task title is: "${data.taskTitle || 'a task'}". Example: "تم حذف مهمة: ${data.taskTitle}"`;
      break;
    case 'task_updated':
      prompt = `Create a short, generic message in ${language} confirming that the to-do list was updated.`;
      break;
    case 'ack':
      prompt = `Return a short acknowledgement in ${language} (max 12 words) confirming the user's action was received, e.g., \"تم استلام طلبك، جاري العمل عليه\". Return ONLY the sentence.`;
      break;
    default:
      return (language === 'Arabic') ? "تم تحديث طلبك بنجاح." : 'Your request has been updated.';
  }

  try {
    const res = await generateWithFailover('notification', prompt + commonRules, { label: 'NotificationManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const text = await extractTextFromResult(res);
    // Fallback messages in case AI fails
    if (text) return text;
    if (type === 'task_completed') return `أحسنت! تم إنجاز مهمة: ${data.taskTitle}`;
    if (type === 'task_added') return `تمت إضافة مهمة: ${data.taskTitle}`;
    return language === 'Arabic' ? 'تم تحديث قائمة مهامك.' : 'Your to-do list has been updated.';
  } catch (err) {
    console.error('runNotificationManager error:', err.message);
    return language === 'Arabic' ? 'تم تحديث طلبك.' : 'Your request has been updated.';
  }
}
// ToDo manager: interpret todo instructions and return an action summary (lightweight implementation)
async function runToDoManager(userId, userRequest, currentTasks = []) {
  const prompt = `You are an expert To-Do List Manager AI. Modify the CURRENT TASKS based on the USER REQUEST.
<rules>
1.  **Precision:** You MUST only modify, add, or delete tasks explicitly mentioned in the user request.
2.  **Preservation:** You MUST preserve the exact original title, type, and language of all other tasks that were not mentioned in the request. This is a critical rule.
3.  **Output Format:** Respond ONLY with a valid JSON object: { "tasks": [ ... ] }. Each task must have all required fields (id, title, type, status, etc.).
</rules>

CURRENT TASKS:
${JSON.stringify(currentTasks)}

USER REQUEST:
"${escapeForPrompt(userRequest)}"`;

  const res = await generateWithFailover('todo', prompt, { label: 'ToDoManager', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'todo');
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('ToDoManager returned invalid tasks.');

  const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);
  const normalizedTasks = parsed.tasks.map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || 'مهمة جديدة'),
    type: VALID_TASK_TYPES.has(String(t.type || '').toLowerCase()) ? String(t.type).toLowerCase() : 'review',
    status: String(t.status || 'pending').toLowerCase() === 'completed' ? 'completed' : 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  // --- [المنطق الجديد] تحديد التغيير الذي حدث ---
  let changeDescription = { action: 'updated', taskTitle: null };
  const oldTaskIds = new Set(currentTasks.map(t => t.id));
  const newTaskIds = new Set(normalizedTasks.map(t => t.id));

  // 1. هل اكتملت مهمة؟
  const completedTask = normalizedTasks.find(newTask => {
    const oldTask = currentTasks.find(old => old.id === newTask.id);
    return oldTask && oldTask.status === 'pending' && newTask.status === 'completed';
  });
  if (completedTask) {
    changeDescription = { action: 'completed', taskTitle: completedTask.title };
  } else {
    // 2. هل أُضيفت مهمة جديدة؟
    const addedTask = normalizedTasks.find(t => !oldTaskIds.has(t.id));
    if (addedTask) {
      changeDescription = { action: 'added', taskTitle: addedTask.title };
    } else {
      // 3. هل حُذفت مهمة؟
      const removedTask = currentTasks.find(t => !newTaskIds.has(t.id));
      if (removedTask) {
        changeDescription = { action: 'removed', taskTitle: removedTask.title };
      }
    }
  }
  // --- نهاية المنطق الجديد ---

  await db.collection('userProgress').doc(userId).set({
    dailyTasks: { tasks: normalizedTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
  }, { merge: true });
  await cacheDel('progress', userId);
  
  // أعد القائمة الجديدة مع وصف التغيير
  return { updatedTasks: normalizedTasks, change: changeDescription };
}

// Planner manager: create a simple study plan JSON
async function runPlannerManager(userId, pathId = null) {
  const weaknesses = await fetchUserWeaknesses(userId, pathId);
  const weaknessesPrompt = weaknesses.length > 0
    ? `<context>\nThe user has shown weaknesses in the following areas:\n${weaknesses.map(w => `- Subject: "${w.subjectTitle}", Lesson: "${w.lessonTitle}" (ID: ${w.lessonId}), Current Mastery: ${w.masteryScore}%`).join('\n')}\n</context>`
    : '<context>The user is new or has no specific weaknesses. Suggest a general introductory plan to get them started.</context>';

  const prompt = `You are an elite academic coach. Create an engaging, personalized study plan.\n${weaknessesPrompt}\n<rules>\n1.  Generate 2-4 daily tasks.\n2.  All task titles MUST be in clear, user-friendly Arabic.\n3.  **Clarity:** If a task is for a specific subject (e.g., "Physics"), mention it in the title, like "مراجعة الدرس الأول في الفيزياء".\n4.  You MUST create a variety of task types.\n5.  Each task MUST include 'relatedLessonId' and 'relatedSubjectId'.\n6.  Output MUST be ONLY a valid JSON object: { "tasks": [ ... ] }\n</rules>`;

  const res = await generateWithFailover('planner', prompt, { label: 'Planner', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'planner');

  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    const fallback = [{ id: crypto.randomUUID(), title: 'مراجعة المفاهيم الأساسية', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    return { tasks: fallback, source: 'fallback' };
  }

  const tasksToSave = parsed.tasks.slice(0, 5).map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || 'مهمة تعليمية'),
    type: ['review', 'quiz', 'new_lesson', 'practice', 'study'].includes(String(t.type || '').toLowerCase()) ? String(t.type).toLowerCase() : 'review',
    status: 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
  await cacheDel('progress', userId);
  return { tasks: tasksToSave, source: 'AI' };
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
    await jobDoc.ref.update({ 
      status: 'processing', 
      startedAt: admin.firestore.FieldValue.serverTimestamp() 
    });

    const { userId, type, payload } = data;
    if (!payload || typeof payload !== 'object') {
      throw new Error('Missing or invalid payload');
    }
    
    const message = payload.message || '';
    const intent = payload.intent || null;
    const language = payload.language || 'Arabic';

    if (type === 'background_chat') {
  // الحالة الأولى: إدارة المهام
  if (intent === 'manage_todo') {
    const progress = await getProgress(userId);
    const currentTasks = progress?.dailyTasks?.tasks || [];
    const { change } = await runToDoManager(userId, message, currentTasks);

    let notificationType = 'task_updated';
    if (change.action === 'completed') notificationType = 'task_completed';
    if (change.action === 'added') notificationType = 'task_added';
    if (change.action === 'removed') notificationType = 'task_removed';

    const notificationMessage = await runNotificationManager(notificationType, language, { taskTitle: change.taskTitle });
    
    await sendUserNotification(userId, { 
      message: notificationMessage, 
      lang: language, 
      meta: { jobId: id, source: 'todo' } 
    });

  // الحالة الثانية: إنشاء خطة دراسية (كانت مفقودة)
  } else if (intent === 'generate_plan') {
    const pathId = payload.pathId || null;
    const result = await runPlannerManager(userId, pathId);
    const humanSummary = formatTasksHuman(result.tasks, language);
    await sendUserNotification(userId, { 
      message: `تم إنشاء خطتك الدراسية الجديدة:\n${humanSummary}`, 
      lang: language, 
      meta: { jobId: id, source: 'planner' } 
    });

  // الحالة الثالثة: أي شيء آخر (سؤال عام)
  } else {
     const [userProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
      getProfile(userId), 
      getProgress(userId), 
      fetchUserWeaknesses(userId), 
      formatProgressForAI(userId), 
      getUserDisplayName(userId)
    ]);

    const reply = await handleGeneralQuestion(
      payload.message, payload.language || 'Arabic', payload.history || [],
      userProfile, userProgress, weaknesses, formattedProgress, userName
    );
    await sendUserNotification(userId, { message: reply, meta: { jobId: id } });
  }
  
  await jobDoc.ref.update({ status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });

} else {
  await jobDoc.ref.update({ status: 'skipped', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
}

  } catch (err) {
    console.error('processJob error for', id, err.message || err);
    const attempts = (data.attempts || 0) + 1;
    const update = { 
      attempts, 
      lastError: String(err.message || err), 
      status: attempts >= 3 ? 'failed' : 'queued' 
    };
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
      const payload = { message, intent, language, pathId: req.body.pathId || null };
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
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, updatedTasks } = req.body || {};
    if (!userId || !Array.isArray(updatedTasks)) {
      return res.status(400).json({ error: 'User ID and updatedTasks array are required.' });
    }
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: updatedTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });
    await cacheDel('progress', userId);
    res.status(200).json({ success: true, message: 'Daily tasks updated successfully.' });
  } catch (error) {
    console.error('/update-daily-tasks error:', error.stack);
    res.status(500).json({ error: 'An error occurred while updating daily tasks.' });
  }
});

app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId, pathId = null } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const result = await runPlannerManager(userId, pathId);
    return res.status(200).json({ success: true, source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    console.error('/generate-daily-tasks error:', err.stack);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
});

app.post('/analyze-quiz', async (req, res) => {
  try {
    const { userId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions) || !Array.isArray(userAnswers) || typeof totalScore !== 'number') {
      return res.status(400).json({ error: 'Invalid or incomplete quiz data provided.' });
    }
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });
    return res.status(200).json(analysis);
  } catch (err) {
    console.error('/analyze-quiz error:', err.stack);
    return res.status(500).json({ error: 'An internal server error during quiz analysis.' });
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
