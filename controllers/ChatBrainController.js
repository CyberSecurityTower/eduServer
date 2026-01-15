'use strict';

const axios = require('axios');
const mammoth = require('mammoth');
const path = require('path'); // ✅ نحتاج هذا لتحديد المسار المحلي

// استيراد مكتبة Mozilla
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');

// ============================================================
// 🛠️ Helper: استخراج PDF احترافي (مصحح للعربية) ✅
// ============================================================
async function extractPdfWithMozilla(buffer) {
    try {
        const uint8Array = new Uint8Array(buffer);
        
        // 🔥 الحل الجذري: تحديد مسار الملفات محلياً من node_modules
        // نستخدم require.resolve للعثور على مكان المكتبة بدقة داخل السيرفر
        const pdfLibPath = require.resolve('pdfjs-dist/legacy/build/pdf.js');
        // نرجع للخلف 3 خطوات للوصول للمجلد الرئيسي: build -> legacy -> pdfjs-dist -> cmaps
        const pdfDistDir = path.dirname(path.dirname(path.dirname(pdfLibPath)));
        
        const CMAP_URL = path.join(pdfDistDir, 'cmaps/');
        const STANDARD_FONT_DATA_URL = path.join(pdfDistDir, 'standard_fonts/');

        console.log(`📂 Loading fonts from: ${CMAP_URL}`);

        const loadingTask = pdfjsLib.getDocument({
            data: uint8Array,
            cMapUrl: CMAP_URL, // ✅ مسار محلي
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL, // ✅ مسار محلي
            disableFontFace: false,
            fontExtraProperties: true
        });

        const doc = await loadingTask.promise;
        
        let fullText = "";
        console.log(`📘 PDF Loaded: ${doc.numPages} pages. Parsing Arabic...`);

        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            
            // تجميع النص
            const pageText = textContent.items.map(item => item.str).join(' ');
            
            // تنظيف النص (إزالة الفراغات الزائدة)
            const cleanPageText = pageText.replace(/\s+/g, ' ').trim();
            
            fullText += `\n--- Page ${i} ---\n${cleanPageText}`;
        }

        return fullText.trim();
    } catch (e) {
        console.error("❌ Mozilla PDF Extract Error:", e.message);
        throw e;
    }
}
// ============================================================
// 🛠️ Main Helper: الموجه الرئيسي
// ============================================================
async function extractTextFromCloudinaryUrl(url, mimeType) {
    try {
        console.log(`📥 Downloading: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000 });
        const buffer = Buffer.from(response.data);
        console.log(`📦 File Size: ${buffer.length} bytes`);

        if (mimeType === 'application/pdf') {
            console.log("📄 PDF detected. Running Local Engine...");
            const text = await extractPdfWithMozilla(buffer);
            console.log(`✅ PDF Extracted! Length: ${text.length} chars`);
            return text;
        } 
        else if (mimeType.includes('word') || mimeType.includes('document')) {
            console.log("📝 Word detected. Running Mammoth...");
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value.trim();
        }
        else if (mimeType.startsWith('text/')) {
            return buffer.toString('utf-8');
        }
        
        return null;
    } catch (error) {
        console.error(`❌ Extraction Failed:`, error.message);
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
      .from('chat_sessions').select('id')
      .eq('user_id', userId).eq('context_id', lessonId || 'general').maybeSingle();

    if (!session) return res.json({ messages: [], nextCursor: null });

    let query = supabase.from('chat_messages').select('*').eq('session_id', session.id)
      .order('created_at', { ascending: false }).limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data: messages } = await query;
    const nextCursor = messages && messages.length === limit ? messages[messages.length - 1].created_at : null;
    res.json({ messages: messages || [], nextCursor });

  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 🧠 Main Process Chat (Test Mode)
// ============================================================
async function processChat(req, res) {
  let { userId, message, files = [], currentContext } = req.body;
  const lessonId = currentContext?.lessonId || req.body.lessonId;
  const lessonTitle = currentContext?.lessonTitle || req.body.lessonTitle;
  const currentContextId = (lessonId && lessonId !== 'undefined') ? lessonId : 'general';

  try {
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

    const uploadedAttachments = [];
    if (files && files.length > 0) {
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                let uploadOptions = { resource_type: "auto", folder: `chat_uploads/${userId}` };
                
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf';
                else if (file.mime.includes('word')) uploadOptions.resource_type = 'raw';

                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, uploadOptions);
                uploadedAttachments.push({
                    url: uploadRes.secure_url, public_id: uploadRes.public_id, mime: file.mime, type: 'file'
                });
            } catch (e) { console.error('Upload Error:', e.message); }
        }
    }

    const { data: savedUserMsg } = await supabase.from('chat_messages').insert({
        session_id: sessionId, user_id: userId, role: 'user', content: message,
        attachments: uploadedAttachments, metadata: { context: lessonId }
    }).select().single();

    console.log("⚠️ TEST MODE: AI Bypassed.");
    const mockReply = uploadedAttachments.length > 0 
        ? "تم استلام الملف! جاري استخراج النص العربي/الإنجليزي وتخزينه..." 
        : "وضع التجربة.";

    await supabase.from('chat_messages').insert({
        session_id: sessionId, user_id: userId, role: 'assistant', content: mockReply
    });

    res.status(200).json({ reply: mockReply, widgets: [], sessionId: sessionId });

    // Background Job
    setImmediate(async () => {
        try {
            if (uploadedAttachments.length > 0 && savedUserMsg?.id) {
                console.log("🔄 Background: Starting Extraction...");
                let allExtractedText = "";
                let hasUpdates = false;

                for (const att of uploadedAttachments) {
                    if (!att.mime.startsWith('image/') && !att.mime.startsWith('audio/')) {
                        const text = await extractTextFromCloudinaryUrl(att.url, att.mime);
                        if (text) {
                            allExtractedText += `\n\n=== FILE: ${att.mime} ===\n${text}\n`;
                            hasUpdates = true;
                        }
                    }
                }

                if (hasUpdates) {
                    await supabase.from('chat_messages')
                        .update({ metadata: { ...savedUserMsg.metadata, extracted_text: allExtractedText } })
                        .eq('id', savedUserMsg.id);
                    console.log("💾 Text saved to DB successfully!");
                }
            }
        } catch (e) { console.error('🔥 Background Failed:', e); }
    });

  } catch (err) {
    console.error('🔥 Fatal Error:', err);
    res.status(500).json({ reply: "Error." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized.');
}

module.exports = { processChat, getChatHistory, initChatBrainController };
