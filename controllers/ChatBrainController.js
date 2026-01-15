'use strict';

const axios = require('axios');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs'); // ✅ ضروري لقراءة الخطوط
// استيراد مكتبة Mozilla
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Config & Services
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');

// ============================================================
// 🛠️ Custom CMap Reader (السر لحل مشكلة الرموز الغريبة) 🔑
// ============================================================
// هذا الكلاس يعلم pdf.js كيف يقرأ ملفات الخطوط من السيرفر مباشرة
class NodeCMapReaderFactory {
    constructor({ baseUrl = null, isCompressed = false }) {
        this.baseUrl = baseUrl;
        this.isCompressed = isCompressed;
    }

    fetch({ name }) {
        return new Promise((resolve, reject) => {
            if (!this.baseUrl) return resolve({ cMapData: [], compressionType: 0 });
            
            const url = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
            
            fs.readFile(url, (err, data) => {
                if (err) return reject(new Error(err.message));
                return resolve({
                    cMapData: new Uint8Array(data),
                    compressionType: this.isCompressed ? 1 : 0,
                });
            });
        });
    }
}

// ============================================================
// 🛠️ Helper: استخراج PDF
// ============================================================
async function extractPdfWithMozilla(buffer) {
    try {
        const uint8Array = new Uint8Array(buffer);
        
        // تحديد مسار مجلد الخطوط (CMaps) داخل node_modules بدقة
        const pdfLibPath = require.resolve('pdfjs-dist/legacy/build/pdf.js');
        const pdfDistDir = path.dirname(path.dirname(path.dirname(pdfLibPath)));
        const CMAP_URL = path.join(pdfDistDir, 'cmaps/');
        const STANDARD_FONT_DATA_URL = path.join(pdfDistDir, 'standard_fonts/');

        console.log(`📂 Fonts Path: ${CMAP_URL}`);

        const loadingTask = pdfjsLib.getDocument({
            data: uint8Array,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            
            // 🔥 استخدام القارئ المخصص الذي أنشأناه بالأعلى
            CMapReaderFactory: NodeCMapReaderFactory, 
            
            // تفعيل قراءة الخطوط المدمجة
            disableFontFace: false, 
            verbosity: 0 // إخفاء التحذيرات غير المهمة
        });

        const doc = await loadingTask.promise;
        
        let fullText = "";
        console.log(`📘 PDF Loaded: ${doc.numPages} pages. Decoding Arabic...`);

        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            
            // تجميع النص
            const pageText = textContent.items.map(item => item.str).join(' ');
            
            // تنظيف النص من الرموز الزائدة
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
            console.log("📄 PDF detected. Running Node CMap Engine...");
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

// ... (بقية الملف getChatHistory و processChat تبقى كما هي تماماً من الرد السابق)
// ... (لا تنس نسخها أو تركها كما هي إذا لم تمسحها)

// ============================================================
// 📜 Get Chat History (كما هو)
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
        ? "تم استلام الملف! جاري استخراج النص وتخزينه..." 
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
