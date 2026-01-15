'use strict';

const axios = require('axios');
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const generateWithFailover = require('../services/ai/failover');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const PROMPTS = require('../config/ai-prompts'); 
const { getProfile } = require('../services/data/helpers');

// ============================================================
// 🛠️ Helper: Download File & Convert to Base64
// ============================================================
async function fetchFileAsBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
        console.error(`Failed to fetch file from history: ${url}`, error.message);
        return null; // في حال فشل التحميل، نتجاهل الملف لتجنب توقف الشات
    }
}

// ============================================================
// 1. استرجاع التاريخ (Strict Lesson Mode)
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    // 🛑 طباعة للتأكد مما يصل من الفرونت اند
    console.log(`🔍 Fetching History for User: ${userId}, Lesson: ${lessonId}`);

    // ✅ المنطق الصارم: نعتمد الدرس القادم فقط
    // إذا كان lessonId غير موجود أو يساوي نص "undefined" نعتبره خطأ في الفرونت لكن لن نحوله لـ general
    // إلا إذا كان "general" صراحةً.
    let contextId = lessonId;

    if (!contextId || contextId === 'undefined' || contextId === 'null') {
        // بما أن التطبيق لا يعمل إلا داخل دروس، فهذا يعني أن هناك خطأ في الإرسال
        // لكن كحل أخير سنبقيه general لتجنب كراش، ولكن الأصل أن يصل ID
        contextId = 'general';
    }

    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', contextId) // 👈 البحث عن هذا الدرس حصراً
      .maybeSingle();

    if (!session) {
        console.log(`ℹ️ No session found for context: ${contextId}`);
        return res.json({ messages: [], nextCursor: null });
    }

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data: messages } = await query;
    const nextCursor = messages && messages.length === limit ? messages[messages.length - 1].created_at : null;

    res.json({ messages: messages || [], nextCursor });
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 2. معالجة الشات (Strict Lesson Mode)
// ============================================================
async function processChat(req, res) {
  // نستخرج البيانات بدقة
  let { userId, message, files = [], currentContext, webSearch } = req.body;
  
  // 1. استخراج معرف الدرس (الأولوية لما بداخل currentContext)
  // الفرونت يرسل: currentContext: { lessonId: "...", ... }
  const rawLessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;

  console.log(`🚀 Processing Chat | Lesson ID Received: [${rawLessonId}]`);

  // 2. تحديد المعرف النهائي بصرامة
  let contextId = rawLessonId;

  // تنظيف القيم النصية الخاطئة التي قد تأتي من الـ JSON
  if (contextId === 'undefined' || contextId === 'null' || !contextId) {
      console.warn("⚠️ Warning: No valid Lesson ID provided! Defaulting to 'general' (Check Frontend).");
      contextId = 'general'; 
  }

  try {
    // 3. البحث عن الجلسة أو إنشاؤها
    let sessionId;
    
    // محاولة العثور على جلسة لهذا الدرس
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', contextId) // 👈 يجب أن يطابق معرف الدرس
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        // إنشاء جلسة جديدة لهذا الدرس
        console.log(`✨ Creating NEW session for context: ${contextId}`);
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: contextId, // 👈 الحفظ بمعرف الدرس
            context_type: contextId === 'general' ? 'general' : 'lesson',
            summary: lessonTitle || `Lesson ${contextId}`
        }).select().single();
        sessionId = newSession.id;
    }


    // 2. تجهيز الملفات الحالية (Base64 جاهز من الفرونت إند)
   const geminiAttachments = []; 
    const dbAttachments = [];     

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                
                // إضافة للمودل (Gemini)
                geminiAttachments.push({
                    inlineData: { data: base64Data, mimeType: file.mime }
                });

                // إعدادات الرفع لـ Cloudinary
                let uploadOptions = { 
                    resource_type: "auto", 
                    folder: `chat_uploads/${userId}` 
                };
                
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf'; 
                
                // 🔴 بالإضافة: الصوت يفضل رفعه كـ video في Cloudinary ليعمل المشغل
                if (file.mime.startsWith('audio')) {
                    uploadOptions.resource_type = "video"; 
                }

                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, uploadOptions);
                
                dbAttachments.push({
                    url: uploadRes.secure_url,
                    public_id: uploadRes.public_id,
                    mime: file.mime,
                    type: file.mime.startsWith('image') ? 'image' : (file.mime.startsWith('audio') ? 'audio' : 'file')
                });
            } catch (e) { console.error('File Processing Error:', e.message); }
        }
    }

    // 3. جلب السياق
     let contentSnippet = "";
    if (contextId !== 'general') {
        // جلب محتوى الدرس من قاعدة البيانات ليكون الـ AI عارفاً عما يتحدث
        const { data: contentData } = await supabase
            .from('lessons_content')
            .select('content')
            .eq('lesson_id', contextId)
            .maybeSingle();
        if (contentData?.content) contentSnippet = contentData.content.substring(0, 15000);
    }
    const userProfile = await getProfile(userId);

    // ==================================================================================
    // 4. بناء الذاكرة "الحية" (استرجاع الصور القديمة وتحويلها لـ Base64)
    // ==================================================================================
  const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, attachments')
        .eq('session_id', sessionId) // ✅ جلب رسائل هذا الدرس فقط
        .order('created_at', { ascending: false })
        .limit(10); 
    // نعكس المصفوفة لتكون بالترتيب الزمني الصحيح
    const orderedHistory = (historyData || []).reverse();

    // نستخدم Promise.all لمعالجة الرسائل بشكل متوازي لتسريع التحميل
    const history = await Promise.all(orderedHistory.map(async (msg) => {
        const parts = [];
        
        // أ. النص
        if (msg.content) parts.push({ text: msg.content });

        // ب. المرفقات (هنا السحر ✨: نحمل الملف من الرابط ونحوله لـ Base64)
        if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            // معالجة كل المرفقات في الرسالة الواحدة بشكل متوازي
            const attachmentParts = await Promise.all(msg.attachments.map(async (att) => {
                // ملاحظة: نتأكد أن الملف مدعوم من Gemini (صور/PDF)
                if (att.url) {
                    const base64 = await fetchFileAsBase64(att.url);
                    if (base64) {
                        return {
                            inlineData: {
                                data: base64,
                                mimeType: att.mime || 'image/jpeg' 
                            }
                        };
                    }
                }
                return null;
            }));

            // تصفية الملفات التي فشل تحميلها
            attachmentParts.filter(p => p !== null).forEach(p => parts.push(p));
        }

        // إذا كانت الرسالة فارغة تماماً (نادر الحدوث)، نضع مسافة
        if (parts.length === 0) parts.push({ text: " " });

        return {
            role: msg.role === 'user' ? 'user' : 'model',
            parts: parts
        };
    }));
    // ==================================================================================

    // 5. حفظ الرسالة الجديدة
 await supabase.from('chat_messages').insert({
        session_id: sessionId, // ✅ حفظ في جلسة الدرس
        user_id: userId, 
        role: 'user', 
        content: message,
        attachments: dbAttachments, 
        metadata: { context: contextId }
    });

    // 6. استدعاء الذكاء الاصطناعي
    const personaPrompt = PROMPTS.chat.interactiveChat(
        message, userProfile, locationContext, null, contentSnippet
    );

    const finalSystemPrompt = `
    ${personaPrompt}

    🛑 **VISION INSTRUCTIONS:**
    1. You have access to the ACTUAL files from the last 10 messages (Images/PDFs).
    2. Analyze them directly if the user refers to them (e.g., "what about the previous image?").
    3. Answer in **Algerian Derja**.
    
    **OUTPUT JSON:** { "reply": "...", "widgets": [], "lesson_signal": ... }
    `;

    console.log(`🚀 Sending to AI (History Size: ${history.length}, Current Attachments: ${geminiAttachments.length})...`);

    // ملاحظة: geminiAttachments هي ملفات الرسالة الحالية، والملفات القديمة موجودة الآن داخل history
    const aiResult = await generateWithFailover('chat', message || "Analyze attached file", {
        systemInstruction: { parts: [{ text: finalSystemPrompt }] },
        history: history,               // ✅ يحتوي الآن على الصور الفعلية للرسائل السابقة
        attachments: geminiAttachments, // ✅ الصور الحالية
        enableSearch: !!webSearch,
        label: 'ChatBrain_FullVision'
    });

    // 7. تنظيف الرد
    let parsedResponse;
    try {
        const cleanText = (typeof aiResult === 'object' ? aiResult.text : aiResult)
                          .replace(/```json/g, '').replace(/```/g, '').trim();
        parsedResponse = JSON.parse(cleanText);
    } catch (e) {
        parsedResponse = { reply: typeof aiResult === 'object' ? aiResult.text : aiResult, widgets: [] };
    }

    // 8. معالجة الإشارات
    let finalWidgets = parsedResponse.widgets || [];
    if (parsedResponse.lesson_signal?.type === 'complete' && lessonId) {
        const gateResult = await markLessonComplete(userId, lessonId, parsedResponse.lesson_signal.score || 100);
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `صحيت! +${gateResult.reward.coins_added} كوين`, coins: gateResult.reward.coins_added } 
            });
        }
    }

    // 9. حفظ رد البوت
   await supabase.from('chat_messages').insert({
        session_id: sessionId, // ✅ حفظ في جلسة الدرس
        user_id: userId, 
        role: 'assistant', 
        content: parsedResponse.reply,
        metadata: { widgets: parsedResponse.widgets || [] }
    });

    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: parsedResponse.widgets || [],
        sessionId: sessionId
    });

  } catch (err) {
    console.error('🔥 ChatBrain Error:', err);
    res.status(500).json({ reply: "صرا مشكل تقني، عاود المحاولة." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized (FULL VISION MODE).');
}

module.exports = { processChat, getChatHistory, initChatBrainController };
