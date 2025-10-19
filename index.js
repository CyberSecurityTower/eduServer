// server.js — Final Production Version (EduAI Brain V9)
'use strict';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

// ----------------- Configuration -----------------
const PORT = Number(process.env.PORT || 3000);
const CHAT_MODEL_NAME = process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash';
const TITLE_MODEL_NAME = process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const BODY_LIMIT = process.env.BODY_LIMIT || '150kb';

// ----------------- Env Checks -----------------
if (!process.env.GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY env var.');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var.');
  process.exit(1);
}

// ----------------- Express Init -----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: BODY_LIMIT }));

// ----------------- Firebase Init -----------------
let db;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    try {
      const repaired = raw.replace(/\r?\n/g, '\\n');
      serviceAccount = JSON.parse(repaired);
    } catch {
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
  console.error('❌ Firebase initialization failed:', err.message);
  process.exit(1);
}

// ----------------- Google Generative AI Init -----------------
let genAI, chatModel, titleModel;
try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  chatModel = genAI.getGenerativeModel({ model: CHAT_MODEL_NAME });
  titleModel = genAI.getGenerativeModel({ model: TITLE_MODEL_NAME });
  console.log(`🤖 AI initialized (Chat: ${CHAT_MODEL_NAME}, Title: ${TITLE_MODEL_NAME})`);
} catch (err) {
  console.error('❌ GoogleGenerativeAI init failed:', err.message);
  process.exit(1);
}

// ----------------- Helpers -----------------
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    const resp = result.response ? await result.response : result;
    if (resp?.text) return (await resp.text()).trim();
    if (typeof resp.outputText === 'string') return resp.outputText.trim();
    if (Array.isArray(resp.content)) return resp.content.map(c => c.text || '').join('').trim();
    if (Array.isArray(resp.candidates)) return resp.candidates.map(c => c.text || '').join('').trim();
    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err.message);
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
  return text.length <= max ? text : text.slice(0, max) + '\n\n... [truncated]';
}

function escapeForPrompt(s) {
  return String(s || '').replace(/<\/+/g, '<\\/');
}

function sanitizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return 'Arabic';
  const token = lang.split(/[^a-zA-Z]+/).find(Boolean);
  return token ? token[0].toUpperCase() + token.slice(1).toLowerCase() : 'Arabic';
}

// ----------------- Firestore Helpers -----------------
async function fetchMemoryProfile(userId) {
  try {
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    return doc.exists ? String(doc.data().profileSummary || '') : 'No memory.';
  } catch {
    return 'No memory.';
  }
}

async function fetchUserProgress(userId) {
  try {
    const doc = await db.collection('userProgress').doc(userId).get();
    const d = doc.exists ? doc.data() : {};
    return { points: d.stats?.points || 0, streak: d.streakCount || 0 };
  } catch {
    return { points: 0, streak: 0 };
  }
}

async function fetchLessonContent(lessonId) {
  try {
    if (!lessonId) return null;
    const doc = await db.collection('lessonsContent').doc(lessonId).get();
    return doc.exists ? String(doc.data().content || '') : null;
  } catch {
    return null;
  }
}

async function detectLanguage(message) {
  try {
    const prompt = `What is the main language of this text? Respond only with the language name: "${message}"`;
    const raw = await withTimeout(titleModel.generateContent(prompt), REQUEST_TIMEOUT_MS, 'lang detect');
    return sanitizeLanguage(await extractTextFromResult(raw));
  } catch {
    return 'Arabic';
  }
}

// ----------------- /chat Endpoint (FINAL VERSION) -----------------
app.post('/chat', async (req, res) => {
  try {
    const { userId, message, history = [], lessonId = null } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    // Fetch data
    const [memorySummary, dynamicData, detectedLangRaw, lessonContentRaw] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message),
      lessonId ? fetchLessonContent(lessonId) : Promise.resolve(null),
    ]);

    const detectedLang = sanitizeLanguage(detectedLangRaw);
    const safeMessage = escapeForPrompt(safeSnippet(message));
    const formattedHistory = history
      .slice(-5)
      .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${String(h.text).replace(/\n/g, ' ')}`)
      .join('\n');

    const prompt = `
<role>
You are 'EduAI' (nickname: "owl"), a smart, warm, and empathetic study companion. 
Speak naturally and emotionally, not robotic. Be encouraging, funny, or serious depending on the situation.
Avoid always starting with "Hi" or "أهلاً".
</role>

<user_profile>
  <dynamic_data>
    - Current Points: ${dynamicData.points}
    - Daily Streak: ${dynamicData.streak}
  </dynamic_data>
  <static_memory>
    ${escapeForPrompt(memorySummary)}
  </static_memory>
</user_profile>

<conversation_context>
${formattedHistory || 'This is a new conversation.'}
User: ${safeMessage}
</conversation_context>

<capabilities>
If the user's message is a command about managing or creating tasks (e.g. "create my tasks", "add a task", "remind me to study"),
respond with a JSON:
{
  "action": "manage_tasks",
  "userRequest": "<the user's full request>"
}
Otherwise, reply normally in ${detectedLang}.
</capabilities>
`;

    const modelResult = await withTimeout(chatModel.generateContent(prompt), REQUEST_TIMEOUT_MS, 'chat model');
    const rawReply = await extractTextFromResult(modelResult);

    // Try to detect JSON action
    let actionResponse = null;
    try {
      const cleaned = rawReply.trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (parsed.action === 'manage_tasks' && parsed.userRequest) actionResponse = parsed;
      }
    } catch {}

    if (actionResponse) {
      console.log(`🧠 Action detected: manage_tasks | "${actionResponse.userRequest}"`);
      const replyMsg = "بالتأكيد! أنا أستطيع تحديث مهامك. الآن، اضغط على زر 'إنشاء المهام' في شاشتك الرئيسية لتطبيق طلبك.";
      return res.json({ reply: replyMsg, action: actionResponse });
    }

    const reply = rawReply || "لم أستطع توليد رد مناسب.";
    res.json({ reply });
  } catch (err) {
    console.error('❌ /chat error:', err.message);
    if (err.message?.includes('timed out'))
      return res.status(504).json({ error: 'Model timeout.' });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ----------------- Health Check -----------------
app.get('/health', (req, res) =>
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' })
);
// ----------------- /generate-daily-tasks Endpoint -----------------
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId, pathId, userGoals } = req.body;

    if (!userId || !pathId) {
      return res.status(400).json({ error: 'User ID and Path ID are required.' });
    }

    // Fetch all data needed concurrently
    const [memorySummary, progressReport, dynamicData] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      fetchUserProgress(userId),
    ]);

    const lang = await detectLanguage(memorySummary);

    // Build the task generation prompt
    const formattedProgress = safeSnippet(JSON.stringify(progressReport, null, 2), 5000);

    const taskPrompt = `
<role>
You are 'EduAI', a highly specialized Study Manager AI. 
You are generating a personalized, balanced daily study plan for a PRO subscriber based on their progress and memory profile.
</role>
`.trim();

    // Call the model
    const modelCallPromise = chatModel.generateContent(taskPrompt);
    const modelResult = await withTimeout(modelCallPromise, REQUEST_TIMEOUT_MS, 'task generation model');
    const jsonString = await extractTextFromResult(modelResult);

    const cleanJson = jsonString.replace(/```json|```/g, '').trim();
    const tasks = JSON.parse(cleanJson);

    // Save tasks to Firestore
    const tasksToSave = tasks.map(task => ({
      ...task,
      id: String(Date.now()) + Math.random().toString(36).substring(7),
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));

    const userProgressRef = db.collection('userProgress').doc(userId);
    await userProgressRef.set({
      dailyTasks: {
        lastGenerated: admin.firestore.FieldValue.serverTimestamp(),
        tasks: tasksToSave,
      },
    }, { merge: true });

    res.json({ success: true, tasks: tasksToSave });

  } catch (err) {
    console.error("❌ Error in /generate-daily-tasks:", err.message);
    const fallbackTasks = [{
      type: "Progress",
      subjectName: "المشروع الشخصي",
      lessonTitle: "تطوير تطبيق EduApp",
      description: "العمل على إطلاق النسخة الأولية لتحقيق هدفك المالي.",
      estimatedTimeMin: 60,
      lessonId: null,
      id: String(Date.now())
    }];

    try {
      const { userId } = req.body;
      if (userId) {
        await db.collection('userProgress').doc(userId).set({
          dailyTasks: { tasks: fallbackTasks }
        }, { merge: true });
      }
    } catch (saveErr) {
      console.error("⚠️ Failed to save fallback task:", saveErr.message);
    }

    res.status(500).json({ error: 'Failed to generate tasks.', tasks: fallbackTasks });
  }
});

// ----------------- Start Server -----------------
app.listen(PORT, () => {
  console.log(`🚀 EduAI Brain V9 running on port ${PORT}`);
  console.log(`💬 Chat model: ${CHAT_MODEL_NAME}`);
  console.log(`🏷️ Title model: ${TITLE_MODEL_NAME}`);
});


