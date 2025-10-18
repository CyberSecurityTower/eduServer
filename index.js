const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require('firebase-admin'); // <-- استيراد مكتبة Firebase Admin

// --- إعداد Firebase Admin ---
// التحقق من وجود مفتاح الخدمة
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Firebase Service Account key not found in environment variables.");
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// تهيئة التطبيق
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore(); // الحصول على مرجع لقاعدة البيانات

// --- إعداد Google AI ---
if (!process.env.GOOGLE_API_KEY) {
  throw new Error("API Key not found. Please add GOOGLE_API_KEY to environment variables.");
}
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- إعداد الخادم ---
const app = express();
app.use(cors());
app.use(express.json());

// --- نقطة النهاية المحدثة والذكية ---
app.post('/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    let userContext = "The user is a new student.";
    // إذا أرسل التطبيق userId، قم بجلب بياناته
    if (userId) {
      const userProgressRef = db.collection('userProgress').doc(userId);
      const userProgressDoc = await userProgressRef.get();

      if (userProgressDoc.exists) {
        const data = userProgressDoc.data();
        const userName = data.stats?.displayName || "student";
        const userPoints = data.stats?.points || 0;
        const userStreak = data.streakCount || 0;
        // بناء السياق الشخصي
        userContext = `The user's name is ${userName}. Their current stats are: ${userPoints} points and a ${userStreak}-day streak.`;
      }
    }

    // بناء المقدمة الكاملة لـ Gemini
    const promptPreamble = `
      You are EduAI, a smart and encouraging study assistant. 
      Your personality is helpful, positive, and a little playful.
      You are talking to a university student.
      This is the context about the user: ${userContext}
      Address the user by their name if you know it.
      Keep your answers concise and helpful.
      
      The user's message is: "${message}"
    `;

    // إرسال المقدمة الكاملة إلى النموذج
    const result = await model.generateContent(promptPreamble);
    const response = await result.response;
    const botReply = response.text();

    res.json({ reply: botReply });

  } catch (error) {
    console.error("Error processing chat:", error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// تشغيل الخادم
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
