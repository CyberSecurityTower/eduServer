'use strict';

/**
 * server.js — EduAI Brain V17.0 (cleaned & corrected)
 *
 * - Single-file cleaned version (no duplicated blocks).
 * - Keep required env vars: FIREBASE_SERVICE_ACCOUNT_KEY, GOOGLE_API_KEY*.
 * - Dependencies: express, cors, firebase-admin, @google/generative-ai
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
    analysis: process.env.MODEL_ANALYSIS || 'gemini-2.5-pro',
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

const apiKeyCandidates = Array.from({ length: 4 }, (_, i) => process.env[`GOOGLE_API_KEY_${i + 1}`]).filter(Boolean);
if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
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
const poolNames = ['chat', 'todo', 'planner', 'titleIntent', 'notification', 'review', 'analysis'];
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

      let callPromise;
      if (inst.model?.generateContent) {
        callPromise = inst.model.generateContent(prompt);
      } else if (inst.model?.generate) {
        callPromise = inst.model.generate(prompt);
      } else if (inst.client?.responses?.generate) {
        callPromise = inst.client.responses.generate({
          model: CONFIG.MODEL[poolName],
          input: prompt
        });
      } else {
        throw new Error('No known model call shape on instance');
      }

      const res = await withTimeout(callPromise, timeoutMs, `${label} (key:${k})`);
      if (keyStates[k]) keyStates[k].fails = 0;
      return res;

    } catch (err) {
      lastErr = err;
      if (inst?.key && keyStates[inst.key]) {
        keyStates[inst.key].fails = (keyStates[inst.key].fails || 0) + 1;
        const backoff = Math.min(1000 * (2 ** keyStates[inst.key].fails), 10 * 60 * 1000);
        keyStates[inst.key].backoffUntil = Date.now() + backoff;
        console.warn(`${iso()} ${poolName} failed for key ${inst.key}:`, err.message || err);
      } else {
        console.warn(`${iso()} ${poolName} instance failed:`, err && err.message ? err.message : err);
      }
      // Try next instance instead of throwing immediately
      continue;
    }
  }

  // If we reach here, all instances failed
  throw lastErr || new Error(`${label} failed for all available keys`);
}
      
async function extractTextFromResult(result) {
  try {
    if (!result) return '';

    // 1) شكل يحتوي على response.text (stream-like / Response object)
    if (result.response && typeof result.response.text === 'function') {
      const t = await result.response.text();
      return (t || '').toString().trim();
    }

    // 2) نص مباشر
    if (typeof result === 'string') return result.trim();
    if (result.text && typeof result.text === 'string') return result.text.trim();
    if (result.outputText && typeof result.outputText === 'string') return result.outputText.trim();
    if (result.output && typeof result.output === 'string') return result.output.trim();
    if (result.data && typeof result.data === 'string') return result.data.trim();

    // 3) شكل client.responses.generate أو أشكال بلوكات المحتوى
    // مثال: result.output[0].content = [{ type: 'output_text', text: '...' }, ...]
    if (result.output && Array.isArray(result.output)) {
      // اجمع كل النصوص الممكنة من المحتويات
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

    // 4) بعض ردود Google الحديثة تحتوي على output[0].content[...] أو candidates
    if (result.candidates && Array.isArray(result.candidates) && result.candidates.length) {
      const candTexts = result.candidates.map(c => (typeof c.text === 'string' ? c.text : (c.message && c.message.content && c.message.content[0] && c.message.content[0].text) || '')).filter(Boolean);
      if (candTexts.length) return candTexts.join('\n').trim();
    }

    // 5) تحقق من result.output[0].content[0].text الشكل الشائع
    if (result.output && result.output[0] && result.output[0].content) {
      const parts = result.output[0].content.map(c => c.text || (c.parts && c.parts.join(''))).filter(Boolean);
      if (parts.length) return parts.join('\n').trim();
    }

    // 6) كحل أخير، حاول stringify مقطع صغير من النتيجة لتسهيل التشخيص
    const dumped = JSON.stringify(result);
    return (dumped && dumped.length) ? dumped.slice(0, 2000) : '';
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

// ---------------- DATA HELPERS ----------------
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
    const userProgressDoc = await db.collection('userProgress').doc(userId).get();
    if (!userProgressDoc.exists) return [];
    const userProgressData = userProgressDoc.data()?.pathProgress || {};
    const weaknesses = [];
    const pathsToScan = pathId ? [pathId] : Object.keys(userProgressData);
    const pathDataCache = new Map();

    for (const pid of pathsToScan) {
      if (!pathDataCache.has(pid)) {
        try {
          const pathDoc = await db.collection('educationalPaths').doc(pid).get();
          pathDataCache.set(pid, pathDoc.exists ? pathDoc.data() : null);
        } catch (e) {
          console.error(`Failed to fetch educationalPath ${pid}:`, e && e.message ? e.message : e);
          pathDataCache.set(pid, null);
        }
      }
      const educationalPath = pathDataCache.get(pid);
      if (!educationalPath) continue;
      const pathProgress = userProgressData[pid] || {};
      const subjectsProgress = pathProgress.subjects || {};
      for (const subjectId of Object.keys(subjectsProgress)) {
        const lessonsProgress = subjectsProgress[subjectId]?.lessons || {};
        for (const lessonId of Object.keys(lessonsProgress)) {
          const lessonProgressData = lessonsProgress[lessonId] || {};
          const masteryScore = Number(lessonProgressData.masteryScore || 0);
          if (!Number.isNaN(masteryScore) && masteryScore < 75) {
            const subjectData = Array.isArray(educationalPath.subjects) ? educationalPath.subjects.find(s => s.id === subjectId) : null;
            const lessonData = subjectData && Array.isArray(subjectData.lessons) ? subjectData.lessons.find(l => l.id === lessonId) : null;
            weaknesses.push({
              lessonId,
              subjectId,
              masteryScore,
              lessonTitle: lessonData?.title || lessonId,
              subjectTitle: subjectData?.title || subjectId,
            });
          }
        }
      }
    }
    return weaknesses;
  } catch (err) {
    console.error('Critical error in fetchUserWeaknesses:', err && err.stack ? err.stack : err);
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
async function runToDoManager(userId, userRequest, currentTasks = []) {
  // [!] الإصلاح: تم تنظيف وتوحيد الأمر
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
  const res = await generateWithFailover('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUTS.notification });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'titleIntent');
  if (!parsed || !parsed.intent) return { language: 'Arabic', intent: 'unclear', title: 'محادثة' };
  return parsed;
}

async function runToDoManager(userId, userRequest, currentTasks = []) {
  // [!] الإصلاح #2: تم تنظيف وتوحيد الأمر
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
  await cacheDel('progress', userId);
  return normalized;
}

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

  try {
    if (type === 'background_chat') {
      if (intent === 'manage_todo') {
        const progress = await getProgress(userId);
        const currentTasks = progress?.dailyTasks?.tasks || [];
        const updated = await runToDoManager(userId, message, currentTasks);
        const notif = await runNotificationManager('todo_success', language, { count: updated.length });
        await sendUserNotification(userId, { message: notif, lang: language, meta: { source: 'todo' } });
      } else if (intent === 'generate_plan') {
        const pathId = payload.pathId || null;
        const result = await runPlannerManager(userId, pathId);
        const humanSummary = formatTasksHuman(result.tasks, language);
        const notif = await runNotificationManager('plan_success', language, { count: result.tasks.length });
        await sendUserNotification(userId, { message: `${notif}\n${humanSummary}`, lang: language, meta: { source: 'planner' } });
      } else {
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

// ---------------- NOTIFICATION & REVIEW (UTILS) ----------------

async function handleGeneralQuestion(message, language, history = [], userProfile = 'No available memory.', userProgress = {}, userId = null) {
  const lastFive = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`).join('\n');
  const tasksSummary = (userProgress?.dailyTasks?.tasks?.length > 0) ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user currently has no tasks.';
  
  let weaknesses = [];
  if (userId) {
      try { weaknesses = await fetchUserWeaknesses(userId); } catch (e) { weaknesses = []; }
  }
  const weaknessesSummary = weaknesses.length > 0 ? `Identified Weaknesses:\n${weaknesses.map(w => `- In "${w.subjectTitle}", the lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore}%.`).join('\n')}` : 'No specific weaknesses have been identified.';

  // [!] الإصلاح: تم تنظيف وتوحيد الأمر
  const prompt = `You are EduAI, an expert, empathetic, and highly intelligent educational assistant. Your primary role is to help the user by leveraging the academic context provided to you. You are NOT a generic AI; you are a specialized tutor with access to the user's learning journey.
<rules>
1.  **Your Persona:** You are helpful, encouraging, and you ALWAYS use the context provided below to answer questions related to the user's progress, tasks, or study plan.
2.  **Use the Context:** The following information is your operational knowledge about the user. It is NOT private data; it is your tool to provide personalized help. You MUST use it to answer relevant questions.
3.  **Handling Unclear Input:** If the user's message is nonsensical, a random string, or just emojis, you MUST respond with a simple, friendly message like "لم أفهم طلبك، هل يمكنك إعادة صياغته؟". DO NOT try to guess or use the context to invent a response.
4.  **Language:** You MUST respond in ${language}.
</rules>

<academic_context>
${tasksSummary}
${weaknessesSummary}
User Profile Summary: ${safeSnippet(userProfile, 500)}
</academic_context>

<conversation_history>
${lastFive}
</conversation_history>

User's new question: "${escapeForPrompt(safeSnippet(message, 1000))}"

Your concise and helpful response:`;

  const modelResp = await generateWithFailover('chat', prompt, { label: 'ResponseManager', timeoutMs: CONFIG.TIMEOUTS.chat });
  let replyText = await extractTextFromResult(modelResp);

  const review = await runReviewManager(message, replyText);
  if (review?.score < CONFIG.REVIEW_THRESHOLD) {
    const correctivePrompt = `Previous reply scored ${review.score}/10. Improve it based on: ${escapeForPrompt(review.feedback)}. User: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
    const res2 = await generateWithFailover('chat', correctivePrompt, { label: 'ResponseRetry', timeoutMs: CONFIG.TIMEOUTS.chat });
    const improved = await extractTextFromResult(res2);
    if (improved) replyText = improved;
  }

  return replyText || (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن. هل تريد إعادة الصياغة؟' : 'I could not generate an answer right now.');
}


// ---------------- ROUTES ----------------
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, tasks } = req.body || {};

    if (!userId || !Array.isArray(tasks)) {
      return res.status(400).json({ error: 'User ID and tasks array are required.' });
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Update tasks
    await userRef.update({ dailyTasks: tasks, updatedAt: new Date().toISOString() });

    // Invalidate the cache for this user
    await cacheDel('progress', userId);

    res.status(200).json({ success: true, message: 'Daily tasks updated successfully.' });

  } catch (error) {
    console.error('/update-daily-tasks error:', error.stack);
    res.status(500).json({ error: 'An error occurred while updating daily tasks.' });
  }
});
const userDoc = await userRef.get();
if (!userDoc.exists) {
  return res.status(404).json({ error: 'User not found.' });
}


    // Update Firestore (use update to avoid overwriting unless you want full replace)
    await userRef.update({
      dailyTasks: updatedTasks,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Respond with success and confirmation payload
    res.status(200).json({
      message: 'Daily tasks updated successfully.',
      updatedCount: updatedTasks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('/update-daily-tasks error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'An error occurred while updating daily tasks.' });
  }
});

app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId, pathId = null } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    const result = await runPlannerManager(userId, pathId);

    res.status(200).json({
      source: result.source,
      taskCount: result.tasks.length,
      tasks: result.tasks,
    });
  } catch (err) {
    console.error('/generate-daily-tasks error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'An error occurred while generating tasks.' });
  }
});

// === Route: Generate Title ===
app.post('/generate-title', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    const traffic = await runTrafficManager(message);
    return res.status(200).json({ title: traffic.title || 'New Chat' });
  } catch (err) {
    console.error('/generate-title error:', err && err.stack ? err.stack : err);
    return res.status(200).json({ title: 'New Chat' });
  }
});


// ---------------- ANALYZE QUIZ ----------------
app.post('/analyze-quiz', async (req, res) => {
  const start = Date.now();
  try {
    const { userId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions) || !Array.isArray(userAnswers) || typeof totalScore !== 'number') {
      return res.status(400).json({ error: 'Invalid or incomplete quiz data provided.' });
    }
    if (quizQuestions.length !== userAnswers.length) {
      req.log && req.log('Warning: quizQuestions.length != userAnswers.length');
    }
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });
    const took = Date.now() - start;
    res.setHeader('X-Analysis-Time-ms', String(took));
    return res.status(200).json(analysis);
  } catch (err) {
    console.error('/analyze-quiz error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'An internal server error occurred during quiz analysis.' });
  }
});

// ---------------- HEALTH ----------------
app.get('/health', (req, res) => res.json({ ok: true, time: iso(), pools: Object.fromEntries(poolNames.map(p => [p, modelPools[p]?.length || 0])) }));

// ---------------- STARTUP & SHUTDOWN ----------------
// Start single HTTP server (avoid multiple app.listen calls)
const server = app.listen(CONFIG.PORT, () => {
  console.log(`✅ EduAI Brain V17.0 running on port ${CONFIG.PORT}`);
  (async () => {
    try {
      // warm up one of the lightweight models (non-fatal)
      await generateWithFailover('titleIntent', 'ping', { label: 'warmup', timeoutMs: 2000 });
      console.log('💡 Model warmup done.');
    } catch (e) {
      console.warn('💡 Model warmup skipped/failed (non-fatal).');
    }
  })();
});

function shutdown(sig) {
  console.log(`${iso()} Received ${sig}, shutting down...`);
  workerStopped = true;
  // stop accepting new connections
  server.close(async (err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
      process.exit(1);
    }
    console.log(`${iso()} HTTP server closed.`);
    // give some time for background tasks to finish
    try { await sleep(500); } catch (e) {}
    process.exit(0);
  });
  // force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
  // attempt graceful shutdown on fatal exceptions
  try { shutdown('uncaughtException'); } catch (e) { process.exit(1); }
});

// export app for tests / serverless adapters
module.exports = { app, server };
