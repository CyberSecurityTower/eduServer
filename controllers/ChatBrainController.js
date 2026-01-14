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
const { updateAtomicProgress } = require('../services/atomic/atomicManager'); // منطق التقدم القديم
const { markLessonComplete } = require('../services/engines/gatekeeper'); // منطق البوابات والمكافآت
const logger = require('../utils/logger'); // تأكد من وجود هذا الملف أو استبدله بـ console

// تهيئة Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============================================================
// 🛠️ Helper: استخراج النصوص من الروابط (Background Worker)
// ============================================================
async function extractTextFromCloudinaryUrl(url, mimeType) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        if (mimeType === 'application/pdf') {
            const data = await pdf(buffer);
            // تنظيف النص من الفراغات الزائدة
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
// 📜 Get Chat History (للتحميل عند فتح الشات)
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    // 1. البحث عن الجلسة
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', lessonId || 'general')
      .maybeSingle();

    if (!session) {
      return res.json({ messages: [], nextCursor: null });
    }

    // 2. جلب الرسائل
    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false }) // الأحدث أولاً
      .limit(limit);

    if (cursor) {
      query = query.lt('created_at', cursor);
    }

    const { data: messages, error } = await query;
    if (error) throw error;

    const nextCursor = messages.length === limit ? messages[messages.length - 1].created_at : null;

    res.json({
      messages: messages, // الفرونت سيتعامل مع عكس الترتيب (Inverted List)
      nextCursor
    });

  } catch (error) {
    console.error("Fetch History Error:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 🧠 Main Process Chat (المنطق الأساسي)
// ============================================================
async function processChat(req, res) {
  let { 
    userId, message, files = [], 
    lessonId, lessonTitle 
  } = req.body;

  // تنظيف المدخلات
  const currentContextId = lessonId || 'general';

  try {
    // ---------------------------------------------------------
    // 1. إدارة الجلسة (SQL Session Management)
    // ---------------------------------------------------------
    let sessionId;
    
    // محاولة العثور على جلسة مفتوحة لنفس السياق
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', currentContextId)
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        // تحديث وقت آخر ظهور
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        // إنشاء جلسة جديدة
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: currentContextId,
            context_type: lessonId ? 'lesson' : 'general',
            summary: lessonTitle || 'General Chat'
        }).select().single();
        sessionId = newSession.id;
    }

    // ---------------------------------------------------------
    // 2. معالجة الملفات (Cloudinary + AI Prep)
    // ---------------------------------------------------------
    const uploadedAttachments = []; // للحفظ في قاعدة البيانات
    const geminiInlineParts = [];   // للإرسال للذكاء الاصطناعي فوراً

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                // تنظيف Base64
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                
                // أ. تجهيز للذكاء الاصطناعي (Multimodal)
                geminiInlineParts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: file.mime
                    }
                });

                // ب. الرفع لـ Cloudinary (للحفظ الدائم)
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
    // 3. بناء السياق التعليمي (Context & Lessons)
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;

    if (lessonId && lessonId !== 'general') {
        // جلب بيانات الدرس
        const { data: lesson } = await supabase.from('lessons').select('*').eq('id', lessonId).maybeSingle();
        
        if (lesson) {
            lessonData = lesson;
            // جلب محتوى الدرس (اختياري، نأخذ مقتطف لتقليل التكلفة)
            const { data: contentData } = await supabase
                .from('lessons_content')
                .select('content')
                .eq('lesson_id', lessonId)
                .maybeSingle();

            const snippet = contentData?.content ? contentData.content.substring(0, 2000) : "Content not found in DB, use general knowledge.";

            locationContext = `
            🚨 **ACTIVE LESSON CONTEXT:**
            User is currently studying: "${lesson.title}".
            
            👇 **LESSON SOURCE MATERIAL:**
            """
            ${snippet}...
            """
            
            **INSTRUCTIONS:**
            1. Act as a tutor specifically for this lesson.
            2. If the user asks specifically about the text, use the source material above.
            `;
        }
    }

    // ---------------------------------------------------------
    // 4. بناء الذاكرة (Chat History)
    // ---------------------------------------------------------
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(6); // آخر 6 رسائل للسياق

    // تحويل التاريخ لصيغة Gemini
    // Gemini: user -> model -> user -> model
    const history = (historyData || []).reverse().map(msg => {
        const parts = [{ text: msg.content || " " }];
        
        // إذا كان هناك نص مستخرج من ملف سابقاً، نضيفه للسياق
        if (msg.metadata && msg.metadata.extracted_text) {
            parts.push({ text: `\n[System: Attached File Content]\n${msg.metadata.extracted_text}` });
        }
        
        return {
            role: msg.role === 'user' ? 'user' : 'model',
            parts: parts
        };
    });

    // ---------------------------------------------------------
    // 5. حفظ رسالة المستخدم (قبل الرد)
    // ---------------------------------------------------------
    const { data: savedUserMsg } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments,
        metadata: { context: lessonId }
    }).select().single();

    // ---------------------------------------------------------
    // 6. تنفيذ الذكاء الاصطناعي (AI Execution)
    // ---------------------------------------------------------
    const systemPrompt = `
    You are 'EduAI', a smart, friendly, and engaging tutor.
    ${locationContext}
    
    **OUTPUT FORMAT:**
    You must return a raw JSON object (no markdown formatting).
    Structure:
    {
      "reply": "Your explanation here...",
      "widgets": [], // Optional UI elements like 'celebration'
      "lesson_signal": { "type": "complete", "score": 100 } // Only if user passed a quiz/request
    }
    
    Current Date: ${new Date().toISOString()}
    `;

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" } // JSON Mode
    });

    const chatSession = model.startChat({ history: history });
    
    // إرسال الرسالة + الصور/الملفات
    const currentPromptParts = [{ text: message }, ...geminiInlineParts];
    const result = await chatSession.sendMessage(currentPromptParts);
    
    // معالجة الرد
    const responseText = result.response.text();
    let parsedResponse;
    try {
        parsedResponse = JSON.parse(responseText);
    } catch (e) {
        // Fallback if JSON fails
        parsedResponse = { reply: responseText, widgets: [] };
    }

    // ---------------------------------------------------------
    // 7. المنطق التعليمي (Rewards & Signals)
    // ---------------------------------------------------------
    let finalWidgets = parsedResponse.widgets || [];
    let rewardData = {};

    // أ. تحقق من إشارة إكمال الدرس
    if (parsedResponse.lesson_signal?.type === 'complete' && lessonData) {
        // استدعاء محرك البوابات (Gatekeeper)
        const gateResult = await markLessonComplete(
            userId, 
            lessonId, 
            parsedResponse.lesson_signal.score || 100
        );

        // إضافة ويدجت الاحتفال إذا كان هناك عملات
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { 
                    message: `أحسنت! 🪙 +${gateResult.reward.coins_added}`, 
                    coins: gateResult.reward.coins_added 
                } 
            });
            rewardData = { 
                reward: gateResult.reward, 
                new_total_coins: gateResult.new_total_coins 
            };
        }
    }

    // ب. تحديث التقدم الذري (Atomic Progress) إذا كان هذا درساً
    if (lessonId && lessonId !== 'general') {
        // نطلب من النظام الذري تحديث الفهم بناءً على تفاعل الشات
        // هنا نفترض أن التفاعل زاد الفهم بنسبة بسيطة افتراضياً
        await updateAtomicProgress(userId, lessonId, { 
            element_id: 'chat_interaction', 
            new_score: 10, // زيادة تدريجية
            increment: true 
        });
    }

    // ---------------------------------------------------------
    // 8. إرسال الرد للعميل وحفظ الرد في القاعدة
    // ---------------------------------------------------------
    
    // حفظ رد المساعد
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: parsedResponse.reply,
        metadata: { 
            widgets: finalWidgets,
            lesson_signal: parsedResponse.lesson_signal 
        }
    });

    // الرد على API
    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: finalWidgets,
        sessionId: sessionId,
        ...rewardData
    });

    // ---------------------------------------------------------
    // 9. الخلفية: استخراج النصوص (Background Task)
    // ---------------------------------------------------------
    // يتم تنفيذه بعد إرسال الرد للعميل لتسريع الاستجابة
    setImmediate(async () => {
        try {
            if (uploadedAttachments.length > 0 && savedUserMsg) {
                let extractedTextCombined = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    // تجاهل الصور والصوتيات (Gemini يراها، لا داعي لاستخراج نص منها هنا)
                    // نركز على الـ PDF والـ Word
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
                    // تحديث رسالة المستخدم الأصلية بالنص المستخرج
                    // هذا يسمح لنا بإرسال محتوى الملف في الـ History في الرسائل القادمة
                    await supabase
                        .from('chat_messages')
                        .update({
                            metadata: { 
                                ...savedUserMsg.metadata,
                                extracted_text: extractedTextCombined 
                            }
                        })
                        .eq('id', savedUserMsg.id);
                        
                    console.log(`✅ Background: Text extracted and saved for Msg ${savedUserMsg.id}`);
                }
            }
        } catch (e) { 
            console.error('❌ Background Task Error:', e); 
        }
    });

  } catch (err) {
    console.error('🔥 ChatBrain Fatal:', err);
    return res.status(500).json({ reply: "واجهنا مشكلة تقنية بسيطة، حاول مرة أخرى." });
  }
}
// 👇 أضف هذه الدالة في نهاية الملف قبل module.exports
function initChatBrainController(dependencies) {
    // هذه الدالة ضرورية لأن index.js يقوم بمناداتها عند الإقلاع.
    // يمكننا استخدامها مستقبلاً لحقن التبعيات (Dependency Injection).
    console.log('🧠 ChatBrainController initialized successfully.');
}
module.exports = { processChat, getChatHistory, initChatBrainController  };
