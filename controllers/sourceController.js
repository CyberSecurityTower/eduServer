// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const lessonGenerator = require('../services/ai/lessonGenerator');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const fs = require('fs');
const https = require('https'); 
const os = require('os');
const path = require('path');
// دالة المعالجة في الخلفية (Worker Function)
async function processAIInBackground(sourceId, filePath, mimeType, lessonTitle) {
  try {
    logger.info(`⚙️ [Background Job] Starting AI analysis for source: ${sourceId}`);

    // تشغيل خدمة الـ AI (قد تستغرق وقتاً طويلاً)
    const aiGeneratedLesson = await lessonGenerator.generateLessonFromSource(filePath, mimeType, lessonTitle);

    if (aiGeneratedLesson) {
        // نجاح: تحديث السجل إلى completed وحفظ النص
        await supabase
            .from('lesson_sources')
            .update({ 
                extracted_text: aiGeneratedLesson, 
                processed: true,
                status: 'completed', // ✅ تم الانتهاء
                error_message: null
            })
            .eq('id', sourceId);
            
        logger.success(`✅ [Background Job] AI Finished for source: ${sourceId}`);
    } else {
        // فشل الـ AI في إرجاع محتوى (لكن العملية تمت)
        await supabase
            .from('lesson_sources')
            .update({ 
                status: 'failed', 
                error_message: 'AI returned empty content or failed to process.' 
            })
            .eq('id', sourceId);
        
        logger.warn(`⚠️ [Background Job] AI returned empty for source: ${sourceId}`);
    }

  } catch (err) {
    logger.error(`❌ [Background Job] Fatal Error for source ${sourceId}:`, err.message);
    
    // تسجيل الخطأ في قاعدة البيانات
    await supabase
        .from('lesson_sources')
        .update({ 
            status: 'failed', 
            error_message: err.message 
        })
        .eq('id', sourceId);

  } finally {
    // 🧹 تنظيف الملف المؤقت: يتم الحذف هنا فقط بعد انتهاء الـ AI
    if (filePath && fs.existsSync(filePath)) {
        try { 
            fs.unlinkSync(filePath); 
            logger.info(`🧹 [Background Job] Temp file cleaned up: ${filePath}`);
        } catch(e) {
            console.error('Failed to delete temp file:', e);
        }
    }
  }
}

// 1. دالة الرفع (Endpoint Handler)
async function uploadFile(req, res) {
  const userId = req.user?.id;
  const { lessonId } = req.body;
  const file = req.file;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!file) return res.status(400).json({ error: 'No file provided' });

  try {
    // أ. جلب عنوان الدرس (لتحسين سياق الـ AI)
    let lessonTitle = "University Topic"; 
    if (lessonId) {
        const { data } = await supabase
            .from('lessons')
            .select('title')
            .eq('id', lessonId)
            .single();
        if (data && data.title) lessonTitle = data.title;
    }

    // ب. الرفع للكلاوديناري وإنشاء سجل DB (حالة processing)
    // ملاحظة: لا نحذف الملف هنا، نتركه ليعمل عليه الـ AI
    const uploadResult = await sourceManager.uploadSource(
        userId, 
        lessonId, 
        file.path, 
        file.originalname, 
        file.mimetype
    );

    // ج. الرد الفوري على العميل (202 Accepted)
    // نقول له: "استلمنا الملف، وهو قيد المعالجة"
    res.status(202).json({ 
        success: true, 
        message: 'File uploaded. AI processing started in background.',
        data: uploadResult // يحتوي على id و status: 'processing'
    });

    // د. إطلاق المعالجة في الخلفية (Fire & Forget)
    // لا نستخدم await هنا لكي لا نحجز الرد
    processAIInBackground(uploadResult.id, file.path, file.mimetype, lessonTitle);

  } catch (err) {
    logger.error('Upload Endpoint Error:', err.message);
    
    // في حال فشل الرفع الأولي، ننظف الملف هنا لأن الخلفية لن تعمل
    if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }
    
    // إذا لم نرد بعد، نرسل خطأ
    if (!res.headersSent) {
        res.status(500).json({ error: err.message });
    }
  }
}

// 2. جلب ملفات درس (كما هي)
async function getLessonFiles(req, res) {
    try {
        const { lessonId } = req.params;
        const userId = req.user?.id;

        if (!lessonId) return res.status(400).json({ error: 'Lesson ID required' });

        const sources = await sourceManager.getSourcesByLesson(userId, lessonId);
        res.status(200).json({ success: true, sources });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 3. حذف ملف (كما هي)
async function deleteFile(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;

        await sourceManager.deleteSource(userId, sourceId);
        res.status(200).json({ success: true, message: 'Deleted successfully' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 4. فحص حالة المعالجة (Poling Endpoint)
async function checkSourceStatus(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;

        const statusData = await sourceManager.getSourceStatus(userId, sourceId);

        if (!statusData) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        // نرسل الحالة
        res.status(200).json({ 
            success: true, 
            status: statusData.status, // processing | completed | failed
            error: statusData.error_message,
            // نرسل النص فقط إذا اكتمل، لكي يتمكن الفرونت من عرضه مباشرة
            data: statusData.status === 'completed' ? statusData.extracted_text : null
        });

    } catch (err) {
        logger.error('Check Status Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// --- Helper: دالة لتحميل الملف من الرابط وحفظه مؤقتاً ---
function downloadTempFile(url, fileName) {
    return new Promise((resolve, reject) => {
        const tempPath = path.join(os.tmpdir(), `retry-${Date.now()}-${fileName}`);
        const file = fs.createWriteStream(tempPath);

        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download file: Status ${response.statusCode}`));
            }
            response.pipe(file);
        }).on('error', (err) => {
            fs.unlink(tempPath, () => {}); // تنظيف عند الخطأ
            reject(err);
        });

        file.on('finish', () => {
            file.close(() => resolve(tempPath));
        });
    });
}

// 5. إعادة المحاولة (Retry Processing)
async function retryProcessing(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;

        // 1. جلب بيانات المصدر
        const { data: source } = await supabase
            .from('lesson_sources')
            .select('*')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .single();

        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // 2. التحقق مما إذا كان يستحق الإعادة (ليس مكتملاً بالفعل)
        // ملاحظة: نسمح بالإعادة إذا كان failed أو حتى processing (في حال علق)
        if (source.status === 'completed' && source.extracted_text) {
            return res.status(400).json({ error: 'Source is already processed successfully.' });
        }

        // 3. تحديث الحالة فوراً ليعرف المستخدم أننا بدأنا
        await supabase
            .from('lesson_sources')
            .update({ 
                status: 'processing', 
                error_message: null // مسح الخطأ القديم
            })
            .eq('id', sourceId);

        // 4. الرد على العميل
        res.status(202).json({ 
            success: true, 
            message: 'Retry initiated. Processing started in background.' 
        });

        // 5. العمل في الخلفية (Background Job)
        (async () => {
            try {
                // أ. جلب عنوان الدرس (لتحسين الـ AI)
                let lessonTitle = "University Topic";
                if (source.lesson_id) {
                    const { data: lData } = await supabase.from('lessons').select('title').eq('id', source.lesson_id).single();
                    if (lData) lessonTitle = lData.title;
                }

                // ب. تحميل الملف من Cloudinary إلى Temp
                logger.info(`🔄 [Retry] Downloading file for source ${sourceId}...`);
                const tempFilePath = await downloadTempFile(source.file_url, source.file_name || 'temp_file');

                // ج. استدعاء المعالج الموجود مسبقاً
                // (هذه الدالة موجودة في نفس الملف وتتكفل بحذف الملف المؤقت بعد الانتهاء)
                await processAIInBackground(
                    source.id, 
                    tempFilePath, 
                    source.file_type === 'image' ? 'image/jpeg' : 'application/pdf', // تخمين بسيط للنوع أو جلبه من الـ DB إذا كنت تخزنه
                    lessonTitle
                );

            } catch (bgErr) {
                logger.error(`❌ [Retry Failed] Source ${sourceId}:`, bgErr.message);
                // تسجيل الفشل مرة أخرى
                await supabase
                    .from('lesson_sources')
                    .update({ status: 'failed', error_message: bgErr.message })
                    .eq('id', sourceId);
            }
        })();

    } catch (err) {
        logger.error('Retry Endpoint Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// تأكد من تصدير الدالة في النهاية
module.exports = { 
    uploadFile, 
    getLessonFiles, 
    deleteFile, 
    checkSourceStatus, 
    retryProcessing // 👈 الإضافة الجديدة
};
