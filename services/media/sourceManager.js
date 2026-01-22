'use strict';

const supabase = require('../../services/data/supabase');
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
    // الدالة تقبل الآن folderId كما في التعديل السابق
    async uploadSource(userId, lessonId, filePath, displayName, description, mimeType, originalFileName, folderId = null) {
        try {
            logger.info(`📤 Uploading source [${displayName}]...`);

            // 1. حساب الحجم
            let fileSizeInBytes = 0;
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                fileSizeInBytes = stats.size;
            }

            // تحديد نوع الموارد
            let resourceType = 'raw';
            if (mimeType.startsWith('image/')) resourceType = 'image';
            else if (mimeType.startsWith('video/')) resourceType = 'video';
            // PDF يعامل كـ image في Cloudinary لتوليد Thumbnails أحياناً، أو raw.
            // للأمان سنبقيه كما هو، ولكن سنولد Thumbnail يدوياً

            const uploadResult = await cloudinary.uploader.upload(filePath, {
                folder: 'eduapp_sources',
                resource_type: resourceType,
                use_filename: true,
                public_id: `user_${userId}_${Date.now()}`,
                type: 'upload',
                access_mode: 'public'
            });

            if (fileSizeInBytes === 0 && uploadResult.bytes) {
                fileSizeInBytes = uploadResult.bytes;
            }

            const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

            // ✅ توليد رابط الصورة المصغرة (Thumbnail Logic)
            let thumbnailUrl = null;
            if (resourceType === 'image') {
                // للصور: نفس الرابط
                thumbnailUrl = uploadResult.secure_url;
            } else if (resourceType === 'video') {
                // للفيديو: استبدال الامتداد بـ .jpg
                thumbnailUrl = uploadResult.secure_url.replace(/\.[^/.]+$/, ".jpg");
            } else if (mimeType.includes('pdf')) {
                // للـ PDF: إذا تم رفعه كـ image، يمكن عرض الصفحة الأولى. 
                // إذا كان raw، لن يكون له thumbnail تلقائي من Cloudinary إلا بإعدادات خاصة.
                // سنتركه null وسيظهر الـ Placeholder في التطبيق.
                thumbnailUrl = null; 
            }

            // 2. التحضير للإدخال (مع العمود الجديد thumbnail_url)
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
                file_size: fileSizeInBytes,
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

    async deleteSource(userId, sourceId) {
        const { data: source } = await supabase
            .from('lesson_sources')
            .select('public_id, user_id')
            .eq('id', sourceId)
            .single();

        if (!source) throw new Error('Source not found');
        if (source.user_id !== userId) throw new Error('Unauthorized');

        if (source.public_id) {
            await cloudinary.uploader.destroy(source.public_id, { resource_type: 'raw' });
        }

        const { error } = await supabase.from('lesson_sources').delete().eq('id', sourceId);
        if (error) throw error;

        logger.info(`🗑️ Source deleted: ${sourceId}`);
        return true;
    }
}

// --- الدوال المساعدة (خارج الكلاس تماماً) ---

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== 'string') return 0;
    const units = { 'bytes': 1, 'kb': 1024, 'mb': 1024 * 1024, 'gb': 1024 * 1024 * 1024 };
    const match = sizeStr.toLowerCase().match(/([\d.]+)\s*(bytes|kb|mb|gb)/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    return value * (units[unit] || 1);
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// التصدير الصحيح (Exporting an object containing everything)
const managerInstance = new SourceManager();

module.exports = managerInstance; // التصدير الافتراضي هو الـ instance
module.exports.parseSizeToBytes = (str) => 0; // لم نعد بحاجة لهذه الدالة للحسابات الدقيقة
module.exports.formatBytes = formatBytes;
