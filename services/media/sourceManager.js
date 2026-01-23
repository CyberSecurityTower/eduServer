'use strict';

const supabase = require('../../services/data/supabase');
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
     /**
     * رفع ملف جديد مع توليد صور المعاينة للـ PDF
     */
    async uploadSource(userId, lessonId, filePath, displayName, description, mimeType, originalFileName, folderId = null, fileSize = 0) {
        try {
            logger.info(`📤 Uploading source [${displayName}]...`);

            // 1. تحديد الحجم
            let finalFileSize = fileSize;
            if (!finalFileSize || finalFileSize === 0) {
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    finalFileSize = stats.size;
                }
            }

            // 2. تحديد نوع الموارد
            // ⚠️ ملاحظة مهمة: لكي نتمكن من استخراج صور من PDF، يفضل رفعه كـ 'auto' أو 'image' في كلاوديناري وليس 'raw'
            let resourceType = 'raw'; 
            if (mimeType.startsWith('image/')) resourceType = 'image';
            else if (mimeType.startsWith('video/')) resourceType = 'video';
            else if (mimeType === 'application/pdf') resourceType = 'image'; // ✅ خدعة: نرفع PDF كصورة ليتم معالجته

            // الرفع إلى Cloudinary
            const uploadResult = await cloudinary.uploader.upload(filePath, {
                folder: 'eduapp_sources',
                resource_type: resourceType,
                use_filename: true,
                public_id: `user_${userId}_${Date.now()}`,
                // للـ PDF نضيف flag لضمان تحميله كمستند قابل للتصفح
                flags: mimeType === 'application/pdf' ? "attachment" : undefined 
            });

            // تحديث الحجم إذا لم يتوفر سابقاً
            if ((!finalFileSize || finalFileSize === 0) && uploadResult.bytes) {
                finalFileSize = uploadResult.bytes;
            }

            const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';
            const isPdf = mimeType === 'application/pdf';

            // 3. 🌟 توليد الصور المصغرة ومعاينة الصفحات
            let thumbnailUrl = null;
            let previewImages = [];

            if (resourceType === 'image' && !isPdf) {
                // إذا كان صورة عادية
                thumbnailUrl = uploadResult.secure_url;
                previewImages.push(uploadResult.secure_url); // الصورة نفسها كمعاينة

            } else if (resourceType === 'video') {
                // إذا كان فيديو، نأخذ لقطة بامتداد jpg
                thumbnailUrl = uploadResult.secure_url.replace(/\.[^/.]+$/, ".jpg");

            } else if (isPdf) {
                // 🔥 سحر الـ PDF: نكون الروابط يدوياً للصفحات
                // رابط الصورة الأولى (Thumbnail) - نضيف pg_1
                // مثال الرابط: .../image/upload/pg_1/v1234/file.pdf
                // لكن Cloudinary ذكي، إذا غيرنا الامتداد لـ .jpg سيعطينا الصفحة الأولى
                
                // الطريقة الأضمن مع Cloudinary URL generation:
                const baseUrl = uploadResult.secure_url;
                // حذف الامتداد .pdf وإضافته كـ .jpg للصورة المصغرة
                thumbnailUrl = baseUrl.replace('.pdf', '.jpg');

                // توليد روابط لأول 5 صفحات
                // التنسيق: .../upload/w_800,q_auto,pg_1/id.jpg
                // سنقوم بتركيب الرابط بناءً على public_id ليكون أدق
                const versionStr = `v${uploadResult.version}`;
                const baseUrlPrefix = uploadResult.secure_url.split(versionStr)[0] + versionStr;
                const publicIdWithFormat = uploadResult.public_id; // عادة يكون بدون امتداد

                for (let i = 1; i <= 5; i++) {
                    // نستخدم cloudinary.url لتوليد رابط نظيف (أو نركبه يدوياً)
                    // تركيب يدوي سريع ومضمون:
                    // نضيف pg_{i} قبل الـ public_id
                    // ونغير الامتداد لـ jpg
                    const pageUrl = cloudinary.url(publicIdWithFormat, {
                        resource_type: 'image',
                        page: i,
                        format: 'jpg',
                        transformation: [{ width: 600, quality: "auto" }] // تقليل الحجم قليلاً للمعاينة
                    });
                    previewImages.push(pageUrl);
                }
            }

            // 4. التحضير للإدخال
            const insertData = {
                user_id: userId,
                lesson_id: lessonId || null,
                folder_id: folderId || null,
                file_url: uploadResult.secure_url,
                thumbnail_url: thumbnailUrl, // ✅ الآن سيحمل صورة الصفحة الأولى للـ PDF
                file_type: simpleType,
                file_name: displayName,
                description: description,
                original_file_name: originalFileName,
                public_id: uploadResult.public_id,
                file_size: finalFileSize,
                preview_images: previewImages, // ✅ مصفوفة الصور الخمس
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
        try {
            // 1. جلب الروابط من الجدول الوسيط (source_lessons)
            const { data: linkedData, error: linkError } = await supabase
                .from('source_lessons')
                .select('source_id')
                .eq('lesson_id', lessonId);

            if (linkError) throw linkError;

            // استخراج مصفوفة الآيديهات (IDs) للملفات المرتبطة
            const linkedSourceIds = (linkedData || []).map(item => item.source_id);

            // 2. بناء الاستعلام لجلب تفاصيل الملفات
            // نريد الملفات التي:
            // أ) lesson_id الخاص بها يساوي الدرس الحالي (مباشر)
            // ب) أو الـ id الخاص بها موجود في قائمة الروابط (مرتبط)
            
            let query = supabase
                .from('lesson_sources')
                .select('*')
                .eq('user_id', userId); // أمان إضافي: التأكد أن الملف يخص المستخدم

            if (linkedSourceIds.length > 0) {
                // دمج الشرطين: إما الدرس مباشر أو ضمن القائمة المرتبطة
                query = query.or(`lesson_id.eq.${lessonId},id.in.(${linkedSourceIds.join(',')})`);
            } else {
                // لا توجد ملفات مرتبطة، نجلب المباشرة فقط
                query = query.eq('lesson_id', lessonId);
            }

            const { data: sources, error: sourceError } = await query.order('created_at', { ascending: false });

            if (sourceError) throw sourceError;

            // 3. إضافة علامة صغيرة (Flag) لتمييز الملفات المرتبطة (اختياري للفرونت إند)
            // الملف يعتبر "مرتبطاً" إذا كان lesson_id الخاص به لا يساوي الدرس الحالي
            const enrichedSources = sources.map(source => ({
                ...source,
                is_linked: source.lesson_id !== lessonId // true إذا كان مستورداً من مكان آخر
            }));

            return enrichedSources;

        } catch (err) {
            logger.error('❌ Get Lesson Sources Error:', err.message);
            // في حال الخطأ نرجع مصفوفة فارغة لتجنب كراش التطبيق
            return [];
        }
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
