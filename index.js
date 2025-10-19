const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
// --- Use the specific models as requested ---
const CHAT_MODEL_NAME = "gemini-2.5-pro";
const TITLE_MODEL_NAME = "gemini-2.5-flash-lite";

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
// --- NEW: Initialize two separate, specialized models ---
const chatModel = genAI.getGenerativeModel({ model: CHAT_MODEL_NAME });
const titleModel = genAI.getGenerativeModel({ model: TITLE_MODEL_NAME });


// --- Helper Functions (No changes) ---

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
    console.error(`Error fetching progress for user ${userId}:`, error);
  }
  return { points: 0, streak: 0 };
}

async function detectLanguage(message) {
    try {
        // Use the fast title model for this simple task as well
        const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${message}"`;
        const result = await titleModel.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
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
You are 'EduAI' (you can call yourself 'owl'), a smart, positive, and deeply empathetic study companion. Your primary goal is to be a helpful and motivating friend. Use sophisticated and appropriate words. Avoid starting every message with a greeting like "hi" or "أهلاً".
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
  **REASONING_STEPS (Think silently before you respond):**
  1.  Analyze Context.
  2.  If the history contains a connection error, IGNORE IT and do not apologize.
  3.  Connect the dots wisely.
  4.  Formulate a Plan.
  **FINAL_OUTPUT_RULES:**
  1.  Maintain Context.
  2.  CRITICAL_LANGUAGE_RULE: You must write your entire response in **${detectedLanguage}**.
  3.  Output Format: Provide ONLY the final response text.
</task>
`;

    // --- USE THE POWERFUL CHAT MODEL ---
    const result = await chatModel.generateContent(finalPrompt);
    const response = await result.response;
    const botReply = response.text();

    res.json({ reply: botReply });

  } catch (error) {
    console.error("Critical Error in /chat endpoint:", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Title Generation Endpoint ---
app.post('/generate-title', async (req, res) => {
    try {
        const { message, language } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        const titlePrompt = `
        Summarize the following user message into a short, concise, and engaging chat title.
        - The title must be a nominal phrase (جملة اسمية).
        - The title must be in ${language || 'Arabic'}.
        - Respond with ONLY the title text.
        User Message: "${message}"
        Title:`;

        // --- USE THE FAST TITLE MODEL ---
        const result = await titleModel.generateContent(titlePrompt);
        const response = await result.response;
        const title = response.text().trim();

        res.json({ title: title });

    } catch (error) {
        console.error("Error in /generate-title endpoint:", error);
        res.status(500).json({ error: 'Failed to generate title.' });
    }
});


// --- Server Activation ---
app.listen(PORT, () => {
  console.log(`EduAI Brain V7 is running on port ${PORT}`);
  console.log(`Using Chat Model: ${CHAT_MODEL_NAME}`);
  console.log(`Using Title Model: ${TITLE_MODEL_NAME}`);
});
