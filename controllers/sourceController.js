// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const fs = require('fs');
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
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
    const { targetFolderId } = req.body;

    console.log(`🚀 [MoveFile] Request: ID=${sourceId} -> Folder=${targetFolderId} | User=${userId}`);

    try {
        // 1. تنظيف معرف المجلد الهدف
        let finalFolderId = targetFolderId;
        if (!targetFolderId || targetFolderId === 'root' || targetFolderId === 'null') {
            finalFolderId = null;
        }

        // ====================================================
        // PHASE 1: البحث في المرفوعات (Lesson Sources)
        // ====================================================
        const { data: uploadExists, error: findUploadError } = await supabase
            .from('lesson_sources')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (uploadExists) {
            console.log(`✅ Found in Uploads. Moving...`);
            const { error: moveError } = await supabase
                .from('lesson_sources')
                .update({ folder_id: finalFolderId })
                .eq('id', sourceId);

            if (moveError) throw moveError;
            return res.json({ success: true, message: 'Upload moved successfully', type: 'upload' });
        }

        // ====================================================
        // PHASE 2: البحث في المشتريات (Inventory) - الطريقة المباشرة
        // ====================================================
        // البحث باستخدام ID السجل (Row ID) وهو ما يرسله الفرونت اند عادةً
        const { data: inventoryRow, error: findInvError } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (inventoryRow) {
            console.log(`✅ Found in Inventory (Row ID). Moving...`);
            const { error: moveError } = await supabase
                .from('user_inventory')
                .update({ folder_id: finalFolderId })
                .eq('id', sourceId);

            if (moveError) throw moveError;
            return res.json({ success: true, message: 'Purchase moved successfully', type: 'purchase' });
        }

        // ====================================================
        // PHASE 3: البحث في المشتريات - الطريقة البديلة (Product ID)
        // ====================================================
        // في حال أرسل الفرونت اند ID المنتج بدلاً من ID السجل بالخطأ
        const { data: inventoryByItem, error: findItemError } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('item_id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (inventoryByItem) {
            console.log(`✅ Found in Inventory (Product ID). Moving...`);
            const { error: moveError } = await supabase
                .from('user_inventory')
                .update({ folder_id: finalFolderId })
                .eq('id', inventoryByItem.id); // نستخدم الـ ID الحقيقي للتحديث

            if (moveError) throw moveError;
            return res.json({ success: true, message: 'Purchase moved successfully', type: 'purchase' });
        }

        // ====================================================
        // END: لم يتم العثور على الملف
        // ====================================================
        console.error(`❌ [MoveFile] File ${sourceId} not found anywhere for user ${userId}`);
        return res.status(404).json({ error: 'File not found or access denied (Check logs)' });

    } catch (err) {
        logger.error('Move Error:', err.message);
        console.error("Full Error Details:", err);
        res.status(500).json({ error: err.message });
    }
}


/**
 * 🔄 تحديث: جلب المكتبة الموحدة (Unified Library Fetch)
 * تجلب المرفوعات + المشتريات وتصفيها حسب المجلد
 */
async function getAllUserSources(req, res) {
    const userId = req.user?.id;

    try {
        // 1. المرفوعات (Uploads)
        // ✅ التغيير هنا: أضفنا source_subjects(subject_id)
        const uploadsQuery = supabase
            .from('lesson_sources')
            .select(`
                id, file_name, file_type, file_url, file_size, created_at, folder_id, thumbnail_url, is_upload,
                source_subjects (subject_id)
            `) 
            .eq('user_id', userId);

        // 2. المشتريات (Purchases)
        const purchasesQuery = supabase
            .from('user_inventory')
            .select(`
                id, 
                folder_id, 
                created_at:purchased_at, 
                store_items (id, title, file_url, file_size, type, thumbnail)
            `)
            .eq('user_id', userId);

        const [uploadsRes, purchasesRes] = await Promise.all([uploadsQuery, purchasesQuery]);

        if (uploadsRes.error) throw uploadsRes.error;
        if (purchasesRes.error) throw purchasesRes.error;

        // --- معالجة المرفوعات ---
        const normalizedUploads = (uploadsRes.data || []).map(u => {
            const rawSize = u.file_size || 0;
            // ✅ استخراج مصفوفة IDs للمواد
            const linkedSubjectIds = u.source_subjects 
                ? u.source_subjects.map(rel => rel.subject_id) 
                : [];

            return {
                id: u.id,
                title: u.file_name,
                type: u.file_type || 'file',
                file_url: u.file_url,
                thumbnail_url: u.thumbnail_url || null,
                file_size: formatBytes(rawSize),
                created_at: u.created_at,
                folder_id: u.folder_id,
                
                // ✅ الحقل الجديد المهم جداً للفلترة الذكية
                subject_ids: linkedSubjectIds, 
                
                is_upload: true, 
                is_inventory: false
            };
        });

        // --- معالجة المشتريات ---
        const normalizedPurchases = (purchasesRes.data || []).map(p => {
            const rawSize = p.store_items?.file_size || 0;
            return {
                id: p.id,
                item_id: p.store_items?.id,
                title: p.store_items?.title || 'Purchased Item',
                type: mapStoreTypeToMime(p.store_items?.type),
                file_url: p.store_items?.file_url,
                thumbnail_url: p.store_items?.thumbnail || null,
                file_size: formatBytes(rawSize), 
                created_at: p.created_at,
                folder_id: p.folder_id,
                
                // المشتريات حالياً لا ترتبط بمواد عبر هذا الجدول (يمكن إضافتها لاحقاً إذا كان المتجر يدعمها)
                subject_ids: [], 
                
                is_upload: false,
                is_inventory: true
            };
        });

        const allFiles = [...normalizedUploads, ...normalizedPurchases];
        allFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ success: true, count: allFiles.length, sources: allFiles });

    } catch (err) {
        logger.error('Get Library Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// دالة مساعدة بسيطة لتوحيد الأنواع
function mapStoreTypeToMime(storeType) {
    if (!storeType) return 'document';
    if (storeType.includes('pdf')) return 'document';
    if (storeType.includes('image')) return 'image';
    if (storeType.includes('video')) return 'video';
    return 'document';
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
