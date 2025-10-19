const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// --- تهيئة الخادم والتطبيقات ---
const app = express();
app.use(cors());
app.use(express.json());

// تهيئة Firebase Admin SDK (لقراءة البيانات من Firestore بأمان)
// ملاحظة: يتم تخزين مفتاح الخدمة كمتغير بيئة على Render.com
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// تهيئة Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- نقطة النهاية الرئيسية للمحادثة ---
app.post('/chat', async (req, res) => {
  try {
    const { userId, message, history } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: 'User ID and message are required.' });
    }

    // 1. [الذكاء] جلب ملف الذاكرة من Firestore
    let memorySummary = "لا توجد ذاكرة حالية عن هذا المستخدم.";
    const memoryDocRef = db.collection('aiMemoryProfiles').doc(userId);
    const memoryDoc = await memoryDocRef.get();
    if (memoryDoc.exists) {
      memorySummary = memoryDoc.data().profileSummary || memorySummary;
    }

    // 2. [السياق] تنسيق سجل المحادثة
    const formattedHistory = history.map(item => `${item.role === 'model' ? 'EduAI' : 'User'}: ${item.text}`).join('\n');

    // 3. [الدستور] بناء الموجه النهائي القوي
    const finalPrompt = `### SYSTEM PROMPT ###
# ROLE & CONTEXT
أنت 'EduAI'، رفيق دراسي ذكي، إيجابي، وداعم... (بقية الدستور)
# MEMORY
- ملخص ذاكرة المستخدم: ${memorySummary}
- سجل المحادثة الأخيرة:
${formattedHistory}
# RULES OF ENGAGEMENT ... (بقية القواعد)
# TASK
...
رسالة المستخدم الجديدة: ${message}`;

    // 4. [التنفيذ] إرسال الموجه إلى Gemini
    const result = await model.generateContent(finalPrompt);
    const response = await result.response;
    const botReply = response.text();

    // 5. [الرد] إرجاع الإجابة الذكية إلى التطبيق
    res.json({ reply: botReply });

  } catch (error) {
    console.error("Error in /chat endpoint:", error);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// --- تشغيل الخادم ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
