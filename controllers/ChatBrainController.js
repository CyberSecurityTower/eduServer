'use strict';

const axios = require('axios');
// لا حاجة لمكتبات PDF/Word المحلية بعد الآن! 🎉

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const generateWithFailover = require('../services/ai/failover');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const PROMPTS = require('../config/ai-prompts'); 
const { getProfile } = require('../services/data/helpers'); // لجلب بيانات الطالب

// ============================================================
// 📜 Get Chat History
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    const { data: session } = await supabase
      .from('chat_sessions').select('id')
      .eq('user_id', userId).eq('context_id', lessonId || 'general').maybeSingle();

    if (!session) return res.json({ messages: [], nextCursor: null });

    let query = supabase.from('chat_messages').select('*').eq('session_id', session.id)
      .order('created_at', { ascending: false }).limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data: messages } = await query;
    const nextCursor = messages && messages.length === limit ? messages[messages.length - 1].created_at : null;
    
    // نرسل الرسائل كما هي، والفرونت إند سيعالج عرض المرفقات بناءً على حقل attachments
    res.json({ messages: messages || [], nextCursor });

  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 🧠 Main Process Chat (AI Vision Mode 👁️)
// ============================================================
async function processChat(req, res) {
  let { userId, message, files = [], currentContext, webSearch } = req.body;
  
  const lessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;
  const currentContextId = (lessonId && lessonId !== 'undefined') ? lessonId : 'general';

  try {
    // 1. إدارة الجلسة (Session)
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions').select('id').eq('user_id', userId).eq('context_id', currentContextId).maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId).then();
    } else {
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId, context_id: currentContextId, context_type: 'general', summary: lessonTitle || 'Chat'
        }).select().single();
        sessionId = newSession.id;
    }

    // 2. تجهيز الملفات (مسارين: مسار للـ AI ومسار للداتابايز)
    const geminiAttachments = []; // يذهب للـ AI فوراً (Base64)
    const dbAttachments = [];     // يذهب للتخزين (URL)

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                // أ. تجهيز للـ AI (بدون تحميل، نستخدم البيانات القادمة من الفرونت مباشرة)
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                geminiAttachments.push({
                    inlineData: { data: base64Data, mimeType: file.mime }
                });

                // ب. الرفع لـ Cloudinary (للحفظ والعرض لاحقاً)
                let uploadOptions = { resource_type: "auto", folder: `chat_uploads/${userId}` };
                // تحسينات بسيطة للصيغ
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf'; 

                // نرفع في الخلفية لعدم تعطيل الـ AI (أو ننتظر إذا أردنا الرابط فوراً)
                // سننتظر هنا لضمان وجود الرابط في قاعدة البيانات
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

    // 3. جلب السياق الكامل (البروفايل + الدرس)
    let contentSnippet = "";
    let locationContext = `Context: ${lessonTitle || 'General Discussion'}`;
    
    // جلب محتوى الدرس إذا وجد
    if (lessonId && lessonId !== 'general') {
        const { data: contentData } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonId).maybeSingle();
        if (contentData?.content) contentSnippet = contentData.content.substring(0, 15000); // 15K chars context
    }

    // جلب بيانات الطالب
    const userProfile = await getProfile(userId);

    // 4. بناء الذاكرة (آخر 6 رسائل)
    const { data: historyData } = await supabase
        .from('chat_messages').select('role, content')
        .eq('session_id', sessionId).order('created_at', { ascending: false }).limit(6);

    const history = (historyData || []).reverse().map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content || " " }]
    }));

    // 5. حفظ رسالة المستخدم
    await supabase.from('chat_messages').insert({
        session_id: sessionId, user_id: userId, role: 'user', content: message,
        attachments: dbAttachments, // نحفظ الروابط
        metadata: { context: lessonId }
    });

    // 6. 🧠 استدعاء الذكاء الاصطناعي (مع الملفات والسياق الكامل)
    
    // نستخدم البرومبت الأساسي المبني سابقاً
    const personaPrompt = PROMPTS.chat.interactiveChat(
        message, 
        userProfile, 
        locationContext, // System Context
        null, // Atomic (Optional)
        contentSnippet // Lesson Content
    );

    const finalSystemPrompt = `
    ${personaPrompt}

    🛑 **VISION INSTRUCTIONS (If files are attached):**
    1. The user has attached ${geminiAttachments.length} file(s).
    2. Read them carefully (Images, PDFs, Audio). 
    3. If it's a question image, solve it. If it's a PDF summary, summarize it.
    4. Answer in **Algerian Derja**.
    
    **OUTPUT JSON:** { "reply": "...", "widgets": [], "lesson_signal": ... }
    `;

    console.log(`🚀 Sending to AI (${geminiAttachments.length} files attached)...`);

    const aiResult = await generateWithFailover('chat', message || "Analyze attached file", {
        systemInstruction: { parts: [{ text: finalSystemPrompt }] },
        history: history,
        attachments: geminiAttachments, // 👈 إرسال الملفات للموديل مباشرة
        enableSearch: !!webSearch,
        label: 'ChatBrain_Vision'
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

    // 8. معالجة الإشارات (إكمال الدرس)
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
        session_id: sessionId, user_id: userId, role: 'assistant', content: parsedResponse.reply,
        metadata: { widgets: finalWidgets, lesson_signal: parsedResponse.lesson_signal }
    });

    // 10. إرسال النتيجة
    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: finalWidgets,
        sessionId: sessionId
    });

  } catch (err) {
    console.error('🔥 ChatBrain Error:', err);
    res.status(500).json({ reply: "صرا مشكل تقني، عاود المحاولة." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized (Vision Mode).');
}

module.exports = { processChat, getChatHistory, initChatBrainController };
