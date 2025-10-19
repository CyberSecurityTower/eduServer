// server.js (النسخة المحسنة والنهائية)
'use strict';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch'); // --- 1. أضف هذا السطر ---

// ----------------- Configuration -----------------
const PORT = Number(process.env.PORT || 3000);
const CHAT_MODEL_NAME = process.env.CHAT_MODEL_NAME || 'gemini-2.5-flash';
const TITLE_MODEL_NAME = process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000); // 20s default
const BODY_LIMIT = process.env.BODY_LIMIT || '150kb';

// ----------------- Basic env checks -----------------
if (!process.env.GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY env var. Exiting.');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
  process.exit(1);
}

// ----------------- App init -----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: BODY_LIMIT }));

// ----------------- Firebase initialization (robust parsing) -----------------
let db;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  // Try parsing in three ways:
  // 1) direct JSON parse
  // 2) repair literal newlines by escaping them -> parse
  // 3) base64 decode -> parse
  let serviceAccount;
  let firstErr, secondErr, thirdErr;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (e1) {
    firstErr = e1;
    try {
      // Replace literal newlines with escaped newlines and try again
      const repaired = raw.replace(/\r?\n/g, '\\n');
      serviceAccount = JSON.parse(repaired);
    } catch (e2) {
      secondErr = e2;
      try {
        // Try base64 decode
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
      } catch (e3) {
        thirdErr = e3;
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY. Details:');
        console.error('Direct parse error:', firstErr && firstErr.message);
        console.error('Repaired parse error:', secondErr && secondErr.message);
        console.error('Base64 parse error:', thirdErr && thirdErr.message);
        throw new Error('Unable to parse FIREBASE_SERVICE_ACCOUNT_KEY. Ensure it is valid JSON (with \\n escapes) or base64-encoded.');
      }
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized.');
} catch (err) {
  console.error('Firebase Admin initialization failed:', err.message || err);
  process.exit(1);
}

// ----------------- Google Generative AI initialization -----------------
let genAI, chatModel, titleModel;
try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  chatModel = genAI.getGenerativeModel({ model: CHAT_MODEL_NAME });
  titleModel = genAI.getGenerativeModel({ model: TITLE_MODEL_NAME });
  console.log(`Generative AI initialized. Chat model: ${CHAT_MODEL_NAME}, Title model: ${TITLE_MODEL_NAME}`);
} catch (err) {
  console.error('Failed to initialize GoogleGenerativeAI SDK:', err.message || err);
  process.exit(1);
}

// ----------------- Helpers -----------------

/**
 * Robustly extract plain text from SDK result shapes.
 * Handles common shapes where `result.response` exists and may have async text().
 */
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    // result.response may be a Promise or an object
    const resp = result.response ? await result.response : result;
    if (!resp) return '';

    // If resp has async text() method
    if (typeof resp.text === 'function') {
      const t = await resp.text();
      return (t || '').toString().trim();
    }

    // Common string properties
    if (typeof resp.text === 'string' && resp.text.trim().length) return resp.text.trim();
    if (typeof resp.outputText === 'string' && resp.outputText.trim()) return resp.outputText.trim();

    // Some SDKs return structured content arrays
    if (Array.isArray(resp.content) && resp.content.length) {
      return resp.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    }

    // Some shapes might include `candidates` or `items`
    if (Array.isArray(resp.candidates) && resp.candidates.length) {
      return String(resp.candidates.map(c => c?.text || '').join('')).trim();
    }

    // Last resort: stringify
    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

/**
 * Promise timeout wrapper
 */
function withTimeout(promise, ms = REQUEST_TIMEOUT_MS, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Truncate long strings safely and mark truncation.
 */
function safeSnippet(text, max = 6000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n... [truncated]';
}

/**
 * Escape sequences that might accidentally close our tags.
 */
function escapeForPrompt(s) {
  if (!s) return '';
  return String(s).replace(/<\/+/g, '<\\/');
}

/**
 * Sanitize language candidate (very small normalization)
 */
function sanitizeLanguage(langCandidate) {
  if (!langCandidate || typeof langCandidate !== 'string') return 'Arabic';
  const token = langCandidate.split(/[^a-zA-Z]+/).find(Boolean);
  if (!token) return 'Arabic';
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

// ----------------- Firestore helpers -----------------

async function fetchMemoryProfile(userId) {
  try {
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    if (doc.exists && doc.data()?.profileSummary) {
      return String(doc.data().profileSummary);
    }
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
      };
    }
  } catch (err) {
    console.error(`Error fetching progress for ${userId}:`, err && err.message ? err.message : err);
  }
  return { points: 0, streak: 0 };
}

async function fetchLessonContent(lessonId) {
  try {
    if (!lessonId) return null;
    const doc = await db.collection('lessonsContent').doc(lessonId).get();
    if (doc.exists && doc.data()?.content) {
      return String(doc.data().content);
    }
  } catch (err) {
    console.error(`Error fetching lesson content for ${lessonId}:`, err && err.message ? err.message : err);
  }
  return null;
}

// ----------------- Language detection -----------------

async function detectLanguage(message) {
  try {
    if (!message || typeof message !== 'string') return 'Arabic';
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${message.replace(/"/g, '\\"')}"`;
    const rawPromise = titleModel.generateContent(prompt);
    const rawResult = await withTimeout(rawPromise, REQUEST_TIMEOUT_MS, 'language detection');
    const rawText = await extractTextFromResult(rawResult);
    const lang = sanitizeLanguage(rawText);
    return lang;
  } catch (err) {
    console.error('Language detection failed:', err && err.message ? err.message : err);
    return 'Arabic';
  }
}

// ----------------- Task Management Logic (Helper Function) -----------------
async function applyTaskModification(userId, userRequest) {
  if (!userId || !userRequest) throw new Error('userId and userRequest required for task modification.');

  const progressDoc = await db.collection('userProgress').doc(userId).get();
  const currentTasks = progressDoc.exists() ? progressDoc.data().dailyTasks?.tasks || [] : [];

  const modificationPrompt = `
<role>
You are an intelligent task manager. Your job is to modify a user's existing task list based on their request.
The response MUST be a valid JSON object containing a single key "tasks", which is the complete, updated array of tasks. Do not include any other text or markdown formatting.

**Current Task List (JSON):**
${JSON.stringify(currentTasks, null, 2)}

**User's Modification Request:**
"${escapeForPrompt(userRequest)}"

**Instructions:**
1. Read the user's request and modify the current task list accordingly.
2. You can add, remove, or update tasks.
3. Ensure all tasks in the final array have the required fields: "id", "title" (in Arabic), "type", "status", "relatedLessonId" (can be null if not applicable).
4. Do not invent lesson IDs. If the user mentions a topic without an ID, set relatedLessonId to null.
5. Maintain existing tasks that were not mentioned in the request.
</role>
`.trim();

  const resultPromise = chatModel.generateContent(modificationPrompt);
  const result = await withTimeout(resultPromise, REQUEST_TIMEOUT_MS, 'task modification');
  const rawJson = await extractTextFromResult(result);

  let parsedTasks;
  try {
    const cleanedJson = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
    // try JSON.parse directly
    try {
      parsedTasks = JSON.parse(cleanedJson);
    } catch (e) {
      // attempt to extract the first {...} block
      const firstBrace = cleanedJson.indexOf('{');
      const lastBrace = cleanedJson.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = cleanedJson.slice(firstBrace, lastBrace + 1);
        parsedTasks = JSON.parse(candidate);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('Initial JSON parsing failed. Raw response:', rawJson);
    throw new Error('Model returned invalid JSON.');
  }

  if (!parsedTasks || !Array.isArray(parsedTasks.tasks)) {
    throw new Error('Model response did not contain a valid tasks array.');
  }

  const userProgressRef = db.collection('userProgress').doc(userId);
  await userProgressRef.set({
    dailyTasks: {
      tasks: parsedTasks.tasks,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }
  }, { merge: true });

  return parsedTasks.tasks;
}

// ----------------- Endpoints -----------------

app.post('/chat', async (req, res) => {
  try {
    const { userId, message } = req.body;
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const lessonId = req.body.lessonId || null;

    if (!userId || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid request.' });
    }

    // Fetch required data concurrently
    const lessonPromise = lessonId ? fetchLessonContent(lessonId) : Promise.resolve(null);
    const [memorySummary, dynamicData, detectedLanguageRaw, lessonContentRaw] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message),
      lessonPromise,
    ]);

    const detectedLanguage = sanitizeLanguage(detectedLanguageRaw);
    const lessonContent = lessonContentRaw ? escapeForPrompt(safeSnippet(String(lessonContentRaw))) : null;
    const safeMessage = escapeForPrompt(safeSnippet(message));
    const formattedHistory = (history || []).slice(-5).map(item => `${item.role === 'model' ? 'EduAI' : 'User'}: ${String(item.text || '').replace(/\n/g, ' ')}`).join('\n');
    const lessonContextBlock = lessonContent ? `<lesson_context>...</lesson_context>` : '';

    // --- يتضمن تعليمات الشخصية الجديدة التي أضفتها ---
    const finalPrompt = `
<role>
You are 'EduAI' (you can call yourself 'owl'), a smart, positive, and deeply empathetic study companion. Your primary goal is to be a helpful and motivating friend to the user. Use sophisticated and appropriate words. Avoid starting every message with a greeting like "hi" or "أهلاً". Treat the user like a close friend; you can be angry with them (if they haven't studied for a long time), or you can be: motivating, sad, helpful (according to the situation).
</role>

${lessonContextBlock}

<user_profile>
  <dynamic_data>
    - Current Points: ${Number(dynamicData.points || 0)}
    - Daily Streak: ${Number(dynamicData.streak || 0)}
  </dynamic_data>
  <static_memory>
    - Summary: ${escapeForPrompt(safeSnippet(memorySummary))}
  </static_memory>
</user_profile>

<conversation_context>
  <history>${formattedHistory || 'This is the beginning of the conversation.'}</history>
  <latest_message>${safeMessage}</latest_message>
</conversation_context>

<capabilities>
You can manage the user's daily tasks. If the user's message is a clear command to create, add, or modify their study plan, you MUST respond with a specific JSON object to trigger this action. Otherwise, respond normally.
**Trigger Condition:** Direct commands like "create a task for tomorrow", "add a quiz about history", "remind me to study at 8 PM".
**JSON Action Format:**
{
  "action": "manage_tasks",
  "userRequest": "The user's original and complete request text."
}
</capabilities>

<task>
1. Evaluate if the message meets the trigger condition in <capabilities>. If yes, respond with the JSON Action Format.
2. If no, generate a normal, helpful, text-based response.
**CRITICAL_RULE:** Your text response MUST be in **${detectedLanguage}**. The JSON action is always in English.
</task>
`.trim();

    const modelCallPromise = chatModel.generateContent(finalPrompt);
    const modelResult = await withTimeout(modelCallPromise, REQUEST_TIMEOUT_MS, 'chat model');
    const botReplyRaw = await extractTextFromResult(modelResult);

    // Try to robustly detect the JSON action
    let actionResponse = null;
    if (botReplyRaw && botReplyRaw.trim()) {
      const trimmed = botReplyRaw.trim();
      try {
        // direct parse
        const parsedDirect = JSON.parse(trimmed);
        if (parsedDirect && parsedDirect.action === 'manage_tasks' && parsedDirect.userRequest) {
          actionResponse = parsedDirect;
        }
      } catch (e) {
        // attempt to extract first JSON object substring
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const candidate = trimmed.slice(firstBrace, lastBrace + 1);
          try {
            const parsedCandidate = JSON.parse(candidate);
            if (parsedCandidate && parsedCandidate.action === 'manage_tasks' && parsedCandidate.userRequest) {
              actionResponse = parsedCandidate;
            }
          } catch (e2) {
            // not JSON
            actionResponse = null;
          }
        }
      }
    }

    // --- 2. التحسين الرئيسي هنا: استدعاء نقطة النهاية في الخلفية (fire-and-forget) ---
    if (actionResponse) {
      console.log(`Action detected: manage_tasks. Request: "${actionResponse.userRequest}"`);

      // Fire-and-forget background request to /update-daily-tasks
      try {
        const host = req.get('host') || 'localhost';
        // determine protocol (very simple heuristic)
        const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
        const url = `${protocol}://${host}/update-daily-tasks`;

        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userId, userRequest: actionResponse.userRequest }),
        }).catch(err => {
          console.error('Failed to trigger background task update:', err && err.message ? err.message : err);
        });
      } catch (err) {
        console.error('Failed to initiate background fetch for task update:', err && err.message ? err.message : err);
      }

      // Immediately send a confirmation message back to the user.
      const confirmationMessage = "بالتأكيد! أنا أعمل على تحديث مهامك الآن. ستراها في شاشتك الرئيسية بعد لحظات.";
      return res.json({ reply: confirmationMessage });

    } else {
      // Normal reply path
      const botReply = (botReplyRaw && botReplyRaw.length) ? botReplyRaw : "Sorry, I couldn't generate a response.";
      return res.json({ reply: botReply });
    }

  } catch (err) {
    console.error('Critical Error in /chat:', err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Model request timed out.' });
    }
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- 3. هذه نقطة النهاية تعمل الآن كعامل في الخلفية ---
app.post('/update-daily-tasks', async (req, res) => {
  try {
    const { userId, userRequest } = req.body;
    if (!userId || !userRequest) {
      return res.status(400).json({ error: 'userId and userRequest are required.' });
    }

    await applyTaskModification(userId, userRequest);
    res.status(200).json({ success: true, message: 'Tasks updated successfully in the background.' });
  } catch (err) {
    console.error('Error in /update-daily-tasks background job:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to update tasks.' });
  }
});

// ----------------- generate-title endpoint -----------------
app.post('/generate-title', async (req, res) => {
  try {
    const { message, language } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const safeMessage = safeSnippet(message, 2000).replace(/"/g, '\\"');
    const pickLanguage = sanitizeLanguage(language || 'Arabic');

    const titlePrompt = `
Summarize the following user message into a short, concise, and engaging chat title.
- The title must be a nominal phrase (جملة اسمية).
- The title must be in ${pickLanguage}.
- Respond with ONLY the title text (no extra commentary).
User Message: "${safeMessage}"
Title:
`.trim();

    const resultPromise = titleModel.generateContent(titlePrompt);
    const result = await withTimeout(resultPromise, REQUEST_TIMEOUT_MS, 'title model');
    const rawTitle = await extractTextFromResult(result);
    const title = (rawTitle || '').split('\n')[0].trim();

    if (!title) {
      return res.status(502).json({ error: 'Failed to generate a valid title.' });
    }

    return res.json({ title });
  } catch (err) {
    console.error('Error in /generate-title endpoint:', err && err.message ? err.message : err);
    if (err && err.message && err.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Title generation timed out.' });
    }
    return res.status(500).json({ error: 'Failed to generate title.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

// ----------------- Start server -----------------
app.listen(PORT, () => {
  console.log(`EduAI Brain V9 is running on port ${PORT}`);
  console.log(`Using Chat Model: ${CHAT_MODEL_NAME}`);
  console.log(`Using Title Model: ${TITLE_MODEL_NAME}`);
});
