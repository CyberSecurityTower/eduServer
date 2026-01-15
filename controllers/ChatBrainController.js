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
        return null; 
    }
}

// ============================================================
// 1. استرجاع التاريخ (Strict Lesson Mode)
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query; 
  console.log(`🔍 SERVER Fetching History for Lesson: ${lessonId}`);

  let contextId = lessonId;

  // تنظيف الـ ID
  if (!contextId || contextId === 'undefined' || contextId === 'null') {
      contextId = 'general';
  }

  const limit = 20;

  try {
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', contextId) 
      .maybeSingle();

    if (!session) {
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
// 2. معالجة الشات (Enhanced Lesson Context)
// ============================================================
async function processChat(req, res) {
  let { userId, message, files = [], currentContext, webSearch, location  } = req.body;
  
  // 1. تحديد المعرف النهائي بصرامة
  // نأخذ الـ ID من السياق أو الجسم، وننظفه
  const rawLessonId = currentContext?.lessonId || req.body.lessonId;
  let contextId = rawLessonId;

  if (contextId === 'undefined' || contextId === 'null' || !contextId) {
      console.warn("⚠️ Warning: No valid Lesson ID provided! Defaulting to 'general'.");
      contextId = 'general'; 
  }

  try {
    // ============================================================
    // 🧠 خطوة ذكية: جلب عنوان الدرس ومحتواه بالتوازي
    // ============================================================
    let lessonTitle = currentContext?.lessonTitle || "General Chat"; // قيمة افتراضية
    let contentSnippet = ""; 

    if (contextId !== 'general') {
        console.log(`📚 Fetching DB Context for Lesson ID: ${contextId}`);
        
        // نستخدم Promise.all لتنفيذ الاستعلامين في نفس الوقت
        const [lessonResult, contentResult] = await Promise.all([
            // 1. جلب العنوان من جدول lessons
            supabase.from('lessons').select('title').eq('id', contextId).maybeSingle(),
            // 2. جلب المحتوى من جدول lessons_content
            supabase.from('lessons_content').select('content').eq('lesson_id', contextId).maybeSingle()
        ]);

        // معالجة نتيجة العنوان
        if (lessonResult.data?.title) {
            lessonTitle = lessonResult.data.title;
            console.log(`✅ Lesson Title Found: "${lessonTitle}"`);
        }

        // معالجة نتيجة المحتوى
        if (contentResult.data?.content) {
            // نأخذ مقتطف كبير (20000 حرف) لضمان تغطية الدرس
            contentSnippet = contentResult.data.content.substring(0, 20000);
            console.log(`✅ Lesson Content Loaded (${contentSnippet.length} chars)`);
        } else {
            console.warn(`⚠️ No content found for lesson: ${contextId}`);
        }
    }
    // ============================================================

    // 2. البحث عن الجلسة أو إنشاؤها
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', contextId)
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        console.log(`✨ Creating NEW session based on DB Title: ${lessonTitle}`);
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: contextId,
            context_type: contextId === 'general' ? 'general' : 'lesson',
            summary: lessonTitle // ✅ تخزين العنوان الحقيقي للجلسة
        }).select().single();
        sessionId = newSession.id;
    }

    // 3. تجهيز الملفات الحالية
    const geminiAttachments = []; 
    const dbAttachments = [];     

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                geminiAttachments.push({ inlineData: { data: base64Data, mimeType: file.mime } });

                let uploadOptions = { resource_type: "auto", folder: `chat_uploads/${userId}` };
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf'; 
                if (file.mime.startsWith('audio')) uploadOptions.resource_type = "video"; 

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

    // 4. بناء الذاكرة الحية (الصور السابقة)
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, attachments')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(10); 
    
    const orderedHistory = (historyData || []).reverse();

    const history = await Promise.all(orderedHistory.map(async (msg) => {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            const attachmentParts = await Promise.all(msg.attachments.map(async (att) => {
                if (att.url) {
                    const base64 = await fetchFileAsBase64(att.url);
                    if (base64) return { inlineData: { data: base64, mimeType: att.mime || 'image/jpeg' } };
                }
                return null;
            }));
            attachmentParts.filter(p => p !== null).forEach(p => parts.push(p));
        }
        if (parts.length === 0) parts.push({ text: " " });
        return { role: msg.role === 'user' ? 'user' : 'model', parts: parts };
    }));

    // 5. حفظ رسالة المستخدم
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId, 
        role: 'user', 
        content: message,
        attachments: dbAttachments, 
        metadata: { context: contextId }
    });

    // 6. استدعاء الذكاء الاصطناعي مع السياق المحسن
    const userProfile = await getProfile(userId);
    const locationContext = location || "Algeria"; 

    // ✅ تمرير العنوان والمحتوى المحملين من قاعدة البيانات للـ Prompt
    const personaPrompt = PROMPTS.chat.interactiveChat(
        message, 
        userProfile, 
        locationContext, 
        lessonTitle,     // ✅ العنوان من جدول lessons
        contentSnippet   // ✅ المحتوى من جدول lessons_content
    );

    const finalSystemPrompt = `
    ${personaPrompt}

    🛑 **INSTRUCTIONS:**
    1. You are specifically tutoring the lesson: "${lessonTitle}".
    2. Answer strictly based on the provided content snippet if applicable.
    3. You have vision access to the last 10 messages (Images/PDFs).
    4. Answer in **Algerian Derja**.
    
    **OUTPUT JSON:** { "reply": "...", "widgets": [], "lesson_signal": ... }
    `;

    console.log(`🚀 Sending to AI (Context: ${contextId}, History: ${history.length})...`);

    const aiResult = await generateWithFailover('chat', message || "Analyze attached file", {
        systemInstruction: { parts: [{ text: finalSystemPrompt }] },
        history: history,
        attachments: geminiAttachments,
        enableSearch: !!webSearch,
        label: 'ChatBrain_FullVision'
    });

    // 7. معالجة الرد
    let parsedResponse;
    try {
        const cleanText = (typeof aiResult === 'object' ? aiResult.text : aiResult)
                          .replace(/```json/g, '').replace(/```/g, '').trim();
        parsedResponse = JSON.parse(cleanText);
    } catch (e) {
        parsedResponse = { reply: typeof aiResult === 'object' ? aiResult.text : aiResult, widgets: [] };
    }

    // 8. Gatekeeper & Widgets
    let finalWidgets = parsedResponse.widgets || [];
    // التحقق من lessonId الأصلي لإتمام الدرس
    const targetLessonId = (contextId !== 'general') ? contextId : null;
    
    if (parsedResponse.lesson_signal?.type === 'complete' && targetLessonId) {
        const gateResult = await markLessonComplete(userId, targetLessonId, parsedResponse.lesson_signal.score || 100);
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `صحيت! +${gateResult.reward.coins_added} كوين`, coins: gateResult.reward.coins_added } 
            });
        }
    }

    // 9. حفظ رد البوت
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId, 
        role: 'assistant', 
        content: parsedResponse.reply,
        metadata: { widgets: parsedResponse.widgets || [] }
    });

    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: finalWidgets, // تأكدنا من إرسال الويدجت المحدثة
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
