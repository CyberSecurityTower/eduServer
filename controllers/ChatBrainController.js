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

// ... (getChatHistory function remains same) ...
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query;
  const limit = 20;

  try {
    // ✅ الخطوة الحاسمة: تحديد سياق الجلسة بصرامة
    // إذا وجد lessonId نستخدمه كـ context_id، وإلا نستخدم 'general'
    const contextId = (lessonId && lessonId !== 'undefined' && lessonId !== 'null') 
                      ? lessonId 
                      : 'general';

    // البحث عن الجلسة الخاصة بهذا الدرس تحديداً
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', contextId) // 👈 هنا يتم الفصل
      .maybeSingle();

    // إذا لم توجد جلسة لهذا الدرس، نرجع مصفوفة فارغة (شات جديد)
    if (!session) {
        return res.json({ messages: [], nextCursor: null });
    }

    // جلب الرسائل التابعة لهذا الـ session_id فقط
    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id) // 👈 جلب رسائل هذه الجلسة فقط
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
// 🧠 Main Process Chat (Full Visual Memory Mode 👁️📸)
// ============================================================
async function processChat(req, res) {
  let { userId, message, files = [], currentContext, webSearch } = req.body;
  
  // استخراج معرف الدرس بدقة
  const lessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;

  // ✅ تحديد الـ Context ID بصرامة
  const currentContextId = (lessonId && lessonId !== 'undefined' && lessonId !== 'null') 
                           ? lessonId 
                           : 'general';

  try {
    // 1. البحث عن أو إنشاء جلسة خاصة لهذا الدرس
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', currentContextId) // 👈 البحث عن جلسة هذا الدرس
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        // تحديث وقت آخر ظهور
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        // إنشاء جلسة جديدة مربوطة بهذا الدرس
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: currentContextId, // 👈 ربط الجلسة بالدرس
            context_type: currentContextId === 'general' ? 'general' : 'lesson',
            summary: lessonTitle || 'General Chat'
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
    let locationContext = `Context: ${lessonTitle || 'General Discussion'}`;
    if (lessonId && lessonId !== 'general') {
        const { data: contentData } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonId).maybeSingle();
        if (contentData?.content) contentSnippet = contentData.content.substring(0, 15000);
    }
    const userProfile = await getProfile(userId);

    // ==================================================================================
    // 4. بناء الذاكرة "الحية" (استرجاع الصور القديمة وتحويلها لـ Base64)
    // ==================================================================================
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, attachments')
        .eq('session_id', sessionId)
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
        session_id: sessionId, user_id: userId, role: 'user', content: message,
        attachments: dbAttachments, 
        metadata: { context: lessonId }
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
    console.log('🧠 ChatBrainController initialized (FULL VISION MODE).');
}

module.exports = { processChat, getChatHistory, initChatBrainController };
