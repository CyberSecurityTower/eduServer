// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const fs = require('fs');
const https = require('https'); 
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises'); 

// 1. دالة الرفع (Endpoint Handler)

async function uploadFile(req, res) {
  const userId = req.user?.id;
  const { lessonId, customName, description, lessonIds, subjectIds } = req.body; 
  const file = req.file;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!file) return res.status(400).json({ error: 'No file provided' });

  try {
    // 1. الرفع والحفظ في قاعدة البيانات
    // ملاحظة: سيتم تعيين الحالة completed فوراً داخل sourceManager
    const uploadResult = await sourceManager.uploadSource(
        userId, 
        lessonId || null, 
        file.path, 
        customName || file.originalname, 
        description || "", // ✅ تمرير الوصف
        file.mimetype,
        file.originalname
    );

    const sourceId = uploadResult.id;

    // 2. الربط المتعدد (Multi-Linking)
    const linkPromises = [];
    if (lessonIds) {
        const lIds = Array.isArray(lessonIds) ? lessonIds : JSON.parse(lessonIds);
        const lessonLinks = lIds.map(lId => ({ source_id: sourceId, lesson_id: lId }));
        linkPromises.push(supabase.from('source_lessons').insert(lessonLinks));
    }
    if (subjectIds) {
        const sIds = Array.isArray(subjectIds) ? subjectIds : JSON.parse(subjectIds);
        const subjectLinks = sIds.map(sId => ({ source_id: sourceId, subject_id: sId }));
        linkPromises.push(supabase.from('source_subjects').insert(subjectLinks));
    }
    if (linkPromises.length > 0) await Promise.all(linkPromises);

    // 3. حذف الملف المؤقت من السيرفر
    if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }

    // 4. الرد الفوري (تم الانتهاء!)
    res.status(200).json({ 
        success: true, 
        message: 'File uploaded successfully.',
        data: uploadResult // ✅ إرجاع البيانات كاملة
    });

  } catch (err) {
    logger.error('Upload Error:', err.message);
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
}
// 2. جلب ملفات درس (كما هي)

async function getLessonFiles(req, res) {
    try {
        const { lessonId } = req.params;
        const userId = req.user?.id;

        if (!lessonId) return res.status(400).json({ error: 'Lesson ID required' });

        // البيانات القادمة هنا ستحتوي على extracted_text و status بفضل التعديل السابق
        const sources = await sourceManager.getSourcesByLesson(userId, lessonId);
        
        // نرسل المصفوفة كاملة
        res.status(200).json({ 
            success: true, 
            sources: sources 
        });

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
async function downloadTempFile(url, fileName) {
    const tempPath = path.join(os.tmpdir(), `retry-${Date.now()}-${fileName}`);
    
    try {
        // نستخدم fetch بدلاً من https لأنه يدعم الـ Redirects تلقائياً
        const response = await fetch(url);
        
        if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
        
        // حفظ الملف باستخدام Stream Pipeline (أسرع وأكثر أماناً للذاكرة)
        const fileStream = fs.createWriteStream(tempPath);
        
        // @ts-ignore (Node 20 supports ReadableStream here)
        await pipeline(response.body, fileStream);
        
        return tempPath;
    } catch (err) {
        // تنظيف إذا فشل التحميل
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw err;
    }
}



/**
 * 🔓 دالة النظام لإعادة المحاولة (System Internal Retry)
 * تستخدم من قبل الـ Worker لاستكمال العمليات العالقة
 */
// controllers/sourceController.js

async function triggerSystemRetry(sourceId) {
    try {
        // 1. جلب بيانات المصدر مع عداد المحاولات
        const { data: source } = await supabase
            .from('lesson_sources')
            .select('*')
            .eq('id', sourceId)
            .single();

        if (!source) return false;

        // 🛑 2. فحص قاطع الدائرة (Circuit Breaker)
        if ((source.retry_count || 0) >= MAX_AUTO_RETRIES) {
            logger.error(`💀 [System Retry] Source ${sourceId} is DEAD. Max retries (${MAX_AUTO_RETRIES}) exceeded.`);
            
            // نوسمها كـ "ميتة" لكي لا يلتقطها الـ Worker مجدداً
            await supabase
                .from('lesson_sources')
                .update({ 
                    status: 'failed_permanently', // حالة جديدة نهائية
                    error_message: 'System gave up: Max auto-retries exceeded.' 
                })
                .eq('id', sourceId);
            
            return false; // ننسحب
        }

        logger.info(`🤖 [System Retry] Attempt ${(source.retry_count || 0) + 1}/${MAX_AUTO_RETRIES} for source: ${sourceId}`);

        // 3. تحديث الحالة + زيادة العداد
        await supabase
            .from('lesson_sources')
            .update({ 
                status: 'processing', 
                retry_count: (source.retry_count || 0) + 1, // زيادة العداد
                error_message: null 
            })
            .eq('id', sourceId);

        // 4. تنفيذ العمل (نفس الكود السابق)
        let lessonTitle = "University Topic";
        if (source.lesson_id) {
            const { data: lData } = await supabase.from('lessons').select('title').eq('id', source.lesson_id).single();
            if (lData) lessonTitle = lData.title;
        }

        const tempFilePath = await downloadTempFile(source.file_url, source.file_name || 'recovered_file');
        
        await processAIInBackground(
            source.id, 
            tempFilePath, 
            source.file_type === 'image' ? 'image/jpeg' : 'application/pdf', 
            lessonTitle
        );

        return true;

    } catch (err) {
        // لا نحتاج لتحديث الحالة هنا لأن processAIInBackground تقوم بذلك، 
        // لكن العداد قد زاد بالفعل في الخطوة 3، وهذا جيد.
        logger.error(`❌ [System Retry Failed] Source ${sourceId}:`, err.message);
        return false;
    }
}

// ✅ دالة جديدة: جلب كل المصادر الخاصة بالمستخدم (الأرشيف الشخصي)
// ✅ نسخة محدثة من getAllUserSources مع سجلات كونسول تفصيلية
async function getAllUserSources(req, res) {
    const userId = req.user?.id;
    
    console.log('--------------------------------------------------');
    console.log(`📂 [Library Access] Request received from User: ${userId}`);
    console.log('⏳ [Library Access] Fetching sources and links from Supabase...');

    try {
        const { data, error } = await supabase
            .from('lesson_sources')
            .select(`
                *,
                source_lessons(lesson_id),
                source_subjects(subject_id)
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ [Library Access] Database Error:', error.message);
            throw error;
        }

        // طباعة ملخص للبيانات المستلمة
        console.log(`✅ [Library Access] Successfully retrieved ${data?.length || 0} sources.`);
        
        if (data && data.length > 0) {
            console.log('📊 [Library Sample] First Item Context:');
            console.log(`   - ID: ${data[0].id}`);
            console.log(`   - Linked Lessons: ${JSON.stringify(data[0].source_lessons)}`);
            console.log(`   - Linked Subjects: ${JSON.stringify(data[0].source_subjects)}`);
        } else {
            console.log('ℹ️ [Library Access] User library is empty.');
        }

        console.log('--------------------------------------------------');

        res.json({ 
            success: true, 
            count: data.length,
            sources: data 
        });

    } catch (err) {
        console.error('🔥 [Library Access] Fatal Controller Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}
// 1. ربط ملف (Source) بمواد أو دروس متعددة
async function linkSourceToContext(req, res) {
  const { sourceId, lessonIds, subjectIds } = req.body; // مصفوفات IDs
  const userId = req.user?.id;

  try {
    // التأكد أولاً أن المستخدم يملك هذا الملف
    const { data: source } = await supabase
        .from('lesson_sources')
        .select('id')
        .eq('id', sourceId)
        .eq('user_id', userId)
        .single();

    if (!source) return res.status(403).json({ error: "Source not found or access denied" });

    // ربط بالدروس (Many-to-Many)
    if (lessonIds && Array.isArray(lessonIds)) {
        const lessonLinks = lessonIds.map(lId => ({ source_id: sourceId, lesson_id: lId }));
        await supabase.from('source_lessons').upsert(lessonLinks);
    }

    // ربط بالمواد
    if (subjectIds && Array.isArray(subjectIds)) {
        const subjectLinks = subjectIds.map(sId => ({ source_id: sourceId, subject_id: sId }));
        await supabase.from('source_subjects').upsert(subjectLinks);
    }

    res.json({ success: true, message: 'Source linked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 2. جلب جميع المصادر التي رفعها المستخدم مع تفاصيل الربط
async function getAllUserSources(req, res) {
    const userId = req.user?.id;
    try {
        const { data, error } = await supabase
            .from('lesson_sources')
            .select(`
                *,
                source_lessons(lesson_id),
                source_subjects(subject_id)
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, sources: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
module.exports = { 
    uploadFile, 
    getLessonFiles, 
    getAllUserSources,
    deleteFile, 
    checkSourceStatus, 
    triggerSystemRetry,
    getAllUserSources,
    linkSourceToContext
};
