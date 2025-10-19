const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MODEL_NAME = "gemini-pro";

// --- Initialization ---
const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error("Firebase Admin initialization failed:", error);
  process.exit(1);
}
const db = admin.firestore();

// Initialize Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

// --- Helper Functions (for cleaner code) ---

/**
 * Fetches the user's long-term memory profile from Firestore.
 * @param {string} userId The user's ID.
 * @returns {Promise<string>} The user's profile summary.
 */
async function fetchMemoryProfile(userId) {
  try {
    const memoryDocRef = db.collection('aiMemoryProfiles').doc(userId);
    const memoryDoc = await memoryDocRef.get();
    if (memoryDoc.exists && memoryDoc.data().profileSummary) {
      return memoryDoc.data().profileSummary;
    }
  } catch (error) {
    console.error(`Error fetching memory for user ${userId}:`, error);
  }
  return "لا توجد ذاكرة حالية عن هذا المستخدم.";
}

/**
 * Fetches the user's dynamic progress data (points, streak) from Firestore.
 * @param {string} userId The user's ID.
 * @returns {Promise<object>} An object with points and streak.
 */
async function fetchUserProgress(userId) {
  try {
    const progressDocRef = db.collection('userProgress').doc(userId);
    const progressDoc = await progressDocRef.get();
    if (progressDoc.exists) {
      const data = progressDoc.data();
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

/**
 * Detects the language of the user's message.
 * @param {string} message The user's message.
 * @returns {Promise<string>} The detected language (e.g., 'Arabic', 'English').
 */
async function detectLanguage(message) {
    try {
        const prompt = `What language is this text written in? Respond with only the language name (e.g., "Arabic", "English", "French"). Text: "${message}"`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.error("Language detection failed:", error);
        return 'Arabic'; // Default to Arabic on failure
    }
}

// --- Main Chat Endpoint ---
app.post('/chat', async (req, res) => {
  try {
    // 1. Robust Validation
    const { userId, message, history } = req.body;
    if (!userId || !message || typeof message !== 'string' || !Array.isArray(history)) {
      return res.status(400).json({ error: 'Invalid request body. Required: userId (string), message (string), history (array).' });
    }

    // 2. Fetch all data concurrently for performance
    const [memorySummary, dynamicData, detectedLanguage] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message)
    ]);

    // 3. Conversation History Formatting (Confirmation: Yes, it's here!)
    const formattedHistory = history
      .slice(-5) // Ensure we only take the last 5 messages
      .map(item => `${item.role === 'model' ? 'EduAI' : 'User'}: ${item.text}`)
      .join('\n');

    // 4. Advanced Prompt Construction
    const finalPrompt = `### SYSTEM PROMPT ###
# ROLE & CONTEXT
أنت 'EduAI'، رفيق دراسي ذكي، إيجابي، وداعم. هدفك هو مساعدة المستخدم على الشعور بالثقة والتحفيز.

# LANGUAGE_RULE
**Rule: You must respond exclusively in ${detectedLanguage}.** Do not mix languages.

# DATA_SHEET (Live User Data)
- Current Points: ${dynamicData.points}
- Daily Streak: ${dynamicData.streak}

# MEMORY (Long-term Knowledge)
- User Profile Summary: ${memorySummary}

# CONVERSATION_HISTORY
${formattedHistory}

# RULES_OF_ENGAGEMENT
1.  **Don't Dump Info:** Pick only ONE relevant piece of information from DATA_SHEET or MEMORY to personalize the conversation naturally. If nothing is relevant, don't force it.
2.  **Match Intent:** If it's a greeting, be warm and encouraging. If it's a question, answer it directly. If it's frustration, show empathy first.
3.  **Be Concise:** Keep replies short and natural.

# TASK
Based on all the above, reply to the user's latest message in a helpful, personal, and natural way, following the LANGUAGE_RULE strictly.

User's New Message: "${message}"`;

    // 5. Generate Content
    const result = await model.generateContent(finalPrompt);
    const response = await result.response;
    const botReply = response.text();

    // 6. Send Response
    res.json({ reply: botReply });

  } catch (error) {
    console.error("Critical Error in /chat endpoint:", error);
    res.status(500).json({ error: 'An internal server error occurred. Please try again later.' });
  }
});

// --- Server Activation ---
app.listen(PORT, () => {
  console.log(`EduAI Brain is running on port ${PORT}`);
});
