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

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

// --- Helper Functions ---

async function fetchMemoryProfile(userId) {
  try {
    const memoryDocRef = db.collection('aiMemoryProfiles').doc(userId);
    const memoryDoc = await memoryDocRef.get();
    if (memoryDoc.exists && memoryDoc.data().profileSummary) {
      return memoryDoc.data().profileSummary;
    }
  } catch (error) {
    // <-- FIX: Comma added here
    console.error(`Error fetching memory for user ${userId}:`, error);
  }
  return "No available memory.";
}

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
    // <-- FIX: Comma added here
    console.error(`Error fetching progress for user ${userId}:`, error);
  }
  return { points: 0, streak: 0 };
}

async function detectLanguage(message) {
    try {
        const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${message}"`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        // <-- FIX: Comma added here
        console.error("Language detection failed:", error);
        return 'Arabic';
    }
}

// --- Main Chat Endpoint ---
app.post('/chat', async (req, res) => {
  try {
    const { userId, message, history } = req.body;
    if (!userId || !message || typeof message !== 'string' || !Array.isArray(history)) {
      return res.status(400).json({ error: 'Invalid request body.' });
    }

    const [memorySummary, dynamicData, detectedLanguage] = await Promise.all([
      fetchMemoryProfile(userId),
      fetchUserProgress(userId),
      detectLanguage(message)
    ]);

    const formattedHistory = history
      .slice(-5)
      .map(item => `${item.role === 'model' ? 'EduAI' : 'User'}: ${item.text}`)
      .join('\n');

    const finalPrompt = `
<role>
You are 'EduAI', a smart, positive, and supportive study companion. Your primary goal is to be a helpful and motivating friend to the user.
</role>

<user_profile>
  <dynamic_data>
    - Current Points: ${dynamicData.points}
    - Daily Streak: ${dynamicData.streak}
  </dynamic_data>
  <static_memory>
    - Summary: ${memorySummary}
  </static_memory>
</user_profile>

<conversation_context>
  <history>
    ${formattedHistory || "This is the beginning of the conversation."}
  </history>
  <latest_message>
    ${message}
  </latest_message>
</conversation_context>

<task>
  Your task is to generate a response to the <latest_message>.

  **Core Directives:**
  1.  **Maintain Context:** Your response MUST be a logical and direct continuation of the <conversation_context>. Acknowledge the <history> if it's relevant to the <latest_message>.
  2.  **Be Subtle:** Use information from <user_profile> only if it's highly relevant. Do not just list facts.
  3.  **Be Natural:** Keep your tone friendly and your responses concise.

  **CRITICAL_RULE:**
  You must write your entire response in the following language: **${detectedLanguage}**. No other languages are permitted.
</task>
`;

    const result = await model.generateContent(finalPrompt);
    const response = await result.response;
    const botReply = response.text();

    res.json({ reply: botReply });

  } catch (error) {
    // <-- FIX: Comma added here
    console.error("Critical Error in /chat endpoint:", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Server Activation ---
app.listen(PORT, () => {
  console.log(`EduAI Brain V3 is running on port ${PORT}`);
});
