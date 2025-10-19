const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
// --- FIX: Using a valid and powerful model name ---
const MODEL_NAME = "gemini-2.5-pro";

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
        const prompt = `What is the primary language of the following text? Respond with only the language name in English (e.g., "Arabic", "English", "French"). Text: "${message}"`;
        const result = await model.generateContent(prompt);
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

    // --- V6: THE SELF-CORRECTING PROMPT ---
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
  1.  **Analyze Context:** Read the <conversation_context>.
  2.  **Error Check:** If the <history> contains a connection error message from you, IGNORE IT COMPLETELY. Focus only on the user's valid messages. Do not apologize for past technical errors.
  3.  **Connect the Dots & Be Wise:** Connect the <latest_message> to the <history> and <user_profile>. Use general traits for encouragement and specific facts only when highly relevant.
  4.  **Formulate a Plan:** Decide on the most appropriate tone and content.

  **FINAL_OUTPUT_RULES:**
  1.  **Maintain Context:** Your response MUST be a logical continuation of the conversation.
  2.  **CRITICAL_LANGUAGE_RULE:** You must write your entire response in **${detectedLanguage}**.
  3.  **Output Format:** Provide ONLY the final response text.
</task>
`;

    const result = await model.generateContent(finalPrompt);
    const response = await result.response;
    const botReply = response.text();

    res.json({ reply: botReply });

  } catch (error) {
    console.error("Critical Error in /chat endpoint:", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- NEW: Title Generation Endpoint ---
app.post('/generate-title', async (req, res) => {
    try {
        const { message, language } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        const titlePrompt = `
        Your task is to summarize the following user message into a short, concise, and engaging chat title.
        - The title must be a nominal phrase (جملة اسمية).
        - The title must be in ${language || 'Arabic'}.
        - Respond with ONLY the title text and nothing else.

        User Message: "${message}"
        Title:`;

        const result = await model.generateContent(titlePrompt);
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
  console.log(`EduAI Brain V6 is running on port ${PORT}`);
});
