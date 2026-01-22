'use strict';

const supabase = require('../../services/data/supabase');
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
    /**
     * رفع ملف جديد
     * ✅ تم إضافة معامل fileSize لضمان تسجيل الحجم الصحيح القادم من Multer
     */
    async uploadSource(userId, lessonId, filePath, displayName, description, mimeType, originalFileName, folderId = null, fileSize = 0) {
        try {
            logger.info(`📤 Uploading source [${displayName}]...`);

            // 1. تحديد الحجم النهائي (الأولوية للحجم القادم من Controller)
            let finalFileSize = fileSize;

            // إذا لم يتم تمرير الحجم، نحاول حسابه من الملف
            if (!finalFileSize || finalFileSize === 0) {
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    finalFileSize = stats.size;
                }
            }

            // تحديد نوع الموارد لـ Cloudinary
            let resourceType = 'raw';
            if (mimeType.startsWith('image/')) resourceType = 'image';
            else if (mimeType.startsWith('video/')) resourceType = 'video';
            
            // الرفع إلى Cloudinary
            const uploadResult = await cloudinary.uploader.upload(filePath, {
                folder: 'eduapp_sources',
                resource_type: resourceType,
                use_filename: true,
                public_id: `user_${userId}_${Date.now()}`,
                type: 'upload',
                access_mode: 'public'
            });

            // محاولة أخيرة للحصول على الحجم من Cloudinary إذا فشل كل ما سبق
            if ((!finalFileSize || finalFileSize === 0) && uploadResult.bytes) {
                finalFileSize = uploadResult.bytes;
            }

            const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

            // توليد رابط الصورة المصغرة (Thumbnail Logic)
            let thumbnailUrl = null;
            if (resourceType === 'image') {
                thumbnailUrl = uploadResult.secure_url;
            } else if (resourceType === 'video') {
                thumbnailUrl = uploadResult.secure_url.replace(/\.[^/.]+$/, ".jpg");
            } 
            // للـ PDF نتركه null ليظهر الرمز الافتراضي في التطبيق

            // 2. التحضير للإدخال
            const insertData = {
                user_id: userId,
                lesson_id: lessonId || null,
                folder_id: folderId || null,
                file_url: uploadResult.secure_url,
                thumbnail_url: thumbnailUrl,
                file_type: simpleType,
                file_name: displayName,
                description: description,
                original_file_name: originalFileName,
                public_id: uploadResult.public_id,
                file_size: finalFileSize, // ✅ حفظ الحجم الصحيح هنا
                processed: true,
                status: 'completed'
            };

            const { data, error } = await supabase
                .from('lesson_sources')
                .insert(insertData)
                .select()
                .single();

            if (error) throw error;
            return data;

        } catch (err) {
            logger.error('❌ Source Upload Failed:', err.message);
            // تنظيف الملف المؤقت في حال الخطأ
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw err;
        }
    }

    async getSourcesByLesson(userId, lessonId) {
        const { data, error } = await supabase
            .from('lesson_sources')
            .select('*')
            .eq('lesson_id', lessonId)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Get Sources Error:', error.message);
            return [];
        }
        return data;
    }

     /**
     * 🛠️ دالة مساعدة خاصة لحذف العلاقات المشتركة
     * تحذف الروابط من جداول الدروس والمواد بغض النظر عن نوع الملف
     */
    async _cleanUpRelations(sourceId) {
        try {
            // حذف الروابط مع الدروس
            await supabase.from('source_lessons').delete().eq('source_id', sourceId);
            // حذف الروابط مع المواد
            await supabase.from('source_subjects').delete().eq('source_id', sourceId);
        } catch (error) {
            logger.error(`⚠️ Failed to clean relations for ${sourceId}:`, error);
            // لا نرمي الخطأ هنا لنسمح باستمرار عملية الحذف الرئيسية
        }
    }

    /**
     * ✅ حذف ملف مرفوع (Upload)
     * 1. حذف العلاقات
     * 2. حذف من Cloudinary
     * 3. حذف من قاعدة البيانات
     */
    async deleteSource(userId, sourceId) {
        // 1. تنظيف العلاقات أولاً
        await this._cleanUpRelations(sourceId);

        // 2. جلب public_id لحذف الملف من Cloudinary
        try {
            const { data } = await supabase
                .from('lesson_sources')
                .select('public_id')
                .eq('id', sourceId)
                .eq('user_id', userId)
                .single();

            if (data?.public_id) {
                await cloudinary.uploader.destroy(data.public_id);
            }
        } catch (e) {
            console.warn("⚠️ Cloudinary delete skipped/failed", e.message);
        }

        // 3. الحذف النهائي من الجدول
        const { error } = await supabase
            .from('lesson_sources')
            .delete()
            .eq('id', sourceId)
            .eq('user_id', userId);

        if (error) throw error;
        return true;
    }
/**
     * ✅ حذف عنصر من المخزون (Inventory Item)
     * 1. حذف العلاقات (مهم جداً لأن العنصر قد يكون مربوطاً بدروس)
     * 2. حذف من جدول مخزون المستخدم
     * (ملاحظة: لا نحذف الملف الأصلي من store_items لأنه ملك للنظام)
     */
    async deleteInventoryItem(userId, itemId) {
        // 1. تنظيف العلاقات
        await this._cleanUpRelations(itemId);

        // 2. إزالة العنصر من حقيبة المستخدم
        const { error } = await supabase
            .from('user_inventory')
            .delete()
            .eq('id', itemId) // تأكد أننا نحذف سجل المخزون وليس الآيتم نفسه
            .eq('user_id', userId);

        if (error) throw error;
        return true;
    }
}
// --- الدوال المساعدة (Exports) ---

// دالة لتنسيق الحجم للعرض (Human Readable)
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// دالة لتحويل النص إلى بايت (للاستخدام عند الحاجة)
function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== 'string') return 0;
    const units = { 'bytes': 1, 'kb': 1024, 'mb': 1024 * 1024, 'gb': 1024 * 1024 * 1024 };
    const match = sizeStr.toLowerCase().match(/([\d.]+)\s*(bytes|kb|mb|gb)/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    return value * (units[unit] || 1);
}

const managerInstance = new SourceManager();

module.exports = managerInstance; 
module.exports.formatBytes = formatBytes;
module.exports.parseSizeToBytes = parseSizeToBytes;
