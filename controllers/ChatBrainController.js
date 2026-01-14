// controllers/ChatBrainController.js
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const { updateAtomicProgress } = require('../services/atomic/atomicManager');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const logger = require('../utils/logger');

// تهيئة Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============================================================
// 🛠️ Helper: استخراج النصوص
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
// 📜 Get Chat History
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', lessonId || 'general')
      .maybeSingle();

    if (sessionError) {
        console.error("❌ Supabase Error (Get Session):", sessionError.message);
    }

    if (!session) {
      return res.json({ messages: [], nextCursor: null });
    }

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) {
      query = query.lt('created_at', cursor);
    }

    const { data: messages, error: msgsError } = await query;
    
    if (msgsError) {
        console.error("❌ Supabase Error (Get Messages):", msgsError.message);
        throw msgsError;
    }

    const nextCursor = messages.length === limit ? messages[messages.length - 1].created_at : null;

    res.json({
      messages: messages,
      nextCursor
    });

  } catch (error) {
    console.error("Fetch History Error:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 🧠 Main Process Chat
// ============================================================
async function processChat(req, res) {
  let { 
    userId, message, files = [], 
    lessonId, lessonTitle 
  } = req.body;

  const currentContextId = lessonId || 'general';

  try {
    // ---------------------------------------------------------
    // 1. إدارة الجلسة (مع طباعة الأخطاء)
    // ---------------------------------------------------------
    let sessionId;
    
    // محاولة العثور على جلسة
    const { data: existingSession, error: findError } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', currentContextId)
        .maybeSingle();

    if (findError) {
        console.error("❌ Supabase Error (Find Session):", findError.message);
        // لا نوقف التنفيذ، سنحاول إنشاء واحدة جديدة
    }

    if (existingSession) {
        sessionId = existingSession.id;
        // تحديث الوقت
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        // إنشاء جلسة جديدة
        const { data: newSession, error: createError } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: currentContextId,
            context_type: lessonId ? 'lesson' : 'general',
            summary: lessonTitle || 'General Chat'
        }).select().single();

        if (createError) {
            console.error("❌ Supabase CRITICAL Error (Create Session):", createError);
            console.error("Hints:", createError.hint, "| Details:", createError.details);
            return res.status(500).json({ reply: "عذراً، حدث خطأ في قاعدة البيانات أثناء بدء المحادثة." });
        }

        if (!newSession) {
            console.error("❌ Supabase returned NULL data for new session!");
            return res.status(500).json({ reply: "فشل إنشاء الجلسة (Null Data)." });
        }

        sessionId = newSession.id; // ✅ الآن هذا السطر آمن
    }

    // ---------------------------------------------------------
    // 2. معالجة الملفات
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
            } catch (uploadErr) {
                console.error('File Upload Error:', uploadErr);
            }
        }
    }

    // ---------------------------------------------------------
    // 3. السياق
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;

    if (lessonId && lessonId !== 'general') {
        const { data: lesson } = await supabase.from('lessons').select('*').eq('id', lessonId).maybeSingle();
        if (lesson) {
            lessonData = lesson;
            const { data: contentData } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonId).maybeSingle();
            const snippet = contentData?.content ? contentData.content.substring(0, 2000) : "Content not found in DB.";
            locationContext = `🚨 **ACTIVE LESSON CONTEXT:** User is studying: "${lesson.title}".\n👇 **SOURCE:**\n"""${snippet}..."""`;
        }
    }

    // ---------------------------------------------------------
    // 4. الذاكرة
    // ---------------------------------------------------------
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(6);

    const history = (historyData || []).reverse().map(msg => {
        const parts = [{ text: msg.content || " " }];
        if (msg.metadata && msg.metadata.extracted_text) {
            parts.push({ text: `\n[System: Attached File Content]\n${msg.metadata.extracted_text}` });
        }
        return { role: msg.role === 'user' ? 'user' : 'model', parts: parts };
    });

    // ---------------------------------------------------------
    // 5. حفظ رسالة المستخدم (مع طباعة الخطأ)
    // ---------------------------------------------------------
    const { data: savedUserMsg, error: saveMsgError } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments,
        metadata: { context: lessonId }
    }).select().single();

    if (saveMsgError) {
        console.error("❌ Supabase Error (Save User Message):", saveMsgError.message);
        // لن نوقف الشات، لكننا لن نستطيع تحديث الرسالة لاحقاً بالنص المستخرج
    }

    // ---------------------------------------------------------
    // 6. الذكاء الاصطناعي
    // ---------------------------------------------------------
    const systemPrompt = `You are 'EduAI'. ${locationContext} OUTPUT JSON: { "reply": "...", "widgets": [], "lesson_signal": { "type": "complete", "score": 100 } }`;

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
    });

    const chatSession = model.startChat({ history: history });
    const currentPromptParts = [{ text: message }, ...geminiInlineParts];
    const result = await chatSession.sendMessage(currentPromptParts);
    
    const responseText = result.response.text();
    let parsedResponse;
    try {
        parsedResponse = JSON.parse(responseText);
    } catch (e) {
        parsedResponse = { reply: responseText, widgets: [] };
    }

    // ---------------------------------------------------------
    // 7. المنطق التعليمي
    // ---------------------------------------------------------
    let finalWidgets = parsedResponse.widgets || [];
    let rewardData = {};

    if (parsedResponse.lesson_signal?.type === 'complete' && lessonData) {
        const gateResult = await markLessonComplete(userId, lessonId, parsedResponse.lesson_signal.score || 100);
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `أحسنت! 🪙 +${gateResult.reward.coins_added}`, coins: gateResult.reward.coins_added } 
            });
            rewardData = { reward: gateResult.reward, new_total_coins: gateResult.new_total_coins };
        }
    }

    if (lessonId && lessonId !== 'general') {
        updateAtomicProgress(userId, lessonId, { element_id: 'chat_interaction', new_score: 10, increment: true }).catch(e => console.error("Atomic Error:", e));
    }

    // ---------------------------------------------------------
    // 8. حفظ الرد والإرسال
    // ---------------------------------------------------------
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: parsedResponse.reply,
        metadata: { widgets: finalWidgets, lesson_signal: parsedResponse.lesson_signal }
    });

    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: finalWidgets,
        sessionId: sessionId,
        ...rewardData
    });

    // 9. الخلفية: استخراج النصوص
    setImmediate(async () => {
        try {
            // ✅ التحقق من وجود savedUserMsg قبل استخدامه
            if (uploadedAttachments.length > 0 && savedUserMsg && savedUserMsg.id) {
                let extractedTextCombined = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    const isDoc = !att.mime.startsWith('image/') && !att.mime.startsWith('audio/');
                    if (isDoc) {
                        const text = await extractTextFromCloudinaryUrl(att.url, att.mime);
                        if (text) {
                            extractedTextCombined += `\n--- Extracted Content (${att.mime}) ---\n${text}\n`;
                            hasUpdates = true;
                        }
                    }
                }

                if (hasUpdates) {
                    await supabase
                        .from('chat_messages')
                        .update({
                            metadata: { ...savedUserMsg.metadata, extracted_text: extractedTextCombined }
                        })
                        .eq('id', savedUserMsg.id);
                }
            }
        } catch (e) { console.error('Background Task Error:', e); }
    });

  } catch (err) {
    console.error('🔥 ChatBrain Fatal:', err);
    return res.status(500).json({ reply: "واجهنا مشكلة تقنية بسيطة، حاول مرة أخرى." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized successfully.');
}

module.exports = { 
    processChat, 
    getChatHistory, 
    initChatBrainController 
};
