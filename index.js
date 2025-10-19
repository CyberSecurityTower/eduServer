//index.js
'use strict';

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const CHAT_MODEL_NAME = process.env.CHAT_MODEL_NAME || 'gemini-2.5-pro';
const TITLE_MODEL_NAME = process.env.TITLE_MODEL_NAME || 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000); // 20s default

// --- Basic env checks ---
if (!process.env.GOOGLE_API_KEY) {
  console.error('Missing GOOGLE_API_KEY env var. Exiting.');
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
  process.exit(1);
}

// --- Initialization ---
const app = express();

// Limit body size to protect from very large payloads (adjust as needed)
app.use(cors());
app.use(express.json({ limit: '200kb' }));

// Parse and initialize Firebase Admin
try {
  // Some platforms store JSON with escaped newlines. Normalize before parse.
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  // If the env var is a JSON string with `\n` newlines, unescape them
  if (raw.includes('\\n')) {
    raw = raw.replace(/\\n/g, '\n');
  }
  const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('Firebase Admin initialized.');
} catch (error) {
  console.error('Firebase Admin initialization failed:', error);
  process.exit(1);
}
const db = admin.firestore();

// Initialize Google Generative AI
let genAI;
let chatModel;
let titleModel;
try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  chatModel = genAI.getGenerativeModel({ model: CHAT_MODEL_NAME });
  titleModel = genAI.getGenerativeModel({ model: TITLE_MODEL_NAME });
  console.log(`Generative AI initialized. Chat model: ${CHAT_MODEL_NAME}, Title model: ${TITLE_MODEL_NAME}`);
} catch (error) {
  console.error('Failed to initialize GoogleGenerativeAI SDK:', error);
  process.exit(1);
}

// ----------------- Helpers -----------------

/**
 * Attempts to extract the final text from various SDK response shapes.
 * Works with a few possible structures:
 * - result.response.text() async method
 * - result.response.text string
 * - result.response.outputText
 * - result.response.content array [{ text: '...' }, ...]
 */
async function extractTextFromResult(result) {
  if (!result) return '';
  try {
    const resp = await (result.response ? result.response : result);
    if (!resp) return '';

    // If resp has a text() method (async)
    if (typeof resp.text === 'function') {
      const t = await resp.text();
      return (t || '').toString().trim();
    }

    // If text is a string property
    if (typeof resp.text === 'string' && resp.text.trim().length > 0) {
      return resp.text.trim();
    }

    if (typeof resp.outputText === 'string' && resp.outputText.trim().length > 0) {
      return resp.outputText.trim();
    }

    if (Array.isArray(resp.content)) {
      // Join pieces if present
      return resp.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    }

    // Fallback: try to stringify
    return String(resp).trim();
  } catch (err) {
    console.error('extractTextFromResult failed:', err);
    return '';
  }
}

/**
 * Wrap a Promise with a timeout.
 */
function withTimeout(promise, ms = REQUEST_TIMEOUT_MS, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Truncate a long string and mark it as truncated.
 */
function safeSnippet(text, max = 6000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n... [truncated]';
}

/**
 * Escape sequences that could interfere with custom tags in the prompt.
 */
function escapeForPrompt(s) {
  if (!s) return '';
  // Prevent `</` sequences from accidentally closing our tags
  return String(s).replace(/<\/+/g, '<\\/');
}

/**
 * Very small sanitizer for detected language values.
 * Keeps it simple: return the first token (letters only), capitalize.
 */
function sanitizeLanguage(langCandidate) {
  if (!langCandidate || typeof langCandidate !== 'string') return 'Arabic';
  const token = langCandidate.split(/[^a-zA-Z]+/).find(Boolean);
  if (!token) return 'Arabic';
  // Normalize common names (simple)
  const normalized = token[0].toUpperCase() + token.slice(1).toLowerCase();
  return normalized;
}

// ----------------- Firestore helpers -----------------

async function fetchMemoryProfile(userId) {
  try {
    const memoryDocRef = db.collection('aiMemoryProfiles').doc(userId);
    const memoryDoc = await memoryDocRef.get();
    if (memoryDoc.exists) {
      const d = memoryDoc.data();
      if (d && d.profileSummary) {
        return String(d.profileSummary);
      }
    }
  } catch (error) {
    console.error(`Error fetching memory for user ${userId}:`, error);
  }
  return 'No available memory.';
}

async function fetchUserProgress(userId) {
  try {
    const progressDocRef = db.collection('userProgress').doc(userId);
    const progressDoc = await progressDocRef.get();
    if (progressDoc.exists) {
      const data = progressDoc.data() || {};
      return {
        points: data.stats?.points || 0,
        streak: data.streakCount || 0,
      };
    }
  } catch (error) {
    console.error(`Error fetching progress for user ${userId}:`, error);
  }
  return { points: 0, streak: 0 };
}

async function fetchLessonContent(lessonId) {
  try {
    if (!lessonId) return null;
    const lessonRef = db.collection('lessonsContent').doc(lessonId);
    const lessonDoc = await lessonRef.get();
    if (lessonDoc.exists) {
      const data = lessonDoc.data();
      if (data && data.content) {
        return String(data.content);
      }
    }
  } catch (error) {
    console.error(`Error fetching lesson content for ID ${lessonId}:`, error);
  }
  return null;
}

// ----------------- Language detection using titleModel -----------------

async function detectLanguage(message) {
  try {
    if (!message || typeof message !== 'string') return 'Arabic';
    const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${message.replace(/"/g, '\\"')}"`;
    const resultPromise = titleModel.generateContent(prompt);
    const result = await withTimeout(resultPromise, REQUEST_TIMEOUT_MS, 'language detection');
    const raw = await extractTextFromResult(result);
    const lang = sanitizeLanguage(raw);
    return lang || 'Arabic';
  } catch (error) {
    console.error('Language detection failed:', error);
    return 'Arabic';
  }
}

// ----------------- Endpoints -----------------

app.post('/chat', async (req, res) => {
  try {
    const { userId, message } = req.body;
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const lessonId = req.body.lessonId || null;

    if (!userId || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid request body. Required: userId (string), message (string).' });
    }

    // Fetch data concurrently
    const lessonPromise = lessonId ? fetchLessonContent(lessonId) : Promise.resolve(null);

    const [memorySummary, dynamicData, detectedLanguageRaw, lessonContentRaw] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message),
      lessonPromise,
    ]);

    const detectedLanguage = sanitizeLanguage(detectedLanguageRaw);

    // Prepare safe lesson content
    const lessonContent = lessonContentRaw ? escapeForPrompt(safeSnippet(String(lessonContentRaw), 6000)) : null;

    // Build conversation history (safe)
    const formattedHistory = (history || [])
      .slice(-5)
      .map(item => {
        const role = item.role === 'model' ? 'EduAI' : 'User';
        const text = String(item.text || '').replace(/\n/g, ' ');
        return `${role}: ${text}`;
      })
      .join('\n');

    // Build final prompt
    const lessonContextBlock = lessonContent
      ? `
<lesson_context>
**CRITICAL_FOCUS:** The user is currently viewing a lesson. Your response MUST be based ONLY on the following text block. Do NOT use general knowledge about the topic. If the text does not contain the answer, state that gently.
<lesson_text>
${lessonContent}
</lesson_text>
</lesson_context>
`
      : '';

    // Avoid unbounded insertion: escape the latest message
    const safeMessage = escapeForPrompt(safeSnippet(message, 2000));

    const finalPrompt = `
<role>
You are 'EduAI' (you can call yourself 'owl'), a smart, positive, and deeply empathetic study companion. Your primary goal is to be a helpful and motivating friend to the user. Use sophisticated and appropriate words. Avoid starting every message with a greeting like "hi" or "أهلاً".
</role>

${lessonContextBlock} <!-- LESSON CONTEXT IS INSERTED HERE -->

<user_profile>
  <dynamic_data>
    - Current Points: ${Number(dynamicData.points || 0)}
    - Daily Streak: ${Number(dynamicData.streak || 0)}
  </dynamic_data>
  <static_memory>
    - Summary: ${escapeForPrompt(safeSnippet(memorySummary || 'No available memory.', 1000))}
  </static_memory>
</user_profile>

<conversation_context>
  <history>
${formattedHistory || 'This is the beginning of the conversation.'}
  </history>
  <latest_message>
    ${safeMessage}
  </latest_message>
</conversation_context>

<task>
  Your task is to generate a response to the <latest_message>.
  
  **Core Directives:**
  1. If a <lesson_context> exists, your response is limited to that context.
  2. Maintain Context: Your response MUST be a logical and direct continuation of the <conversation_context>.
  3. Be Subtle: Use information from <user_profile> only if it's highly relevant.

  **CRITICAL_RULE:**
  You must write your entire response in the following language: **${detectedLanguage}**. No other languages are permitted.
</task>
`.trim();

    // Call the chat model with a timeout wrapper
    const modelCallPromise = chatModel.generateContent(finalPrompt);
    const modelResult = await withTimeout(modelCallPromise, REQUEST_TIMEOUT_MS, 'chat model');
    const botReplyRaw = await extractTextFromResult(modelResult);
    const botReply = botReplyRaw || "Sorry — I couldn't generate a response right now.";

    // Return reply
    return res.json({ reply: botReply });
  } catch (error) {
    console.error('Critical Error in /chat endpoint:', error);
    // If the error is a timeout-like error, respond with 504
    if (error && error.message && error.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Model request timed out.' });
    }
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Title Generation Endpoint ---
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
    const title = (rawTitle || '').split('\n')[0].trim(); // use first line, trimmed

    if (!title) {
      return res.status(502).json({ error: 'Failed to generate a valid title.' });
    }

    return res.json({ title });
  } catch (error) {
    console.error('Error in /generate-title endpoint:', error);
    if (error && error.message && error.message.toLowerCase().includes('timed out')) {
      return res.status(504).json({ error: 'Title generation timed out.' });
    }
    return res.status(500).json({ error: 'Failed to generate title.' });
  }
});

// --- Health check ---
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

// --- Server Activation ---
app.listen(PORT, () => {
  console.log(`EduAI Brain V9 is running on port ${PORT}`);
  console.log(`Using Chat Model: ${CHAT_MODEL_NAME}`);
  console.log(`Using Title Model: ${TITLE_MODEL_NAME}`);
});
