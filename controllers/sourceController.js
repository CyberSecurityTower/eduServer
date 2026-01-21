// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const fs = require('fs');

/**
 * 1. رفع ملف جديد (Endpoint Handler)
 */
async function uploadFile(req, res) {
  const userId = req.user?.id;
  const { lessonId, customName, description, lessonIds, subjectIds, folderId  } = req.body; 
  const file = req.file;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!file) return res.status(400).json({ error: 'No file provided' });

  try {
    // الرفع والحفظ (الحالة تكون completed فوراً من داخل sourceManager)
    const uploadResult = await sourceManager.uploadSource(
        userId, 
        lessonId || null, 
        file.path, 
        customName || file.originalname, 
        description || "", 
        file.mimetype,
        file.originalname,
        folderId || null
    );

    const sourceId = uploadResult.id;

    // الربط المتعدد بالدروس والمواد
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

    // حذف الملف المؤقت من السيرفر المحلي بعد الرفع لـ Cloudinary
    if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }

    res.status(200).json({ 
        success: true, 
        message: 'File uploaded successfully.',
        data: uploadResult 
    });

  } catch (err) {
    logger.error('Upload Error:', err.message);
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
}

/**
 * 2. جلب ملفات درس معين
 */
async function getLessonFiles(req, res) {
    try {
        const { lessonId } = req.params;
        const userId = req.user?.id;

        if (!lessonId) return res.status(400).json({ error: 'Lesson ID required' });

        const sources = await sourceManager.getSourcesByLesson(userId, lessonId);
        res.status(200).json({ success: true, sources: sources });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * 3. حذف ملف
 */
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



/**
 * 5. ربط مصدر موجود بدرس أو مادة
 */
async function linkSourceToContext(req, res) {
  const { sourceId, lessonIds, subjectIds } = req.body;
  const userId = req.user?.id;

  try {
    const { data: source } = await supabase
        .from('lesson_sources')
        .select('id')
        .eq('id', sourceId)
        .eq('user_id', userId)
        .single();

    if (!source) return res.status(403).json({ error: "Access denied" });

    if (lessonIds && Array.isArray(lessonIds)) {
        const lessonLinks = lessonIds.map(lId => ({ source_id: sourceId, lesson_id: lId }));
        await supabase.from('source_lessons').upsert(lessonLinks);
    }
    if (subjectIds && Array.isArray(subjectIds)) {
        const subjectLinks = subjectIds.map(sId => ({ source_id: sourceId, subject_id: sId }));
        await supabase.from('source_subjects').upsert(subjectLinks);
    }

    res.json({ success: true, message: 'Source linked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * 6. إحصائيات المكتبة (المرفوعة والمشتراة)
 */
async function getLibraryStats(req, res) {
    const userId = req.user?.id;
    try {
        const { data: uploads, error: uploadError } = await supabase
            .from('lesson_sources')
            .select('file_size')
            .eq('user_id', userId);

        if (uploadError) throw uploadError;

        const { data: purchases, error: purchaseError } = await supabase
            .from('user_inventory')
            .select(`item_id, store_items (file_size)`)
            .eq('user_id', userId);

        if (purchaseError) throw purchaseError;

        // حساب الحجم للملفات المرفوعة
        const uploadedCount = uploads.length;
        let totalUploadedBytes = 0;
        uploads.forEach(item => {
            // نستخدم Helper من الـ service مباشرة
            totalUploadedBytes += sourceManager.parseSizeToBytes(item.file_size || '0 Bytes');
        });

        // حساب الحجم للملفات المشتراة
        const purchasedCount = purchases.length;
        let totalPurchasedBytes = 0;
        purchases.forEach(item => {
            if (item.store_items && item.store_items.file_size) {
                totalPurchasedBytes += sourceManager.parseSizeToBytes(item.store_items.file_size);
            }
        });

        res.json({
            success: true,
            stats: {
                uploads: { 
                    count: uploadedCount, 
                    totalSize: sourceManager.formatBytes(totalUploadedBytes) 
                },
                purchases: { 
                    count: purchasedCount, 
                    totalSize: sourceManager.formatBytes(totalPurchasedBytes) 
                },
                grandTotalSize: sourceManager.formatBytes(totalUploadedBytes + totalPurchasedBytes)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * 7. فحص الحالة (Legacy Support)
 */
async function checkSourceStatus(req, res) {
    res.status(200).json({ 
        success: true, 
        status: 'completed', 
        message: 'Sources are processed instantly.' 
    });
}

/**
 * 🆕 دالة جديدة: نقل ملف إلى مجلد (Move File)
 */
async function moveFile(req, res) {
    const userId = req.user?.id;
    const { sourceId } = req.params;
    const { targetFolderId } = req.body; // null يعني نقل للـ Root

    try {
        const { data, error } = await supabase
            .from('lesson_sources')
            .update({ folder_id: targetFolderId })
            .eq('id', sourceId)
            .eq('user_id', userId) // حماية: المستخدم يملك الملف
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, message: 'File moved successfully', file: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * 🆕 تحديث: جلب المكتبة مع دعم التصفية بالمجلد
 */
async function getAllUserSources(req, res) {
    const userId = req.user?.id;
    const { folderId } = req.query; // query param

    try {
        let query = supabase
            .from('lesson_sources')
            .select(`*, source_lessons(lesson_id), source_subjects(subject_id)`)
            .eq('user_id', userId);

        // التصفية حسب المجلد
        if (folderId === 'root' || folderId === 'null') {
            query = query.is('folder_id', null);
        } else if (folderId) {
            query = query.eq('folder_id', folderId);
        }
        // إذا لم يتم إرسال folderId، نجلب الكل (السلوك القديم) أو حسب رغبتك

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, count: data.length, sources: data });
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
    linkSourceToContext,
    getLibraryStats,
    moveFile
};
