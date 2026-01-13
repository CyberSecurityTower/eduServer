// controllers/chatController.js
'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const supabase = require('../services/data/supabase');
const mediaManager = require('../services/media/mediaManager');
const scraper = require('../utils/scraper');
const logger = require('../utils/logger');
const { nowISO } = require('../services/data/dbUtils');
const { extractTextFromResult, safeSnippet } = require('../utils');
const { saveChatSession, getLastActiveSessionContext } = require('../services/data/helpers');

// AI Generator Reference (will be injected via init)
let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Lite Mode: Context, Files & Search Only 🚀).');
}

// ==========================================
// 3. Main Logic: Chat Interactive
// ==========================================
async function chatInteractive(req, res) {
  // ✅ 1. Receive data
  let { userId, message, history, sessionId, currentContext, files, file, webSearch } = req.body;

  if (!sessionId) sessionId = crypto.randomUUID();
  if (!Array.isArray(history)) history = [];
  if (!currentContext) currentContext = {};

  try {
    // =========================================================
    // 2. History & User Setup
    // =========================================================
    // استرجاع التاريخ إذا كان فارغاً للحفاظ على استمرارية المحادثة
    if (history.length === 0) {
      const bridgeContext = await getLastActiveSessionContext(userId, sessionId);
      if (bridgeContext) {
        history = bridgeContext.messages;
      }
    }

    // جلب بيانات المستخدم الأساسية (للاسم فقط)
    const { data: userData } = await supabase
      .from('users')
      .select('first_name')
      .eq('id', userId)
      .single();
    
    const userName = userData?.first_name || 'Student';

    // =========================================================
    // 3. Files & Links Processing
    // =========================================================
    const inputFiles = files || (req.body.file ? [req.body.file] : []);
    
    // أ. معالجة المرفقات (صور/ملفات)
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, inputFiles);
    
    // ب. معالجة الروابط داخل الرسالة (إذا لم توجد مرفقات)
    if ((!attachments || attachments.length === 0) && message) {
        message = await scraper.enrichMessageWithContext(message);
    }

    // دمج ملاحظات الملفات مع الرسالة
    const finalMessage = message + (fileNote || "");

    // =========================================================
    // 4. Lesson Context Injection (The Core Logic)
    // =========================================================
    let systemInstruction = `You are EduAI, a helpful and smart academic tutor. 
    Your student's name is ${userName}.
    Answer concisely and accurately. Use Markdown for formatting.`;

    // إذا كان الطالب داخل درس معين، نجلب المحتوى ونحقنه في التوجيهات
    if (currentContext.lessonId) {
        try {
            // 1. جلب بيانات الدرس (العنوان)
            const { data: lessonMeta } = await supabase
                .from('lessons')
                .select('title, subject_id')
                .eq('id', currentContext.lessonId)
                .single();

            // 2. جلب محتوى الدرس النصي
            const { data: lessonContent } = await supabase
                .from('lessons_content')
                .select('content')
                .eq('id', currentContext.lessonId)
                .single();

            if (lessonMeta && lessonContent) {
                const snippet = safeSnippet(lessonContent.content, 6000); // نأخذ جزءاً كبيراً من الدرس
                
                systemInstruction += `
                
                🔴 **CURRENT LESSON CONTEXT:**
                The student is currently studying the lesson: "${lessonMeta.title}".
                
                **SOURCE MATERIAL (TRUTH):**
                """
                ${snippet}
                """
                
                **INSTRUCTIONS:**
                1. Answer the user's question primarily using the "SOURCE MATERIAL" above.
                2. Explain concepts as defined in the text.
                3. If the user asks something outside this text, you can answer from general knowledge, but mention if it's not in the lesson text.
                `;
                console.log(`✅ Context injected for lesson: ${lessonMeta.title}`);
            }
        } catch (ctxError) {
            console.error('⚠️ Error fetching lesson context:', ctxError.message);
            // نكمل بدون سياق الدرس في حال حدوث خطأ
        }
    }

    // =========================================================
    // 5. AI Generation
    // =========================================================
    console.log('🚀 Sending request to AI service...');

    let modelResp;
    let sources = [];

    const aiOptions = { 
        label: 'ChatLite', 
        timeoutMs: 60000, 
        attachments: attachments, 
        enableSearch: !!webSearch, // تفعيل البحث إذا طلبه المستخدم
        systemInstruction: systemInstruction, // تمرير التوجيهات هنا
        history: history // تمرير الهستوري
    };

    try {
        // نستخدم المولد مباشرة
        const resultObj = await generateWithFailoverRef('chat', finalMessage, aiOptions);
        
        if (typeof resultObj === 'object' && resultObj.text) {
            modelResp = resultObj.text;
            sources = resultObj.sources || [];
        } else {
            modelResp = resultObj;
        }
    } catch (aiError) {
        console.error('❌ AI Generation FAILED:', aiError.message);
        return res.status(500).json({ reply: "عذراً، حدث خطأ أثناء معالجة طلبك." });
    }

    const cleanReply = await extractTextFromResult(modelResp);

    // =========================================================
    // 6. Response & Saving
    // =========================================================
    
    // إرسال الرد للعميل
    res.status(200).json({
        reply: cleanReply,
        sessionId: sessionId,
        sources: sources
    });

    // الحفظ في الخلفية
    setImmediate(async () => {
        try {
            const updatedHistory = [
                ...history,
                { role: 'user', text: message, timestamp: nowISO() },
                { role: 'model', text: cleanReply, timestamp: nowISO() }
            ];
            await saveChatSession(sessionId, userId, message.substring(0, 50), updatedHistory);
        } catch (bgError) {
            logger.error("Background Save Error:", bgError);
        }
    });

  } catch (err) {
    logger.error("ChatInteractive Fatal Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ reply: "حدث خطأ غير متوقع." });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive
};

--- END OF FILE ---
