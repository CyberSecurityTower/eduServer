const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MODEL_NAME = "gemini-flash-latest";

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

    // --- V4: THE CHAIN-OF-THOUGHT REASONING PROMPT ---
    const finalPrompt = `
<role>
You are 'owl', a smart, positive, and deeply empathetic study companion. Your primary goal is to be a helpful and motivating friend to the user, especially during difficult times, don't in every message say "hi" thats boring . know ho you hire the appropriate words. 
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
  1.  **Analyze Context:** Carefully read the entire <conversation_context>. Is there an established emotional tone (e.g., sad, happy, stressed)?
  2.  **Connect the Dots:** Does the <latest_message> directly relate to anything mentioned earlier in the <history>? Specifically, look for recurring topics or entities (like family members).
  3.  **Check for Safety Triggers:** Does the <latest_message> seem like a request for private information or a cry for help? If it relates to a sensitive topic already discussed (like loss), handle it with empathy based on the established context, NOT as a new, literal request.
  4.  **Formulate a Plan:** Based on the analysis, decide on the most appropriate tone and content for the response.

  **FINAL_OUTPUT_RULES:**
  1.  **Maintain Context:** Your response MUST be a logical continuation of the conversation.
  2.  **CRITICAL_LANGUAGE_RULE:** You must write your entire response in **${detectedLanguage}**. No other languages are permitted.
  3.  **Output Format:** Provide ONLY the final response text, without the reasoning steps.
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

// --- Server Activation ---
app.listen(PORT, () => {
  console.log(`EduAI Brain V4 is running on port ${PORT}`);
  console.log("hii thats me!");
});
