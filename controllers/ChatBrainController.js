'use strict';

const axios = require('axios');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const generateWithFailover = require('../services/ai/failover');
const { markLessonComplete } = require('../services/engines/gatekeeper');
// ✅ استيراد ملفات البرومبت الجديدة
const PROMPTS = require('../config/ai-prompts'); 

// ============================================================
// 🛠️ Helper: استخراج النصوص (كما هو)
// ============================================================
async function extractTextFromCloudinaryUrl(url, mimeType) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        if (mimeType === 'application/pdf') {
            const data = await pdf(buffer);
            return data.text.replace(/\n\s*\n/g, '\n').trim(); 
        } 
        else if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value.trim();
        }
        else if (mimeType.startsWith('text/')) {
            return buffer.toString('utf-8');
        }
        return null;
    } catch (error) {
        console.error(`❌ Text Extraction Failed for ${url}:`, error.message);
        return null;
    }
}

// ============================================================
// 📜 Get Chat History (كما هو)
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', lessonId || 'general')
      .maybeSingle();

    if (!session) return res.json({ messages: [], nextCursor: null });

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data: messages, error } = await query;
    if (error) throw error;

    const nextCursor = messages.length === limit ? messages[messages.length - 1].created_at : null;

    res.json({ messages: messages, nextCursor });

  } catch (error) {
    console.error("Fetch History Error:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

const keyPart = process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 20) : "NO_KEY";
console.log("🔑 KEY BEING USED:", keyPart, "...");
// ============================================================
// 🧠 Main Process Chat (Final Version)
// ============================================================
async function processChat(req, res) {
  // 1. استخراج البيانات (ندعم currentContext أو القيم المباشرة)
  let { 
    userId, message, files = [], webSearch, 
    currentContext 
  } = req.body;

  // استخراج معرف وعنوان الدرس بدقة
  const lessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;

  // تحديد سياق الجلسة (إذا لم يوجد درس، نعتبره general)
  const currentContextId = (lessonId && lessonId !== 'undefined') ? lessonId : 'general';

  try {
    // ---------------------------------------------------------
    // 2. إدارة الجلسة (Session Management)
    // ---------------------------------------------------------
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', currentContextId)
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        // تحديث "آخر ظهور" للجلسة
        supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId).then();
    } else {
        const { data: newSession, error: createError } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: currentContextId,
            context_type: (lessonId && lessonId !== 'general') ? 'lesson' : 'general',
            summary: lessonTitle || 'General Chat'
        }).select().single();

        if (createError || !newSession) {
            console.error("❌ Session Creation Failed:", createError);
            return res.status(500).json({ reply: "عذراً، فشل بدء المحادثة." });
        }
        sessionId = newSession.id;
    }

    // ---------------------------------------------------------
    // 3. معالجة الملفات (Cloudinary)
    // ---------------------------------------------------------
    const uploadedAttachments = [];
    const geminiInlineParts = [];

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                geminiInlineParts.push({
                    inlineData: { data: base64Data, mimeType: file.mime }
                });

                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, {
                    resource_type: "auto",
                    folder: `chat_uploads/${userId}`
                });

                uploadedAttachments.push({
                    url: uploadRes.secure_url,
                    public_id: uploadRes.public_id,
                    mime: file.mime,
                    type: file.mime.startsWith('image') ? 'image' : (file.mime.startsWith('audio') ? 'audio' : 'file')
                });
            } catch (e) { console.error('File process error:', e.message); }
        }
    }

    // ---------------------------------------------------------
    // 4. جلب محتوى الدرس (Context Fetching)
    // ---------------------------------------------------------
    let contentSnippet = "";
    let locationContext = `Currently in: ${lessonTitle || 'General Chat'}`;
    
    // إذا كان المستخدم داخل درس فعلي
    if (lessonId && lessonId !== 'general') {
        // أ) جلب النص من جدول المحتوى (عملية منفصلة كما طلبت)
        const { data: contentData } = await supabase
            .from('lessons_content')
            .select('content')
            .eq('lesson_id', lessonId)
            .maybeSingle();

        if (contentData && contentData.content) {
            // نأخذ النص كاملاً أو جزءاً كبيراً منه (Gemini Pro/Flash يقبل سياقاً كبيراً)
            contentSnippet = contentData.content.substring(0, 25000); 
            locationContext = `Active Lesson: "${lessonTitle}"`;
        }
    }

    // جلب اسم الطالب (اختياري للتحسين)
    let userProfile = { firstName: 'Student' };
    try {
        const { data: profile } = await supabase.from('ai_memory_profiles').select('user_name').eq('user_id', userId).maybeSingle();
        if (profile?.user_name) userProfile.firstName = profile.user_name;
    } catch(e) {}

    // ---------------------------------------------------------
    // 5. بناء الذاكرة (History)
    // ---------------------------------------------------------
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(8);

    const history = (historyData || []).reverse().map(msg => {
        const parts = [{ text: msg.content || " " }];
        if (msg.metadata && msg.metadata.extracted_text) {
            parts.push({ text: `\n[System: Previous File Content]\n${msg.metadata.extracted_text}` });
        }
        return { role: msg.role === 'user' ? 'user' : 'model', parts };
    });

    // ---------------------------------------------------------
    // 6. حفظ رسالة المستخدم
    // ---------------------------------------------------------
     const { data: savedUserMsg, error: saveUserError } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments,
        metadata: { context: lessonId }
    }).select().single();

    if (saveUserError) {
        console.error("❌ FAILED to save User Message:", saveUserError);
        // لا نوقف العملية، لكن نسجل الخطأ لنعرف السبب
    } else {
        console.log("✅ User Message Saved:", savedUserMsg.id);
    }

    // ---------------------------------------------------------
    // 7. الاتصال بالذكاء الاصطناعي 🤖
    // ---------------------------------------------------------
    
    // استخدام البرومبت الجديد وتمرير محتوى الدرس الذي جلبناه من DB
    const personaPrompt = PROMPTS.chat.interactiveChat(
        message,        // رسالة الطالب
        userProfile,    // اسمه
        locationContext,// سياق المكان (عنوان الدرس)
        lessonTitle,    // خريطة الدرس (العنوان أيضاً)
        contentSnippet  // ✅ محتوى الدرس الفعلي من قاعدة البيانات
    );

    const finalSystemPrompt = `
    ${personaPrompt}

    🛑 **SYSTEM OVERRIDE (TECHNICAL RULES):**
    1. You MUST output strictly valid JSON.
    2. Structure: { "reply": "...", "widgets": [], "lesson_signal": { "type": "complete", "score": 100 } }
    3. Use 'lesson_signal' ONLY if the user proves mastery/completes the lesson goal based on the REFERENCE CONTENT provided.
    `;

    const aiResult = await generateWithFailover('chat', message, {
        systemInstruction: { parts: [{ text: finalSystemPrompt }] },
        history: history,
        attachments: geminiInlineParts,
        enableSearch: !!webSearch,
        label: 'ChatBrain_v6'
    });
    
    // استخراج النص والتنظيف
    const rawAiText = typeof aiResult === 'object' ? aiResult.text : aiResult;
    let parsedResponse;
    try {
        const cleanText = rawAiText.replace(/```json/g, '').replace(/```/g, '').trim();
        parsedResponse = JSON.parse(cleanText);
    } catch (e) {
        parsedResponse = { reply: rawAiText, widgets: [] };
    }

    // ---------------------------------------------------------
    // 8. المنطق التعليمي (المكافآت)
    // ---------------------------------------------------------
    let finalWidgets = parsedResponse.widgets || [];
    let rewardData = {};

    // التحقق من إشارة الاكتمال
    if (parsedResponse.lesson_signal?.type === 'complete' && lessonId && lessonId !== 'general') {
        const gateResult = await markLessonComplete(userId, lessonId, parsedResponse.lesson_signal.score || 100);
        
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `أحسنت! 🪙 +${gateResult.reward.coins_added}`, coins: gateResult.reward.coins_added } 
            });
            rewardData = { reward: gateResult.reward, new_total_coins: gateResult.new_total_coins };
        }
    }

    // ---------------------------------------------------------
    // 9. حفظ الرد والانتهاء
    // ---------------------------------------------------------
    const { error: saveBotError } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: parsedResponse.reply,
        metadata: { widgets: finalWidgets, lesson_signal: parsedResponse.lesson_signal }
    });

    if (saveBotError) {
        console.error("❌ FAILED to save Bot Message:", saveBotError);
    } else {
        console.log("✅ Bot Message Saved.");
    }

    // ---------------------------------------------------------
    // 10. الخلفية: استخراج النصوص (للملفات المرفقة)
    // ---------------------------------------------------------
    setImmediate(async () => {
        try {
            if (uploadedAttachments.length > 0 && savedUserMsg?.id) {
                let extractedText = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    if (!att.mime.startsWith('image/') && !att.mime.startsWith('audio/')) {
                        const text = await extractTextFromCloudinaryUrl(att.url, att.mime);
                        if (text) {
                            extractedText += `\n--- Extracted Content (${att.mime}) ---\n${text}\n`;
                            hasUpdates = true;
                        }
                    }
                }

                if (hasUpdates) {
                    await supabase
                        .from('chat_messages')
                        .update({ metadata: { ...savedUserMsg.metadata, extracted_text: extractedText } })
                        .eq('id', savedUserMsg.id);
                }
            }
        } catch (e) { console.error('Bg Extraction Error:', e); }
    });

  } catch (err) {
    console.error('🔥 ChatBrain Fatal:', err);
    return res.status(500).json({ reply: "نواجه ضغطاً عالياً حالياً، يرجى المحاولة بعد لحظات." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized successfully.');
}
module.exports = { processChat, getChatHistory, initChatBrainController };
