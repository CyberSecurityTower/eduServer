'use strict';

const axios = require('axios');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const generateWithFailover = require('../services/ai/failover'); // ✅ الاستيراد الجديد
const { markLessonComplete } = require('../services/engines/gatekeeper');
// ❌ تم حذف updateAtomicProgress
// ❌ تم حذف GoogleGenerativeAI المباشر

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized successfully.');
}

// ============================================================
// 🛠️ Helper: استخراج النصوص (لم يتغير)
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
// 📜 Get Chat History (لم يتغير)
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

// ============================================================
// 🧠 Main Process Chat (محدث)
// ============================================================
async function processChat(req, res) {
  let { 
    userId, message, files = [], 
    lessonId, lessonTitle, webSearch 
  } = req.body;

  const currentContextId = lessonId || 'general';

  try {
    // 1. إدارة الجلسة
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', currentContextId)
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        // تحديث طفيف للوقت (Fire & Forget)
        supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId).then();
    } else {
        const { data: newSession, error: createError } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: currentContextId,
            context_type: lessonId ? 'lesson' : 'general',
            summary: lessonTitle || 'General Chat'
        }).select().single();

        if (createError || !newSession) {
            console.error("❌ Session Creation Failed:", createError);
            return res.status(500).json({ reply: "عذراً، فشل بدء المحادثة." });
        }
        sessionId = newSession.id;
    }

    // 2. معالجة الملفات (Cloudinary + Base64 للـ AI)
    const uploadedAttachments = [];
    const geminiInlineParts = [];

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                // إعداد للـ AI
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                geminiInlineParts.push({
                    inlineData: { data: base64Data, mimeType: file.mime }
                });

                // رفع للتخزين
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

    // 3. السياق (Context Override)
    let locationContext = "";
    let lessonData = null;

    if (lessonId && lessonId !== 'general') {
        const { data: lesson } = await supabase.from('lessons').select('*').eq('id', lessonId).maybeSingle();
        if (lesson) {
            lessonData = lesson;
            // نجلب مقتطف سريع من المحتوى إذا وجد
            const { data: c } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonId).maybeSingle();
            const snippet = c?.content ? c.content.substring(0, 1500) : "No text content.";
            locationContext = `
            🚨 **ACTIVE LESSON:** "${lesson.title}"
            👇 **SOURCE MATERIAL:**
            """${snippet}..."""
            Act as a focused tutor for this lesson.
            `;
        }
    }

    // 4. بناء الذاكرة (History)
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(8); // زيادة السياق قليلاً

    const history = (historyData || []).reverse().map(msg => {
        const parts = [{ text: msg.content || " " }];
        // دمج النصوص المستخرجة سابقاً (الذاكرة طويلة المدى للملفات)
        if (msg.metadata && msg.metadata.extracted_text) {
            parts.push({ text: `\n[System: Previous File Content]\n${msg.metadata.extracted_text}` });
        }
        return { role: msg.role === 'user' ? 'user' : 'model', parts };
    });

    // 5. حفظ رسالة المستخدم
    const { data: savedUserMsg } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments,
        metadata: { context: lessonId }
    }).select().single();

    // 6. الاتصال بالذكاء الاصطناعي (عبر Failover Manager) 🚀
    const systemPrompt = `You are 'EduAI'. ${locationContext}
    RULES:
    1. Output strictly valid JSON.
    2. Format: { "reply": "...", "widgets": [], "lesson_signal": { "type": "complete", "score": 100 } }
    3. If user answers correctly, use lesson_signal.
    `;

    // ✅ استخدام generateWithFailover بدلاً من الاستدعاء المباشر
    const aiResponseText = await generateWithFailover('chat', message, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        history: history,
        attachments: geminiInlineParts, // الصور/الصوت الحالية
        enableSearch: !!webSearch,
        label: 'ChatBrain_v4'
    });
    
    // معالجة الـ JSON
    let parsedResponse;
    try {
        // تنظيف النص في حال وجود Markdown blocks
        const cleanText = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
        parsedResponse = JSON.parse(cleanText);
    } catch (e) {
        // Fallback في حال فشل الـ JSON
        parsedResponse = { reply: aiResponseText, widgets: [] };
    }

    // 7. المنطق التعليمي (Gatekeeper Rewards Only) - ❌ بدون Atomic
    let finalWidgets = parsedResponse.widgets || [];
    let rewardData = {};

    if (parsedResponse.lesson_signal?.type === 'complete' && lessonData) {
        // نتحقق من البوابات والمكافآت فقط
        const gateResult = await markLessonComplete(userId, lessonId, parsedResponse.lesson_signal.score || 100);
        
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `أحسنت! 🪙 +${gateResult.reward.coins_added}`, coins: gateResult.reward.coins_added } 
            });
            rewardData = { reward: gateResult.reward, new_total_coins: gateResult.new_total_coins };
        }
    }

    // 8. حفظ الرد والانتهاء
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

    // 9. الخلفية: استخراج النصوص (للمستقبل)
    setImmediate(async () => {
        try {
            if (uploadedAttachments.length > 0 && savedUserMsg?.id) {
                let extractedText = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    // نتجاهل الصور والصوت لأنها ترسل Multimodal
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

module.exports = { processChat, getChatHistory, initChatBrainController  };
