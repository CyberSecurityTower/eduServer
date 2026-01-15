'use strict';

const axios = require('axios');
const mammoth = require('mammoth');
// استيراد مكتبة Mozilla (النسخة Legacy لتعمل مع Node.js بدون مشاكل)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');

// ============================================================
// 🛠️ Helper: استخراج PDF احترافي (محرك Mozilla)
// ============================================================
async function extractPdfWithMozilla(buffer) {
    try {
        // تحويل الـ Buffer إلى Uint8Array
        const uint8Array = new Uint8Array(buffer);
        
        // تحميل المستند
        const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
        const doc = await loadingTask.promise;
        
        let fullText = "";
        console.log(`📘 PDF Loaded: ${doc.numPages} pages.`);

        // المرور على كل الصفحات
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            
            // تجميع الكلمات
            const pageText = textContent.items.map(item => item.str).join(' ');
            
            // إضافة النص
            fullText += `\n--- Page ${i} ---\n${pageText}`;
        }

        return fullText.trim();
    } catch (e) {
        console.error("❌ Mozilla PDF Extract Error:", e.message);
        throw e;
    }
}

// ============================================================
// 🛠️ Main Helper: الموجه الرئيسي لاستخراج النصوص
// ============================================================
async function extractTextFromCloudinaryUrl(url, mimeType) {
    try {
        console.log(`📥 Downloading: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000 });
        const buffer = Buffer.from(response.data);
        console.log(`📦 File Size: ${buffer.length} bytes`);

        // 1. معالجة PDF
        if (mimeType === 'application/pdf') {
            console.log("📄 PDF detected. Running Mozilla Engine...");
            const text = await extractPdfWithMozilla(buffer);
            console.log(`✅ PDF Extracted! Length: ${text.length} chars`);
            return text;
        } 
        
        // 2. معالجة Word
        else if (mimeType.includes('word') || mimeType.includes('document')) {
            console.log("📝 Word detected. Running Mammoth...");
            const result = await mammoth.extractRawText({ buffer: buffer });
            console.log(`✅ Word Extracted! Length: ${result.value.length} chars`);
            return result.value.trim();
        }
        
        // 3. معالجة النصوص البسيطة
        else if (mimeType.startsWith('text/')) {
            return buffer.toString('utf-8');
        }
        
        return null;
    } catch (error) {
        console.error(`❌ Extraction Failed for ${url}:`, error.message);
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
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 🧠 Main Process Chat (Test Mode: Text Extraction Only)
// ============================================================
async function processChat(req, res) {
  let { userId, message, files = [], currentContext } = req.body;
  const lessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;
  const currentContextId = (lessonId && lessonId !== 'undefined') ? lessonId : 'general';

  try {
    // 1. إدارة الجلسة
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

    // 2. رفع الملفات (Cloudinary)
    const uploadedAttachments = [];
    if (files && files.length > 0) {
        console.log(`📤 Uploading ${files.length} files...`);
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                
                let uploadOptions = { 
                    resource_type: "auto", 
                    folder: `chat_uploads/${userId}` 
                };
                
                // إجبار الـ PDF على أن يكون PDF في الرابط
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf';
                // ملفات الوورد نعاملها كملفات خام لتجنب تلفها
                else if (file.mime.includes('word')) uploadOptions.resource_type = 'raw';

                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, uploadOptions);

                console.log(`✅ Uploaded: ${uploadRes.secure_url}`);
                uploadedAttachments.push({
                    url: uploadRes.secure_url,
                    public_id: uploadRes.public_id,
                    mime: file.mime,
                    type: file.mime.startsWith('image') ? 'image' : 'file'
                });
            } catch (e) { console.error('Upload Error:', e.message); }
        }
    }

    // 3. حفظ رسالة المستخدم
    const { data: savedUserMsg } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments,
        metadata: { context: lessonId }
    }).select().single();

    // 4. ⛔ تجاوز الذكاء الاصطناعي (Test Mode)
    console.log("⚠️ TEST MODE: AI Logic Bypassed.");
    
    const mockReply = uploadedAttachments.length > 0 
        ? "تم استلام الملف بنجاح! 📄 أقوم الآن باستخراج النص منه وحفظه في قاعدة البيانات..." 
        : "مرحباً! أنا في وضع التجربة حالياً.";

    // 5. حفظ رد البوت الوهمي
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: mockReply
    });

    // 6. الرد على العميل
    res.status(200).json({
        reply: mockReply,
        widgets: [],
        sessionId: sessionId
    });

    // 7. 🔥 العمل في الخلفية: استخراج النصوص وحفظها
    // سيتم تنفيذ هذا الكود بعد إرسال الرد للعميل
    setImmediate(async () => {
        try {
            if (uploadedAttachments.length > 0 && savedUserMsg?.id) {
                console.log("🔄 Background: Starting Text Extraction...");
                let allExtractedText = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    // تجاهل الصور والصوتيات، ركز على المستندات
                    if (!att.mime.startsWith('image/') && !att.mime.startsWith('audio/')) {
                        const text = await extractTextFromCloudinaryUrl(att.url, att.mime);
                        if (text) {
                            allExtractedText += `\n\n=== FILE: ${att.mime} ===\n${text}\n`;
                            hasUpdates = true;
                        }
                    }
                }

                if (hasUpdates) {
                    // تحديث رسالة المستخدم بالنص المستخرج
                    const { error } = await supabase
                        .from('chat_messages')
                        .update({ 
                            metadata: { 
                                ...savedUserMsg.metadata, 
                                extracted_text: allExtractedText // 💾 هنا يتم الحفظ
                            } 
                        })
                        .eq('id', savedUserMsg.id);
                        
                    if (!error) console.log("💾 Database Updated: Text saved successfully!");
                    else console.error("❌ Database Update Error:", error.message);
                } else {
                    console.log("ℹ️ No text extracted from files.");
                }
            }
        } catch (e) { console.error('🔥 Background Job Failed:', e); }
    });

  } catch (err) {
    console.error('🔥 Fatal Error:', err);
    res.status(500).json({ reply: "Error in server." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized (Text Extraction Mode).');
}

module.exports = { processChat, getChatHistory, initChatBrainController };
