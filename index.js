// server.js — Final Production Version (EduAI Brain V10)
'use strict';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

// --- Configuration ---
const PORT = Number(process.env.PORT || 3000);
const CHAT_MODEL_NAME = process.env.CHAT_MODEL_NAME || 'gemini-1.5-flash';
const TITLE_MODEL_NAME = process.env.TITLE_MODEL_NAME || 'gemini-1.5-flash';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);
const BODY_LIMIT = process.env.BODY_LIMIT || '150kb';

// --- Env Checks ---
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

// --- Helpers ---
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    const resp = result.response ? await result.response : result;
    // If response object supports text()
    if (resp && typeof resp.text === 'function') {
      const t = await resp.text();
      return (t || '').toString().trim();
    }
    if (typeof resp.text === 'string' && resp.text.trim().length) return resp.text.trim();
    if (typeof resp.outputText === 'string' && resp.outputText.trim()) return resp.outputText.trim();
    if (Array.isArray(resp.content) && resp.content.length) {
      return resp.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    }
    if (Array.isArray(resp.candidates) && resp.candidates.length) {
      return resp.candidates.map(c => c?.text || '').join('').trim();
    }
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
  return String(s).replace(/<\/+/g, '<\\/');
}

function sanitizeLanguage(langCandidate) {
  if (!langCandidate || typeof langCandidate !== 'string') return 'Arabic';
  const token = langCandidate.split(/[^a-zA-Z]+/).find(Boolean);
  if (!token) return 'Arabic';
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

// --- Firestore Helpers ---
async function fetchMemoryProfile(userId) {
  try {
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    if (doc.exists && doc.data()?.profileSummary) return String(doc.data().profileSummary);
  } catch (err) {
    console.error(`Error fetching memory profile for ${userId}:`, err && err.message ? err.message : err);
  }
  return 'No available memory.';
}

async function fetchUserProgress(userId) {
  try {
    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() || {};
      return {
        points: d.stats?.points || 0,
        streak: d.streakCount || 0,
        fullDoc: d,
      };
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

// --- NEW: fetchUserWeaknesses ---
async function fetchUserWeaknesses(userId) {
  try {
    const doc = await db.collection('userProgress').doc(userId).get();
    if (!doc.exists) return [];
    const progressData = doc.data()?.pathProgress || {};
    const weaknesses = [];
    // progressData is expected to be an object keyed by pathId
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

// ----------------- Endpoints -----------------

// --- /chat (improved) ---
app.post('/chat', async (req, res) => {
  try {
    const { userId, message, history = [], lessonId = null } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'Invalid request.' });

    // Fetch context
    const [memorySummary, userProgress, detectedLangRaw, lessonContentRaw] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message),
      lessonId ? fetchLessonContent(lessonId) : Promise.resolve(null),
    ]);

    const detectedLang = sanitizeLanguage(detectedLangRaw);
    const safeMessage = escapeForPrompt(safeSnippet(message));
    const formattedHistory = (history || []).slice(-5).map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${String(h.text || '').replace(/\n/g, ' ')}`).join('\n');

    // Build prompt (you can expand as needed)
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

    const modelResult = await withTimeout(chatModel.generateContent(finalPrompt), REQUEST_TIMEOUT_MS, 'chat model');
    const rawReply = await extractTextFromResult(modelResult);

    // Try to parse JSON action
    let actionResponse = null;
    try {
      const cleaned = (rawReply || '').trim();
      // attempt to parse whole text as JSON or extract first JSON object
      try {
        const parsedWhole = JSON.parse(cleaned);
        if (parsedWhole && parsedWhole.action === 'manage_tasks' && parsedWhole.userRequest) actionResponse = parsedWhole;
      } catch (e) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
          const candidate = cleaned.slice(start, end + 1);
          const parsed = JSON.parse(candidate);
          if (parsed && parsed.action === 'manage_tasks' && parsed.userRequest) actionResponse = parsed;
        }
      }
    } catch (err) {
      // ignore parse errors
      actionResponse = null;
    }

    if (actionResponse) {
      console.log(`🧠 Action detected: manage_tasks | "${actionResponse.userRequest}"`);
      // Server-to-server background trigger to update tasks (fire-and-forget)
      try {
        fetch(`http://localhost:${PORT}/update-daily-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, userRequest: actionResponse.userRequest }),
          timeout: 5000,
        }).catch(err => {
          console.error('Failed to trigger background task update:', err && err.message ? err.message : err);
        });
      } catch (err) {
        console.error('Failed initiating background fetch:', err && err.message ? err.message : err);
      }

      const confirmationMessage = "بالتأكيد! أنا أعمل على تحديث مهامك الآن. ستراها في شاشتك الرئيسية بعد لحظات.";
      return res.json({ reply: confirmationMessage });
    }

    return res.json({ reply: rawReply || "لم أستطع توليد رد مناسب." });
  } catch (err) {
    console.error('❌ /chat error:', err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Model request timed out.' });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- /update-daily-tasks (modify tasks based on chat request) ---
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body;
    if (!userId || !userRequest) return res.status(400).json({ error: 'userId and userRequest are required.' });

    const progressDoc = await db.collection('userProgress').doc(userId).get();
    const currentTasks = progressDoc.exists ? progressDoc.data().dailyTasks?.tasks || [] : [];

    const modificationPrompt = `
<role>You are an intelligent task manager. Modify a user's task list based on their request. Respond ONLY with a valid JSON object: { "tasks": [...] }.</role>
<current_tasks>${JSON.stringify(currentTasks)}</current_tasks>
<user_request>"${escapeForPrompt(userRequest)}"</user_request>
<instructions>Modify the list. Titles must be in Arabic. Maintain all required fields.</instructions>
`.trim();

    const result = await withTimeout(chatModel.generateContent(modificationPrompt), REQUEST_TIMEOUT_MS, 'task modification');
    const rawJson = await extractTextFromResult(result);
    const cleanedJson = (rawJson || '').replace(/```json|```/g, '').trim();

    // robust parse
    let updatedTasksPayload = null;
    try {
      updatedTasksPayload = JSON.parse(cleanedJson);
    } catch (e) {
      const start = cleanedJson.indexOf('{');
      const end = cleanedJson.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          updatedTasksPayload = JSON.parse(cleanedJson.slice(start, end + 1));
        } catch (e2) {
          console.error('Failed to parse JSON from model response:', e2 && e2.message ? e2.message : e2);
          throw new Error('Model returned invalid JSON.');
        }
      } else {
        throw new Error('Model returned invalid JSON.');
      }
    }

    if (!updatedTasksPayload || !Array.isArray(updatedTasksPayload.tasks)) {
      throw new Error('Model did not return a valid updated tasks array.');
    }

    await db.collection('userProgress').doc(userId).update({
      'dailyTasks.tasks': updatedTasksPayload.tasks,
      'dailyTasks.generatedAt': admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, tasks: updatedTasksPayload.tasks });
  } catch (err) {
    console.error('❌ Error in /update-daily-tasks:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to update daily tasks.' });
  }
});

// --- /generate-daily-tasks (improved, uses weaknesses) ---
app.post('/generate-daily-tasks', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

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

    const result = await withTimeout(chatModel.generateContent(taskPrompt), REQUEST_TIMEOUT_MS, 'task generation');
    const rawJson = await extractTextFromResult(result);
    const cleanedJson = (rawJson || '').replace(/```json|```/g, '').trim();

    // robust parse
    let newTasksPayload = null;
    try {
      newTasksPayload = JSON.parse(cleanedJson);
    } catch (e) {
      const start = cleanedJson.indexOf('{');
      const end = cleanedJson.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          newTasksPayload = JSON.parse(cleanedJson.slice(start, end + 1));
        } catch (e2) {
          console.error('Failed to parse tasks JSON from model:', e2 && e2.message ? e2.message : e2, 'raw:', rawJson);
          throw e2;
        }
      } else {
        throw e;
      }
    }

    if (!newTasksPayload || !Array.isArray(newTasksPayload.tasks)) {
      throw new Error('Model did not return a valid tasks array.');
    }

    // ensure each task has id, status, timestamps
    const tasksToSave = newTasksPayload.tasks.map(task => ({
      ...task,
      id: task.id || (String(Date.now()) + Math.random().toString(36).substring(7)),
      status: task.status || 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));

    await db.collection('userProgress').doc(userId).update({
      'dailyTasks.tasks': tasksToSave,
      'dailyTasks.generatedAt': admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, tasks: tasksToSave });
  } catch (err) {
    console.error('❌ Error in /generate-daily-tasks:', err && err.message ? err.message : err);
    // fallback task
    const fallbackTasks = [{
      id: String(Date.now()),
      title: 'مراجعة سريعة',
      type: 'Review',
      status: 'pending',
      relatedLessonId: null,
      relatedSubjectId: null,
      description: 'قم بمراجعة سريعة لموضوع مهم لمدة 30 دقيقة.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }];
    try {
      if (req.body?.userId) {
        await db.collection('userProgress').doc(req.body.userId).update({
          'dailyTasks.tasks': fallbackTasks,
          'dailyTasks.generatedAt': admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (saveErr) {
      console.error('⚠️ Failed to save fallback task:', saveErr && saveErr.message ? saveErr.message : saveErr);
    }
    return res.status(500).json({ error: 'Failed to generate tasks.', tasks: fallbackTasks });
  }
});

// --- Health ---
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 EduAI Brain V10 running on port ${PORT}`);
  console.log(`💬 Chat model: ${CHAT_MODEL_NAME}`);
  console.log(`🏷️ Title model: ${TITLE_MODEL_NAME}`);
});
