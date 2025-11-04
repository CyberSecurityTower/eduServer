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
const LRUCache = require('./cache');

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

// Robust model caller that tries multiple possible SDK method names
async function _callModelInstance(instance, prompt, timeoutMs, label) {
  const model = instance.model;
  const methodCandidates = ['generateContent', 'generate', 'generateText', 'predict', 'response', 'complete'];
  let lastErr = null;

  for (const name of methodCandidates) {
    const fn = model && model[name];
    if (typeof fn !== 'function') continue;
    try {
      // Try both signature styles: string or object { prompt }
      const maybe = fn.length === 1 ? fn(prompt) : fn({ prompt });
      const res = await withTimeout(Promise.resolve(maybe), timeoutMs, `${label}:${name}`);
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`${iso()} Model method ${name} failed for key ${instance.key?.slice(-4)}:`, err && err.message ? err.message : err);
      // try next candidate
    }
  }

  throw lastErr || new Error('No callable model method found on instance');
}

// Failover wrapper that uses the robust caller
/**
 * يستدعي نموذجًا من مجموعة (pool) محددة، مع تطبيق آليات قوية للتعامل مع الأخطاء والتجاوز (Failover).
 * يقوم بتوزيع الحمل عشوائيًا على مفاتيح الواجهة البرمجية المتاحة، ويتجنب مؤقتًا المفاتيح التي تواجه أخطاء،
 * ويعيد المحاولة باستخدام المفتاح التالي المتاح حتى ينجح أو تستنفد جميع الخيارات.
 *
 * @param {string} poolName - اسم مجموعة النماذج المراد استخدامها (مثل 'chat', 'analysis').
 * @param {any} prompt - المُوجّه (prompt) الذي سيتم إرساله إلى النموذج.
 * @param {object} [opts={}] - خيارات إضافية.
 * @param {number} [opts.timeoutMs] - مهلة زمنية مخصصة بالمللي ثانية لهذا الطلب.
 * @param {string} [opts.label] - تسمية مخصصة للطلب لتظهر في سجلات الأخطاء.
 * @returns {Promise<any>} - يعد بإرجاع نتيجة ناجحة من النموذج.
 * @throws {Error} - يطلق خطأ إذا فشلت جميع المحاولات مع كل المفاتيح المتاحة في المجموعة.
 */
async function generateWithFailover(poolName, prompt, opts = {}) {
  // 1. التحقق من وجود المجموعة المطلوبة وتوفر نماذج فيها
  const pool = modelPools[poolName];
  if (!pool || pool.length === 0) {
    throw new Error(`No models available for pool "${poolName}". Check configuration.`);
  }

  // 2. إعداد المتغيرات الأساسية للعملية
  const timeoutMs = opts.timeoutMs || CONFIG.TIMEOUTS.default;
  const label = opts.label || poolName;
  let lastErr = null; // لتخزين آخر خطأ تمت مواجهته لاستخدامه في حالة فشل جميع المحاولات

  // 3. خلط ترتيب المفاتيح في المجموعة (shuffling)
  // هذه خطوة حيوية لتوزيع الحمل بالتساوي على جميع المفاتيح المتاحة وتجنب الضغط على مفتاح واحد.
  for (const inst of shuffled(pool)) {
    try {
      // التحقق من صلاحية الكائن قبل استخدامه
      if (!inst || !inst.model) {
        console.warn(`${iso()} [Failover] Skipping invalid instance in pool "${poolName}"`);
        continue;
      }

      // 4. التحقق من حالة المفتاح (Key Health Check)
      // نتجنب استخدام المفاتيح التي تم وضعها في فترة "عقاب" (backoff) مؤقتة بسبب أخطاء سابقة.
      if (inst.key && keyStates[inst.key]?.backoffUntil > Date.now()) {
        continue; // تخطى هذا المفتاح وانتقل إلى التالي
      }

      // 5. استدعاء النموذج مع مهلة زمنية (Timeout)
      // يتم استدعاء الطريقة الصحيحة والمباشرة (`generateContent`) لضمان الموثوقية.
      // يتم تغليف الاستدعاء في دالة `withTimeout` لمنع تعليق الطلب إلى الأبد.
      const res = await withTimeout(
        inst.model.generateContent(prompt),
        timeoutMs,
        `${label} (key:${inst.key.slice(-4)})`
      );

      // 6. التعامل مع النجاح
      // إذا نجح الطلب، نقوم بإعادة تعيين عدد مرات الفشل لهذا المفتاح إلى الصفر.
      if (inst.key && keyStates[inst.key]) {
        keyStates[inst.key].fails = 0;
      }
      
      return res; // إرجاع النتيجة الناجحة فورًا والخروج من الحلقة

    } catch (err) {
      // 7. التعامل مع الفشل
      lastErr = err; // حفظ الخطأ الحالي

      // إذا كان للمثيل مفتاح، نقوم بتحديث حالته وتطبيق فترة عقاب تزداد بشكل كبير مع كل فشل.
      if (inst.key && keyStates[inst.key]) {
        const fails = (keyStates[inst.key].fails || 0) + 1;
        
        // فترة العقاب الأسيّة (Exponential Backoff): 2 ثانية، ثم 4، ثم 8... بحد أقصى 10 دقائق.
        // هذا يمنع إغراق الخدمة بالطلبات من مفتاح يواجه مشكلة.
        const backoff = Math.min(1000 * (2 ** fails), 10 * 60 * 1000);
        keyStates[inst.key] = { fails, backoffUntil: Date.now() + backoff };

        // تسجيل تحذير مفصل للمساعدة في تصحيح الأخطاء
        console.warn(`${iso()} [Failover] ${label} failed for key (fails=${fails}), backing off for ${backoff}ms:`, err.message);
      } else {
        console.warn(`${iso()} [Failover] ${label} failed for an instance without a key:`, err.message);
      }
      // تستمر الحلقة لتجربة المفتاح التالي المتاح...
    }
  }

  // 8. الفشل النهائي
  // إذا انتهت الحلقة دون نجاح أي محاولة، نطلق آخر خطأ تم تسجيله.
  throw lastErr || new Error(`[Failover] ${label} failed for all available keys.`);
}

async function runMemoryAgent(userId, userMessage) {
  try {
    // 1. جلب الذاكرة الكاملة للمستخدم
    const memoryProfile = await getProfile(userId);
    const fullSummary = memoryProfile.profileSummary || 'No summary available.';
    const activeThreads = memoryProfile.activeThreads || []; // سنتعامل مع هذا لاحقًا

    // 2. صياغة الأمر الذكي للوكيل (نموذج gemini-flash السريع)
    const prompt = `You are a lightning-fast psychological analyst.
    Your job is to read a user's full memory profile and their new question.
    Extract ONLY the parts of the memory that are directly relevant to answering this specific question.
    If nothing is relevant, return an empty summary.

    <user_memory_profile>
    ${fullSummary}
    </user_memory_profile>

    <user_new_question>
    "${userMessage}"
    </user_new_question>

    Respond with ONLY a JSON object in the format: { "relevant_summary": "..." }`;

    // 3. استدعاء النموذج السريع للحصول على الملخص ذي الصلة
    const res = await generateWithFailover('analysis', prompt, { label: 'MemoryAgent', timeoutMs: 4000 }); // مهلة قصيرة
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.relevant_summary) {
      return parsed.relevant_summary;
    }

    return ''; // في حالة عدم وجود شيء ذي صلة، أرجع نصًا فارغًا

  } catch (error) {
    console.error(`MemoryAgent failed for user ${userId}:`, error.message);
    return ''; // أرجع دائمًا نصًا فارغًا في حالة الفشل لضمان عدم تعطل النظام
  }
}
async function runCurriculumAgent(userId, userMessage) {
  try {
    // 1. Fetch academic data: user's progress and the educational path structure.
    const userProgress = await getProgress(userId);
    // We assume user.selectedPathId is available or passed in a real scenario.
    // For now, we'll simulate fetching the first path found in their progress.
    const pathId = userProgress.selectedPathId || (Object.keys(userProgress.pathProgress || {})[0]);
    if (!pathId) return ''; // No path to analyze

    const educationalPath = await getCachedEducationalPathById(pathId); // We'll need to ensure this function is available in the backend
    if (!educationalPath) return '';

    // 2. Format the data for the AI model to understand.
    const curriculumData = {
      pathName: educationalPath.displayName,
      subjects: educationalPath.subjects.map(sub => ({
        id: sub.id,
        name: sub.name,
        progress: userProgress.pathProgress?.[pathId]?.subjects?.[sub.id]?.progress || 0,
        lessons: sub.lessons.map(les => ({
          id: les.id,
          title: les.title,
          status: userProgress.pathProgress?.[pathId]?.subjects?.[sub.id]?.lessons?.[les.id]?.status || 'locked',
          mastery: userProgress.pathProgress?.[pathId]?.subjects?.[sub.id]?.lessons?.[les.id]?.masteryScore || null,
        }))
      }))
    };

    // 3. Formulate the smart prompt for the agent (gemini-flash).
    const prompt = `You are a curriculum analysis expert.
    Your job is to determine if the user's question is related to any specific subject or lesson in their study plan.
    Analyze the user's question against their curriculum data.

    <curriculum_data>
    ${JSON.stringify(curriculumData, null, 2)}
    </curriculum_data>

    <user_question>
    "${userMessage}"
    </user_question>

    If you find a direct link, respond ONLY with a JSON object: { "context": "..." }.
    The "context" should be a very brief sentence. Example: "The user is asking about 'Intro to Economics', where their progress is 30% and mastery on the last lesson was 65%."
    If there is no link, return an empty JSON object: {}.`;

    // 4. Call the fast model and parse the result.
    const res = await generateWithFailover('analysis', prompt, { label: 'CurriculumAgent', timeoutMs: 5000 });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.context) {
      return parsed.context;
    }

    return ''; // Return empty if no context is found

  } catch (error) {
    console.error(`CurriculumAgent failed for user ${userId}:`, error.message);
    return ''; // Always return empty on failure to keep the system running
  }
}

// We will also need to make getCachedEducationalPathById available on the server.
// For now, we can create a simple version.
async function getCachedEducationalPathById(pathId) {
  if (!pathId) return null;
  const cached = educationalPathCache.get(pathId);
  if (cached) return cached;

  const doc = await db.collection('educationalPaths').doc(pathId).get();
  if (doc.exists) {
    const data = doc.data();
    educationalPathCache.set(pathId, data);
    return data;
  }
  return null;
}
async function sendUserNotification(userId, payload = {}) {
  if (!userId) return;
  try {
    await db.collection('userNotifications').doc(userId).collection('inbox').add({
      title: payload.title || 'Notification',
      message: payload.message || '',
      meta: payload.meta || {},
      read: false,
      lang: payload.lang || 'Arabic',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`sendUserNotification write failed for ${userId}:`, err && err.message ? err.message : err);
  }
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
// ---------- Cache imports & instances ----------

// استخدم CONFIG.CACHE_TTL_MS إن كان معرفًا، أو حدّ افتراضي
const DEFAULT_TTL = (typeof CONFIG !== 'undefined' && CONFIG.CACHE_TTL_MS) ? CONFIG.CACHE_TTL_MS : 1000 * 60 * 60;

const educationalPathCache = new LRUCache(50, DEFAULT_TTL); // 50 items, 1 hour TTL
const localCache = {
  profile: new LRUCache(200, DEFAULT_TTL),
  progress: new LRUCache(200, DEFAULT_TTL),
};

// helpers (يمكنك إبقاؤها async لتتماشى مع بقية الكود)
async function cacheGet(scope, key) { return localCache[scope]?.get(key) ?? null; }
async function cacheSet(scope, key, value) { return localCache[scope]?.set(key, value); }
async function cacheDel(scope, key) { return localCache[scope]?.del(key); }
// -------------------------------------------------

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

// ✨ [MODIFIED] - Fetches from the new aiMemoryProfiles collection
async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    if (doc.exists) {
      const val = doc.data();
      await cacheSet('profile', userId, val);
      return val;
    } else {
      const defaultProfile = {
        profileSummary: 'مستخدم جديد، لم يتم تحليل أي بيانات بعد.',
        lastUpdatedAt: new Date().toISOString(),
      };
      await db.collection('aiMemoryProfiles').doc(userId).set(defaultProfile);
      await cacheSet('profile', userId, defaultProfile);
      return defaultProfile;
    }
  } catch (err) {
    console.error('getProfile error:', err.message);
    return { profileSummary: 'No available memory.' };
  }
}
 async function processSessionAnalytics(userId, sessionId) {
      try {
        console.log(`[Analytics] Processing session ${sessionId} for user ${userId}`);
        
        // 1. قراءة أحدث 5 جلسات للمستخدم
        const sessionsSnapshot = await db.collection('userBehaviorAnalytics').doc(userId).collection('sessions')
          .orderBy('startTime', 'desc').limit(5).get();
        
        if (sessionsSnapshot.empty) {
          console.log('[Analytics] No sessions found to process.');
          return;
        }

        const recentSessions = sessionsSnapshot.docs.map(doc => doc.data());

        // 2. حساب المقاييس السلوكية (هنا يمكنك إضافة كل الصيغ المعقدة لاحقًا)
        let totalDuration = 0;
        let totalQuickCloses = 0;
        let totalLessonsViewed = 0;
        
        recentSessions.forEach(session => {
          totalDuration += session.durationSeconds || 0;
          totalQuickCloses += session.quickCloseCount || 0;
          totalLessonsViewed += session.lessonsViewedCount || 0;
        });

        const avgDuration = totalDuration / recentSessions.length;
        
        // صيغة مبسطة وموثوقة لمؤشر المماطلة
        const procrastinationScore = totalLessonsViewed > 0 ? (totalQuickCloses / totalLessonsViewed) : 0;
        
        // صيغة مبسطة لمستوى التفاعل
        const engagementLevel = Math.min(1, avgDuration / 1800); // نعتبر 30 دقيقة تفاعل كامل

        // 3. تحديث ملف الذاكرة (aiMemoryProfiles)
        const memoryProfileRef = db.collection('aiMemoryProfiles').doc(userId);
        await memoryProfileRef.set({
          lastAnalyzedAt: new Date().toISOString(),
          behavioralInsights: {
            engagementLevel: parseFloat(engagementLevel.toFixed(2)),
            procrastinationScore: parseFloat(procrastinationScore.toFixed(2)),
            // يمكنك إضافة المزيد من الرؤى هنا لاحقًا
          }
        }, { merge: true });

        console.log(`[Analytics] Successfully updated memory profile for user ${userId}`);

      } catch (error) {
        console.error(`[Analytics] Error processing session for user ${userId}:`, error);
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
// ✨ [NEW] - Saves or updates a chat session in Firestore
async function saveChatSession(sessionId, userId, title, messages, type = 'main_chat', context = {}) {
  if (!sessionId || !userId) return;
  try {
    const sessionRef = db.collection('chatSessions').doc(sessionId);
   const storableMessages = (messages || [])
  .filter(m => m && (m.author === 'user' || m.author === 'bot' || m.role)) // keep typical chat entries
  .slice(-50)
  .map(m => ({
    author: m.author || m.role || 'user',
    text: m.text || m.message || '',
    timestamp: m.timestamp || new Date().toISOString(),
    // optionally include type/status if present:
    type: m.type || null,
  }));

    const dataToSave = { // ✨ بناء كائن البيانات
      userId,
      title,
      messages: storableMessages,
      type,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (context && context.lessonId) { // ✨ [ADD THIS LOGIC]
      dataToSave.context = context; // حفظ سياق الدرس إذا كان موجودًا
    }

    await sessionRef.set(dataToSave, { merge: true });

  } catch (error) {
    console.error(`Error saving chat session ${sessionId}:`, error);
  }
}

// ✨ [NEW] - The background memory analyst function
async function analyzeAndSaveMemory(userId, newConversation) {
    try {
        const profileDoc = await getProfile(userId);
        const currentSummary = profileDoc.profileSummary || '';

        const prompt = `You are a psychological and educational analyst AI. Your task is to update a student's long-term memory profile based on a new conversation.

        **Current Profile Summary:**
        "${currentSummary}"

        **New Conversation Transcript (User and EduAI):**
        ${newConversation.map(m => `${m.author === 'bot' ? 'EduAI' : 'User'}: ${m.text}`).join('\n')}

        **Instructions:**
        1. Read the new conversation.
        2. Identify ANY new personal information, goals, struggles, preferences, or significant events.
        3. Integrate this new information into the existing profile summary to create an updated, concise, and coherent summary in english.
        4. Do not repeat information already in the summary.
        5. Respond ONLY with a valid JSON object: { "updatedSummary": "..." }`;

        const res = await generateWithFailover('analysis', prompt, { label: 'MemoryAnalyst' });
        const raw = await extractTextFromResult(res);
        const parsed = await ensureJsonOrRepair(raw, 'analysis');

        if (parsed && parsed.updatedSummary) {
            await db.collection('aiMemoryProfiles').doc(userId).update({
                profileSummary: parsed.updatedSummary,
                lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            cacheDel('profile', userId); // Invalidate cache
        }
    } catch (err) {
        console.error(`Failed to analyze memory for user ${userId}:`, err);
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
async function runConversationAgent(userId, userMessage) {
  try {
    // 1. Fetch the last few chat sessions to get recent context.
    const sessionsSnapshot = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .orderBy('updatedAt', 'desc')
      .limit(3) // Fetch the 3 most recent sessions
      .get();

    if (sessionsSnapshot.empty) return '';

    // 2. Consolidate the messages from these sessions into a single history.
    let recentHistory = [];
    sessionsSnapshot.forEach(doc => {
      const messages = doc.data().messages || [];
      recentHistory.push(...messages);
    });
    
    // Ensure chronological order and take the last 50 messages for brevity
    recentHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const conversationSnippet = recentHistory.slice(-50).map(m => `${m.author}: ${m.text}`).join('\n');

    if (!conversationSnippet) return '';

    // 3. Formulate the prompt for our semantic search expert (gemini-flash).
    const prompt = `You are a conversation analyst with perfect short-term memory.
    Your job is to find the single most relevant exchange from the recent conversation history that relates to the user's new question.
    Focus on the semantic meaning and context.

    <recent_conversation_history>
    ${conversationSnippet}
    </recent_conversation_history>

    <user_new_question>
    "${userMessage}"
    </user_new_question>

    If you find a relevant exchange, summarize its key point in one concise sentence.
    Respond ONLY with a JSON object: { "summary": "..." }.
    Example: { "summary": "Yesterday, the user was confused about the practical application of this economic theory." }
    If nothing is relevant, return an empty JSON object: {}.`;

    // 4. Call the fast model and parse the result.
    const res = await generateWithFailover('analysis', prompt, { label: 'ConversationAgent', timeoutMs: 5000 });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.summary) {
      return parsed.summary;
    }

    return '';

  } catch (error) {
    console.error(`ConversationAgent failed for user ${userId}:`, error.message);
    return ''; // Never crash the system.
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
  const weaknesses = await fetchUserWeaknesses(userId);
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
      title: 'Tasks Updated', // ✨ Title added
      message: notificationMessage, 
      lang: language, 
      meta: { jobId: id, source: 'tasks' } // ✨ Source is 'tasks' for consistency
    });

  // Case 2: Generate Plan
  } else if (intent === 'generate_plan') {
    const pathId = payload.pathId || null;
    const result = await runPlannerManager(userId, pathId);
    const humanSummary = formatTasksHuman(result.tasks, language);
    await sendUserNotification(userId, { 
      title: 'New Study Plan', // ✨ Title added
      message: `Your new study plan is ready:\n${humanSummary}`, 
      lang: language, 
      meta: { jobId: id, source: 'planner' } 
    });

  // Case 3: General Question
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
    await sendUserNotification(userId, { 
        title: 'New Message from EduAI', // ✨ Title added
        message: reply, 
        meta: { jobId: id, source: 'chat' } 
    });
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
    // 1. ابحث عن المهام المجدولة التي حان وقتها
    const now = admin.firestore.Timestamp.now();
    const scheduledJobs = await db.collection('jobs')
      .where('status', '==', 'scheduled')
      .where('sendAt', '<=', now)
      .get();
    
    scheduledJobs.forEach(doc => {
      // قم بتحويلها إلى مهام جاهزة للتنفيذ
      doc.ref.update({ status: 'queued' }); 
    });

    // 2. استمر في تنفيذ المهام الجاهزة كالمعتاد
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
async function runNightlyAnalysisForUser(userId) {
  try {
    // 1. تطبيق "قاعدة المبتدئ"
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;
    const userCreationDate = userDoc.createTime.toDate();
    const daysSinceJoined = (new Date() - userCreationDate) / (1000 * 60 * 60 * 24);
    if (daysSinceJoined < 3) { // سنعطيه 3 أيام كاملة
      return; // مستخدم جديد، اتركه وشأنه
    }

    // 2. تشغيل "محرك التوقيت التنبئي"
    const eventsSnapshot = await db.collection('userBehaviorAnalytics').doc(userId).collection('events')
      .where('name', '==', 'app_open')
      .orderBy('timestamp', 'desc')
      .limit(10) // حلل آخر 10 مرات فتح فيها التطبيق
      .get();

    let primeTimeHour = 20; // وقت افتراضي (8 مساءً)
    if (!eventsSnapshot.empty) {
      const hours = eventsSnapshot.docs.map(doc => doc.data().timestamp.toDate().getHours());
      // ابحث عن الساعة الأكثر تكرارًا
      const hourCounts = hours.reduce((acc, hour) => {
        acc[hour] = (acc[hour] || 0) + 1;
        return acc;
      }, {});
      primeTimeHour = parseInt(Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b));
    }

    // 3. توليد رسالة إعادة التفاعل الذكية
    const reEngagementMessage = await runReEngagementManager(userId);
    if (!reEngagementMessage) return; // إذا لم يكن هناك شيء مهم ليقوله، لا ترسل شيئًا

    // 4. جدولة الإشعار في الوقت المثالي
    const scheduleTime = new Date();
    scheduleTime.setHours(primeTimeHour - 1, 30, 0, 0); // أرسل قبل ساعة ونصف من وقته المعتاد

    // استخدم نظام المهام الذي بنيناه بالفعل!
    await enqueueJob({
      type: 'scheduled_notification',
      userId: userId,
      payload: {
        title: 'اشتقنا لوجودك!',
        message: reEngagementMessage,
      },
      sendAt: admin.firestore.Timestamp.fromDate(scheduleTime) // حقل جديد للمهام المجدولة
    });

  } catch (error) {
    console.error(`Nightly analysis failed for user ${userId}:`, error);
  }
}
async function runReEngagementManager(userId) {
  const progress = await getProgress(userId);
  const lastIncompleteTask = progress?.dailyTasks?.tasks?.find(t => t.status === 'pending');

  let context = "The user has been inactive for a couple of days.";
  if (lastIncompleteTask) {
    context += ` Their last incomplete task was "${lastIncompleteTask.title}".`;
  } else {
    context += " They don't have any specific pending tasks.";
  }

  const prompt = `You are a warm and caring study coach, not a robot.
  ${context}
  Write a short, friendly, and very gentle notification (1-2 sentences in Arabic) to re-engage them.
  - The tone should be zero-pressure. More like "Hey, thinking of you!" than "You have work to do!".
  - If they have an incomplete task, you can mention it in a very encouraging way.
  - Example if task exists: "مساء الخير! أتمنى أن تكون بخير. مهمة '${lastIncompleteTask.title}' لا تزال بانتظارك عندما تكون مستعدًا للعودة. ما رأيك أن ننجزها معًا؟"
  - Example if no task: "مساء الخير! كيف حالك؟ مر وقت لم نرك فيه. أتمنى أن كل شيء على ما يرام!"
  Respond with ONLY the notification text.`;

  try {
    const res = await generateWithFailover('notification', prompt, { label: 'ReEngagementManager' });
    return await extractTextFromResult(res);
  } catch (error) {
    console.error(`ReEngagementManager failed for user ${userId}:`, error);
    return null;
  }
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
// ✨ [NEW] Endpoint for streaming chat responses
// ✨ [ENHANCED] Endpoint for streaming chat responses with better headers
// ✨ [CLEANUP] Renamed from /chat-stream to /chat-interactive and removed streaming logic.
// This endpoint now generates the full response and sends it at once.
// ✨ [ENHANCED & CLEANED] Renamed from /chat-stream to /chat-interactive.
// This endpoint now generates the full response and sends it at once as a JSON object.
// ✨ [HEAVILY MODIFIED & UPGRADED] - This is now the main, memory-aware endpoint
app.post('/chat-interactive', async (req, res) => {
  try {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    // --- 1. Session & title ---
    let sessionId = clientSessionId;
    let chatTitle = 'New Chat';
    const isNewSession = !sessionId;
    if (isNewSession) {
      sessionId = `chat_${Date.now()}_${userId.slice(0, 5)}`;
      try {
        chatTitle = await generateTitle(message.trim());
      } catch (e) {
        chatTitle = message.trim().substring(0, 30);
        console.error('generateTitle failed, using fallback title:', e);
      }
    }

    // --- 2. Kick off agents + legacy fetches in parallel (non-blocking) ---
    const memoryPromise = (async () => {
      try { return await runMemoryAgent(userId, message); }
      catch (e) { console.error('runMemoryAgent failed:', e); return ''; }
    })();

    const curriculumPromise = (async () => {
      try { return await runCurriculumAgent(userId, message); }
      catch (e) { console.error('runCurriculumAgent failed:', e); return ''; }
    })();

    const conversationPromise = (async () => {
      try { return await runConversationAgent(userId, message); }
      catch (e) { console.error('runConversationAgent failed:', e); return ''; }
    })();

    // Legacy/fallback fetches (start in parallel)
    const profilePromise = getProfile(userId).catch(e => { console.error('getProfile failed:', e); return {}; });
    const progressPromise = getProgress(userId).catch(e => { console.error('getProgress failed:', e); return {}; });
    const weaknessesPromise = fetchUserWeaknesses(userId).catch(e => { console.error('fetchUserWeaknesses failed:', e); return []; });
    const formattedProgressPromise = formatProgressForAI(userId).catch(e => { console.error('formatProgressForAI failed:', e); return ''; });
    const userNamePromise = getUserDisplayName(userId).catch(e => { console.error('getUserDisplayName failed:', e); return ''; });

    // --- 3. Per-agent safety timeouts & allSettled ---
    const AGENT_TIMEOUT_MS = 5000; // adjust as desired

    const memoryRace = Promise.race([
      memoryPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);
    const curriculumRace = Promise.race([
      curriculumPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);
    const conversationRace = Promise.race([
      conversationPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);

    const [memSettled, curSettled, convSettled] = await Promise.allSettled([
      memoryRace, curriculumRace, conversationRace
    ]);

    const memoryReportRaw = (memSettled.status === 'fulfilled' && memSettled.value) ? memSettled.value : '';
    const curriculumReportRaw = (curSettled.status === 'fulfilled' && curSettled.value) ? curSettled.value : '';
    const conversationReportRaw = (convSettled.status === 'fulfilled' && convSettled.value) ? convSettled.value : '';

    // --- 4. Ensure we have legacy profile data for fallback & additional context ---
    const [memoryProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
      profilePromise, progressPromise, weaknessesPromise, formattedProgressPromise, userNamePromise
    ]);

    const profileSummary = (memoryProfile && memoryProfile.profileSummary) ? memoryProfile.profileSummary : 'No profile summary available.';

    // Prefer agent output; fall back to profile summary if memory agent returned nothing
    const memoryReport = String(memoryReportRaw || (`NOTE: The memory agent failed. This is a fallback using the full user profile: ${profileSummary}`)).trim();
    const curriculumReport = String(curriculumReportRaw || '').trim();
    const conversationReport = String(conversationReportRaw || '').trim();

    // --- 5. Build history snippet safely ---
    const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
      .map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`)
      .join('\n');

    // --- 6. Final comprehensive prompt for the Decider ---
    const finalPrompt = `You are EduAI, a genius, witty, and deeply personal AI companion.
This is the user's question: "${escapeForPrompt(safeSnippet(message, 2000))}"

Here is the complete intelligence briefing from your specialist team. Use it to formulate a brilliant, personal response.

<memory_report_psychologist>
${escapeForPrompt(safeSnippet(memoryReport, 4000)) || 'No long-term memory is relevant to this query.'}
</memory_report_psychologist>

<curriculum_report_academic_advisor>
${escapeForPrompt(safeSnippet(curriculumReport || 'This question does not link to a specific lesson in their plan.', 4000))}
</curriculum_report_academic_advisor>

<conversation_report_context_keeper>
${escapeForPrompt(safeSnippet(conversationReport || 'This appears to be a new topic of conversation.', 4000))}
</conversation_report_context_keeper>

<conversation_history>
${lastFive}
</conversation_history>

Student progress summary (short): ${escapeForPrompt(safeSnippet(formattedProgress || 'No progress summary.', 1000))}
Student weaknesses (short): ${escapeForPrompt(safeSnippet(Array.isArray(weaknesses) ? weaknesses.join('; ') : String(weaknesses || ''), 1000))}

Respond as EduAI in the user's language. Be personal, friendly (non-formal), and concise. If the question is curriculum-related, prefer step-by-step guidance and examples.`;

    // --- 7. Call the Decider / responder model ---
    const modelResp = await generateWithFailover('chat', finalPrompt, {
      label: 'InteractiveChat-Decider',
      timeoutMs: (CONFIG && CONFIG.TIMEOUTS && CONFIG.TIMEOUTS.chat) ? CONFIG.TIMEOUTS.chat : undefined
    });

    const fullReplyText = await extractTextFromResult(modelResp);
    const botReply = fullReplyText || 'عذراً، لم أتمكن من إنشاء رد الآن.';

    // --- 8. Save conversation & background tasks (fire-and-forget with logging) ---
    const userMessageObj = { author: 'user', text: message, timestamp: new Date().toISOString() };
    const botMessageObj = { author: 'bot', text: botReply, timestamp: new Date().toISOString() };
    const updatedHistory = [...history, userMessageObj, botMessageObj];

    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main_chat', context)
      .catch(e => console.error('saveChatSession failed (fire-and-forget):', e));

    if (updatedHistory.length % 6 === 0) { // analyze every 3 user/bot pairs
      analyzeAndSaveMemory(userId, updatedHistory.slice(-6))
        .catch(e => console.error('analyzeAndSaveMemory failed (fire-and-forget):', e));
    }

    // --- 9. Return response to client ---
    res.status(200).json({
      reply: botReply,
      sessionId,
      chatTitle,
      // Useful for debugging; comment out or remove in production:
      // agentReports: { memoryReport, curriculumReport, conversationReport }
    });
  } catch (err) {
    console.error('/chat-interactive error:', err.stack || err);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});
const procrastinationTimers = new Map();

/**
 * مفتاح الـ Map سيكون userId:eventName
 * الفكرة: إذا جاء نفس الحدث عدة مرات بسرعة نخلي آخر حدث "يفوز" ونشغّل المدرب بعد تأخير صغير
 * هذا يمنع إطلاق مهام زائدة عند تكرار النقرات/الأحداث السريعة.
 */
function scheduleTriggerLiveCoach(userId, eventName, eventData) {
  const key = `${userId}:${eventName}`;
  const DELAY_MS = 1000; // تأخير صغير قبل تشغيل المدرب (يمكن تعديلها)

  // إن كان هناك مؤقت سابق لنفس المفتاح، نلغيه لنؤخر التنفيذ
  const prev = procrastinationTimers.get(key);
  if (prev) clearTimeout(prev);

  // نضع مؤقت جديد يستدعي triggerLiveCoach بعد DELAY_MS
  const timer = setTimeout(async () => {
    procrastinationTimers.delete(key);
    try {
      await triggerLiveCoach(userId, eventName, eventData);
    } catch (err) {
      // لا نرمي الخطأ إلى العميل — فقط نسجّل داخلياً
      console.error('triggerLiveCoach error for', key, err);
    }
  }, DELAY_MS);

  procrastinationTimers.set(key, timer);
}

/**
 * دالة stub للمدرّب المباشر — عدّلها لتستدعي سير عملك الحقيقي
 * يجب أن تكون غير معتمدة على استجابة العميل.
 */
async function triggerLiveCoach(userId, eventName, eventData) {
  // قاعدة المبتدئ: لا تتدخل مع المستخدمين الجدد جدًا
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return;
  const userCreationDate = userDoc.createTime.toDate();
  const daysSinceJoined = (new Date() - userCreationDate) / (1000 * 60 * 60 * 24);
  if (daysSinceJoined < 2) {
    return; // هذا مستخدم جديد، لا تتدخل
  }

  // الآن، لنحلل الحدث
  switch (eventName) {
    case 'lesson_view_start':
      // إذا بدأ المستخدم درسًا، فهذا يعني أنه ليس مماطلاً. قم بإلغاء أي مؤقت تسويف.
      if (procrastinationTimers.has(userId)) {
        clearTimeout(procrastinationTimers.get(userId));
        procrastinationTimers.delete(userId);
      }

      // تحقق مما إذا كان الدرس مجدولاً
      const progress = await getProgress(userId);
      const isPlanned = progress?.dailyTasks?.tasks?.some(task => task.relatedLessonId === eventData.lessonId);
      
      if (!isPlanned) {
        // الدرس غير مجدول! تدخل بذكاء.
        const message = await runInterventionManager('unplanned_lesson', { lessonTitle: eventData.lessonTitle });
        await sendUserNotification(userId, { title: 'مبادرة رائعة!', message });
      }
      break;

    case 'started_study_timer':
      // بدأ المستخدم مؤقت الدراسة. لنراقب ما إذا كان سيبدأ بالفعل.
      const timerId = setTimeout(async () => {
        // بعد دقيقتين، تحقق مما إذا كان المستخدم قد بدأ أي شيء
        const recentEvents = await db.collection('userBehaviorAnalytics').doc(userId).collection('events')
          .orderBy('timestamp', 'desc').limit(1).get();
        
        const lastEvent = recentEvents.docs[0]?.data();
        // إذا كان آخر حدث لا يزال هو "بدء المؤقت"، فهذا يعني أنه لم يفعل شيئًا
        if (lastEvent && lastEvent.name === 'started_study_timer') {
          const message = await runInterventionManager('timer_procrastination');
          await sendUserNotification(userId, { title: 'هل تحتاج مساعدة؟', message });
        }
        procrastinationTimers.delete(userId);
      }, 120000); // دقيقتان

      procrastinationTimers.set(userId, timerId);
      break;
  }
}
async function runInterventionManager(interventionType, data = {}) {
  let prompt;
  const language = 'Arabic'; // يمكن جعله ديناميكيًا لاحقًا

  const strictRules = `
<rules>
1.  Your response MUST be ONLY the final notification text, directly usable for the user.
2.  The text MUST be in natural, user-friendly ${language}.
3.  ABSOLUTELY NO conversational filler. Do not say "Here is the notification" or "Of course!".
</rules>
`;

  switch (interventionType) {
    case 'unplanned_lesson':
      prompt = `A user has proactively started studying a lesson titled "${data.lessonTitle}" that was NOT on their to-do list.
      Write a short, positive notification (1-2 sentences) that praises their initiative and gently asks if they'd like to add it to their daily plan.
      ${strictRules}`;
      break;
    
    case 'timer_procrastination':
      prompt = `A user started a study timer 2 minutes ago but hasn't started any lesson. They might be stuck.
      Write a short, gentle, and helpful notification (1-2 sentences) asking if everything is okay and if they need help choosing a task.
      ${strictRules}`;
      break;

    default:
      return '';
  }

   try {
    // لا حاجة لتغيير هذا الجزء
    const res = await generateWithFailover('notification', prompt, { label: 'InterventionManager' });
    // سنقوم بتنظيف النص كإجراء احترازي إضافي
    const rawText = await extractTextFromResult(res);
    return rawText.replace(/["']/g, '').trim(); // إزالة أي علامات اقتباس قد يضيفها النموذج
  } catch (error) {
    console.error(`InterventionManager failed for type ${interventionType}:`, error);
    return "نحن هنا للمساعدة إذا احتجت أي شيء!";
  }
}
app.post('/log-event', async (req, res) => {
  try {
    const { userId, eventName, eventData = {} } = req.body;

    if (!userId || !eventName) {
      return res.status(400).json({ error: 'userId and eventName are required.' });
    }

    // مرجع الوثيقة للمستخدم
    const analyticsRef = db.collection('userBehaviorAnalytics').doc(userId);

    // 1) نسجل الحدث في المجموعة الفرعية events
    await analyticsRef.collection('events').add({
      name: eventName,
      data: eventData,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2) نحدث بعض المقاييس الرئيسة للوصول السريع
    if (eventName === 'lesson_view_start') {
      await analyticsRef.set({
        lessonsViewedCount: admin.firestore.FieldValue.increment(1),
      }, { merge: true });
    }

    // 3) نرد على التطبيق فوراً — نقول له أن التسجيل تم والمدرّب سيحلله
    res.status(202).json({ message: 'Event logged. Coach is analyzing.' });

    // 4) بعد إرسال الرد، نبرمج تشغيل المدرّب في الخلفية (debounced)
    //    نستخدم scheduleTriggerLiveCoach لكي نتجنّب إطلاق المدرّب بكثافة إن تكرر نفس الحدث بسرعة
    scheduleTriggerLiveCoach(userId, eventName, eventData);

  } catch (error) {
    console.error('/log-event error:', error);
    // مهم: إذا حصل خطأ قبل الرد، نبلّغ العميل؛ أما إذا حصل بعد الرد فهو يُسجّل داخل triggerLiveCoach
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to log event.' });
    } else {
      // في حال تم ارسال الرد بالفعل، فقط نطبع الخطأ (لا نقدر نغيّر الاستجابة)
      console.error('Error after response sent:', error);
    }
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
 app.post('/process-session', async (req, res) => {
      const { userId, sessionId } = req.body;

      if (!userId || !sessionId) {
        return res.status(400).json({ error: 'userId and sessionId are required.' });
      }

      // لا ننتظر انتهاء التحليل، بل نرد على التطبيق فورًا
      // هذا يجعل التطبيق سريعًا ولا يتأثر بعمليات التحليل
      res.status(202).json({ message: 'Session processing started.' });

      // تشغيل دالة التحليل في الخلفية
      processSessionAnalytics(userId, sessionId).catch(e => console.error('Background processing failed:', e));
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
const NIGHTLY_JOB_SECRET = process.env.NIGHTLY_JOB_SECRET || 'vl&h{`4^9)fUy3Mw30_FqXfU~UwIE0K6@*2j_4]1';

// 2. أنشئ نقطة النهاية الجديدة+
app.post('/run-nightly-analysis', async (req, res) => {
  try {
    // تحقق من المفتاح السري
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // أرسل ردًا فوريًا لتأكيد استلام الطلب
    res.status(202).json({ message: 'Nightly analysis job started.' });

    // الآن، قم بتشغيل المنطق الثقيل في الخلفية
    console.log(`[${new Date().toISOString()}] Starting nightly analysis...`);
    
    // ابحث عن المستخدمين غير النشطين
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const inactiveUsersSnapshot = await db.collection('userProgress')
      .where('lastLogin', '<', twoDaysAgo)
      .get();

    if (inactiveUsersSnapshot.empty) {
      console.log('No inactive users found. Job finished.');
      return;
    }

    // قم بتشغيل التحليل لكل مستخدم غير نشط
    const analysisPromises = [];
    inactiveUsersSnapshot.forEach(doc => {
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    console.log(`Nightly analysis finished for ${inactiveUsersSnapshot.size} users.`);

  } catch (error) {
    console.error('[/run-nightly-analysis] Critical error:', error);
  }
});
  app.post('/generate-chat-suggestions', async (req, res) => {
      try {
        const { userId } = req.body;
        if (!userId) {
          return res.status(400).json({ error: 'userId is required.' });
        }
        
        // استدعاء المدير الجديد الذي سنبنيه
        const suggestions = await runSuggestionManager(userId);
        
        res.status(200).json({ suggestions });

      } catch (error) {
        console.error('/generate-chat-suggestions error:', error.stack);
        // في حالة الفشل، أرسل اقتراحات افتراضية حتى لا تتعطل الواجهة
        const fallbackSuggestions = ["ما هي مهامي اليومية؟", "لخص لي آخر درس درسته", "حلل أدائي الدراسي"];
        res.status(500).json({ suggestions: fallbackSuggestions });
      }
    });

app.post('/generate-title', async (req, res) => {
  try {
    const { message, language = 'Arabic' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text, no JSON or extra words.\n\nMessage: "${escapeForPrompt(safeSnippet(message, 300))}"\n\nTitle:`;

    const modelResp = await generateWithFailover('titleIntent', prompt, {
      label: 'GenerateTitle',
      timeoutMs: 5000, // timeout قصير لأنها مهمة سريعة
    });

    const title = await extractTextFromResult(modelResp);

    if (!title) {
      // fallback بسيط في حال فشل النموذج
      return res.json({ title: message.substring(0, 30) });
    }

    return res.json({ title: title.replace(/["']/g, '') }); // إزالة أي علامات اقتباس
  } catch (err) {
    console.error('/generate-title error:', err.stack);
    // إرجاع عنوان احتياطي في حالة حدوث خطأ فادح
    const fallbackTitle = req.body.message ? req.body.message.substring(0, 30) : 'New Chat';
    return res.status(500).json({ title: fallbackTitle });
  }
});
async function runSuggestionManager(userId) {
      // 1. جمع البيانات بشكل متزامن لسرعة الأداء
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentChatsPromise = db.collection('chatSessions')
        .where('userId', '==', userId)
        .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(twentyFourHoursAgo))
        .orderBy('updatedAt', 'desc')
        .limit(3) // آخر 3 محادثات
        .get();

      const [profile, progress, weaknesses, recentChatsSnapshot] = await Promise.all([
        getProfile(userId),
        getProgress(userId),
        fetchUserWeaknesses(userId),
        recentChatsPromise
      ]);

      // 2. تنسيق البيانات للمُوجّه
      const profileSummary = profile.profileSummary || 'لا يوجد ملخص للملف الشخصي.';
      const currentTasks = progress?.dailyTasks?.tasks?.map(t => `- ${t.title} (${t.status})`).join('\n') || 'لا توجد مهام حالية.';
      
      let recentConversation = 'لا توجد محادثات حديثة.';
      if (!recentChatsSnapshot.empty) {
        const lastChat = recentChatsSnapshot.docs[0].data();
        recentConversation = `آخر محادثة كانت بعنوان "${lastChat.title}" وتضمنت: ${lastChat.messages.slice(-2).map(m => `${m.author}: ${m.text}`).join(' ... ')}`;
      }

      // 3. صياغة المُوجّه الذكي
      const prompt = `You are a proactive AI assistant. Your goal is to generate 3 highly relevant and predictive chat prompts for a user based on their complete profile.

      <user_context>
        <profile_summary>${profileSummary}</profile_summary>
        <current_tasks>${currentTasks}</current_tasks>
        <recent_conversation_topic>${recentConversation}</recent_conversation_topic>
        <identified_weaknesses>${weaknesses.map(w => w.lessonTitle).join(', ')}</identified_weaknesses>
      </user_context>

      <rules>
      1.  Generate three distinct, short, and engaging questions in Arabic.
      2.  The suggestions should feel personal and predictive, not generic.
      3.  One suggestion could be a follow-up to the last conversation.
      4.  Another could be about a pending task or a known weakness.
      5.  The third can be a general question based on their long-term goals (from profile summary).
      6.  Respond ONLY with a valid JSON object in the format: { "suggestions": ["اقتراح 1", "اقتراح 2", "اقتراح 3"] }
      </rules>`;

      // 4. استدعاء النموذج السريع وإرجاع النتيجة
      const res = await generateWithFailover('analysis', prompt, { label: 'SuggestionManager' });
      const raw = await extractTextFromResult(res);
      const parsed = await ensureJsonOrRepair(raw, 'analysis');

      if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length === 3) {
        return parsed.suggestions;
      }

      // إرجاع اقتراحات افتراضية قوية في حال فشل النموذج
      return ["ما هي أهم أولوياتي اليوم؟", "كيف أتحسن في نقاط ضعفي؟", "اقتراح خطة دراسية جديدة"];
    }
async function generateTitle(message, language = 'Arabic') {
  const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text, no JSON or extra words.

Message: "${escapeForPrompt(safeSnippet(message, 300))}"

Title:`;
  try {
    const modelResp = await generateWithFailover('titleIntent', prompt, { label: 'GenerateTitle', timeoutMs: 5000 });
    const title = await extractTextFromResult(modelResp);
    if (!title) return message.substring(0, 30);
    return title.replace(/["']/g, '').trim();
  } catch (e) {
    console.warn('generateTitle fallback:', e && e.message ? e.message : e);
    return message.substring(0, 30);
  }
}
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
