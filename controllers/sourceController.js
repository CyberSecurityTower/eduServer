
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
        folderId || null,
        file.size
        
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
 * 3. حذف ملف (Smart Delete)
 * يتعامل مع كل من الملفات المرفوعة وعناصر المخزون
 */
async function deleteFile(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;

        if (!sourceId) return res.status(400).json({ error: "Source ID is required" });

        // 🔍 الخطوة 1: التحقق هل هو ملف مرفوع (Upload)؟
        const { data: uploadItem } = await supabase
            .from('lesson_sources')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (uploadItem) {
            console.log(`🗑️ Deleting Upload: ${sourceId}`);
            await sourceManager.deleteSource(userId, sourceId);
            return res.status(200).json({ success: true, message: 'Upload deleted successfully' });
        }

        // 🔍 الخطوة 2: التحقق هل هو عنصر في المخزون (Inventory)؟
        const { data: inventoryItem } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (inventoryItem) {
            console.log(`🗑️ Removing Inventory Item: ${sourceId}`);
            await sourceManager.deleteInventoryItem(userId, sourceId);
            return res.status(200).json({ success: true, message: 'Item removed from inventory' });
        }

        // إذا لم يتم العثور عليه في الاثنين
        return res.status(404).json({ error: 'File not found or access denied' });

    } catch (err) {
        logger.error('❌ Delete Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}


/**
 * 5. [UPDATED] ربط مصدر (مزامنة: حذف القديم وإضافة الجديد)
 */
async function linkSourceToContext(req, res) {
  const { sourceId, lessonIds, subjectIds } = req.body;
  const userId = req.user?.id;

  try {
    // 1. التحقق من وجود المصدر وصلاحية المستخدم (نفس الكود القديم)
    let { data: uploadItem } = await supabase
        .from('lesson_sources')
        .select('id')
        .eq('id', sourceId)
        .eq('user_id', userId)
        .maybeSingle();

    let validSourceId = uploadItem ? uploadItem.id : null;
    
    if (!validSourceId) {
        const { data: inventoryItem } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();
            
        if (inventoryItem) validSourceId = inventoryItem.id;
    }

    if (!validSourceId) return res.status(403).json({ error: "File not found or access denied" });
  // 🔥 خطوة جديدة: فك الارتباط بالأب الأصلي (للملفات المرفوعة فقط)
    // هذا يجعل الملف يعتمد 100% على الروابط التي سنضيفها في الأسفل
    if (uploadItem) {
        await supabase
            .from('lesson_sources')
            .update({ lesson_id: null, subject_id: null })
            .eq('id', validSourceId);
    }
    // =========================================================
    // 🔥 التعديل يبدأ من هنا (Logic Change) 🔥
    // =========================================================

    // 2. تنظيف الروابط القديمة (Delete Old Links)
    // نحذف كل شيء يخص هذا الملف لنعيد بناء الروابط بناءً على القائمة الجديدة
    const deletePromises = [
        supabase.from('source_lessons').delete().eq('source_id', validSourceId),
        supabase.from('source_subjects').delete().eq('source_id', validSourceId)
    ];
    await Promise.all(deletePromises);

    const insertPromises = [];

    // 3. إضافة الروابط الجديدة (Insert New Selected Links)
    if (lessonIds && Array.isArray(lessonIds) && lessonIds.length > 0) {
        const lessonLinks = lessonIds.map(lId => ({ 
            source_id: validSourceId, 
            lesson_id: lId 
        }));
        // نستخدم insert بدلاً من upsert لأننا نظفنا الجدول مسبقاً
        insertPromises.push(supabase.from('source_lessons').insert(lessonLinks));
    }

    if (subjectIds && Array.isArray(subjectIds) && subjectIds.length > 0) {
        const subjectLinks = subjectIds.map(sId => ({ 
            source_id: validSourceId, 
            subject_id: sId 
        }));
        insertPromises.push(supabase.from('source_subjects').insert(subjectLinks));
    }

    if (insertPromises.length > 0) await Promise.all(insertPromises);

    res.json({ success: true, message: 'Links updated successfully' });

  } catch (err) {
    logger.error('Linking Error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * 6. إحصائيات المكتبة (المرفوعة والمشتراة)
 * [Backend-Only Fix] حساب الحجم برمجياً وتعويض القيم المفقودة
 */
async function getLibraryStats(req, res) {
    const userId = req.user?.id;
    try {
        // 1. جلب المرفوعات
        const { data: uploads, error: uploadError } = await supabase
            .from('lesson_sources')
            .select('file_size')
            .eq('user_id', userId);

        if (uploadError) throw uploadError;

        // 2. جلب المشتريات
        const { data: purchases, error: purchaseError } = await supabase
            .from('user_inventory')
            .select(`
                store_items (file_size)
            `)
            .eq('user_id', userId);

        if (purchaseError) throw purchaseError;

        // === المنطق الجديد: الحساب والترقيع داخل الباك إند ===
        
        // أحجام افتراضية بالبايت (5MB و 10MB)
        const DEFAULT_UPLOAD_SIZE = 5 * 1024 * 1024;
        const DEFAULT_STORE_SIZE = 10 * 1024 * 1024;

        let totalUploadedBytes = 0;
        
        uploads.forEach(item => {
            // تحويل القيمة لرقم
            let size = Number(item.file_size);
            // إذا كان الحجم 0 أو غير موجود، نستخدم الحجم الافتراضي (الترقيع)
            if (!size || isNaN(size) || size === 0) {
                size = DEFAULT_UPLOAD_SIZE;
            }
            totalUploadedBytes += size;
        });

        let totalPurchasedBytes = 0;
        
        purchases.forEach(item => {
            if (item.store_items) {
                let size = Number(item.store_items.file_size);
                // نفس المنطق: إذا 0 نستخدم الافتراضي
                if (!size || isNaN(size) || size === 0) {
                    size = DEFAULT_STORE_SIZE;
                }
                totalPurchasedBytes += size;
            }
        });

        // دالة التنسيق
        const formatBytes = (bytes, decimals = 2) => {
            if (!+bytes) return '0 B';
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
        };

        res.json({
            success: true,
            stats: {
                uploads: { 
                    count: uploads.length, 
                    totalSize: formatBytes(totalUploadedBytes)
                },
                purchases: { 
                    count: purchases.length, 
                    totalSize: formatBytes(totalPurchasedBytes)
                },
                // هذا هو الرقم الذي سيظهر في التطبيق
                grandTotalSize: formatBytes(totalUploadedBytes + totalPurchasedBytes)
            }
        });
    } catch (err) {
        console.error("Library Stats Error:", err);
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

    console.log(`🚀 [SmartMove] Request: ID=${sourceId} -> Target=${targetFolderId}`);

    try {
        // 1. تحديد نوع الملف (مرفوع أم مشترى)
        let fileType = null;
        let realSourceId = null;

        // فحص المرفوعات
        const { data: uploadData } = await supabase
            .from('lesson_sources')
            .select('id')
            .eq('id', sourceId)
            .eq('user_id', userId)
            .maybeSingle();
        
        if (uploadData) {
            fileType = 'upload';
            realSourceId = uploadData.id;
        } else {
            // فحص المشتريات
            const { data: invData } = await supabase
                .from('user_inventory')
                .select('id')
                .eq('id', sourceId) // أو item_id حسب ما يرسله الفرونت
                .eq('user_id', userId)
                .maybeSingle();
            
            if (invData) {
                fileType = 'inventory';
                realSourceId = invData.id;
            }
        }

        if (!fileType) {
            return res.status(404).json({ error: 'File not found or access denied' });
        }

        // 2. تنظيف الهدف
        if (!targetFolderId || targetFolderId === 'root' || targetFolderId === 'null') {
            // النقل إلى الروت (إزالة المجلد)
            const table = fileType === 'upload' ? 'lesson_sources' : 'user_inventory';
            await supabase.from(table).update({ folder_id: null }).eq('id', realSourceId);
            return res.json({ success: true, message: 'Moved to root' });
        }

        // 3. 🧠 المنطق الذكي: ما هو الهدف؟

        // أ) هل هو مجلد حقيقي؟ (Folders)
        const { data: isFolder } = await supabase
            .from('folders')
            .select('id')
            .eq('id', targetFolderId)
            .maybeSingle();

        if (isFolder) {
            // ✅ نعم، هو مجلد -> قم بالنقل الفيزيائي
            console.log('📂 Target is a Folder. Moving...');
            const table = fileType === 'upload' ? 'lesson_sources' : 'user_inventory';
            
            const { error } = await supabase
                .from(table)
                .update({ folder_id: targetFolderId })
                .eq('id', realSourceId);

            if (error) throw error;
            return res.json({ success: true, message: 'Moved to folder' });
        }

        // ب) هل هو مادة؟ (Subjects)
        const { data: isSubject } = await supabase
            .from('subjects')
            .select('id')
            .eq('id', targetFolderId)
            .maybeSingle();

        if (isSubject) {
            // 🔗 نعم، هو مادة -> قم بالربط (Link)
            console.log('📘 Target is a Subject. Linking...');
            
            const { error } = await supabase
                .from('source_subjects')
                .upsert(
                    { source_id: realSourceId, subject_id: targetFolderId },
                    { onConflict: 'source_id, subject_id' }
                );

            if (error) throw error;
            return res.json({ success: true, message: 'Linked to Subject successfully' });
        }

        // ج) هل هو درس؟ (Lessons)
        const { data: isLesson } = await supabase
            .from('lessons')
            .select('id')
            .eq('id', targetFolderId)
            .maybeSingle();

        if (isLesson) {
            // 🎥 نعم، هو درس -> قم بالربط (Link)
            console.log('📝 Target is a Lesson. Linking...');
            
            const { error } = await supabase
                .from('source_lessons')
                .upsert(
                    { source_id: realSourceId, lesson_id: targetFolderId },
                    { onConflict: 'source_id, lesson_id' }
                );

            if (error) throw error;
            return res.json({ success: true, message: 'Linked to Lesson successfully' });
        }

        // د) الهدف غير معروف
        console.warn(`⚠️ Target ID ${targetFolderId} is unknown (Not folder, subject, or lesson).`);
        return res.status(400).json({ error: "Invalid target. Cannot move or link." });

    } catch (err) {
        logger.error('Smart Move Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}


/**
 * [FIXED] جلب المكتبة الموحدة مع دمج الروابط يدوياً
 * لتجنب خطأ: Could not find a relationship
 */

async function getAllUserSources(req, res) {
    const userId = req.user?.id;

    try {
        // 1. جلب المرفوعات
        // 🔥 التعديل 1: إضافة lesson_id و subject_id إلى جملة الاستعلام (Select)
        const uploadsQuery = supabase
            .from('lesson_sources')
            .select(`id, file_name, file_type, file_url, file_size, created_at, folder_id, lesson_id, subject_id, thumbnail_url, preview_images`) 
            .eq('user_id', userId);

        // 2. جلب المشتريات
         const purchasesQuery = supabase
            .from('user_inventory')
            .select(`
                id, 
                folder_id, 
                created_at:purchased_at, 
                store_items (
                    id, 
                    title, 
                    file_url, 
                    file_size, 
                    type, 
                    thumbnail_url,   
                    preview_images   
                )
            `)
            .eq('user_id', userId);

        const [uploadsRes, purchasesRes] = await Promise.all([uploadsQuery, purchasesQuery]);
        if (uploadsRes.error) throw uploadsRes.error;
        if (purchasesRes.error) throw purchasesRes.error;

        // دالة تحويل الحجم العادية
        const formatBytes = (bytes, decimals = 2) => {
            if (!+bytes) return '0 B';
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
        };

        const uploadIds = (uploadsRes.data || []).map(i => i.id);
        const purchaseIds = (purchasesRes.data || []).map(i => i.id);
        const allSourceIds = [...uploadIds, ...purchaseIds];

        // جلب الروابط من الجداول الوسيطة
         let lessonLinks = [], subjectLinks = [];
        if (allSourceIds.length > 0) {
            const { data: lData } = await supabase.from('source_lessons').select('source_id, lesson_id').in('source_id', allSourceIds);
            lessonLinks = lData || [];
            const { data: sData } = await supabase.from('source_subjects').select('source_id, subject_id').in('source_id', allSourceIds);
            subjectLinks = sData || [];
        }

        const getLinkedIds = (sourceId, linksArray, key) => linksArray.filter(link => link.source_id === sourceId).map(link => link[key]);

        // 🔥 التعديل 2: دالة مساعدة لدمج الرابط الأصلي مع الروابط الإضافية بدون تكرار
        const mergeIds = (originId, linkedIds) => {
            const set = new Set(linkedIds);
            if (originId) set.add(originId);
            return Array.from(set);
        };

        const normalizedUploads = (uploadsRes.data || []).map(u => ({
            id: u.id,
            title: u.file_name,
            type: u.file_type || 'file',
            file_url: u.file_url,
            thumbnail_url: u.thumbnail_url || null,
            preview_images: u.preview_images || [],
            file_size: formatBytes(u.file_size),
            created_at: u.created_at,
            folder_id: u.folder_id,
            // 🔥 هنا يتم الدمج: الأصلي (u.subject_id) + المربوط
            subject_ids: mergeIds(u.subject_id, getLinkedIds(u.id, subjectLinks, 'subject_id')),
            // 🔥 هنا يتم الدمج: الأصلي (u.lesson_id) + المربوط
            lesson_ids: mergeIds(u.lesson_id, getLinkedIds(u.id, lessonLinks, 'lesson_id')), 
            is_upload: true,
            is_inventory: false
        }));

        const normalizedPurchases = (purchasesRes.data || []).map(p => ({
            id: p.id,
            item_id: p.store_items?.id,
            title: p.store_items?.title || 'Purchased Item',
            type: mapStoreTypeToMime(p.store_items?.type),
            file_url: p.store_items?.file_url,
            thumbnail_url: p.store_items?.thumbnail_url || null,
            preview_images: p.store_items?.preview_images || [], 
            file_size: formatBytes(p.store_items?.file_size), 
            created_at: p.created_at,
            folder_id: p.folder_id,
            subject_ids: getLinkedIds(p.id, subjectLinks, 'subject_id'), // المشتريات ليس لها أصل، فقط روابط
            lesson_ids: getLinkedIds(p.id, lessonLinks, 'lesson_id'),
            is_upload: false,
            is_inventory: true
        }));

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
/**
 * 🆕 تعديل اسم الملف (Rename File)
 */
async function renameFile(req, res) {
    const userId = req.user?.id;
    const { sourceId } = req.params;
    const { newName } = req.body;

    if (!newName || typeof newName !== 'string' || !newName.trim()) {
        return res.status(400).json({ error: 'New name is required' });
    }

    try {
        // 1. محاولة التحديث في المرفوعات (Uploads)
        const { data: upload, error: uploadError } = await supabase
            .from('lesson_sources')
            .update({ file_name: newName.trim() }) // نفترض أن العمود هو file_name
            .eq('id', sourceId)
            .eq('user_id', userId)
            .select()
            .single();

        if (upload) {
            return res.json({ success: true, message: 'File renamed successfully', file: upload });
        }

        // 2. إذا لم يكن في المرفوعات، نتحقق من المشتريات (Inventory)
        // ملاحظة: المشتريات غالباً لا نغير اسمها الأصلي إلا إذا كان لديك عمود custom_name
        // سنكتفي بإرجاع خطأ إذا لم يكن ملفاً مرفوعاً
        return res.status(404).json({ error: 'File not found or cannot be renamed (Only uploads can be renamed)' });

    } catch (err) {
        logger.error('Rename Error:', err.message);
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
    moveFile,
    renameFile 
};
