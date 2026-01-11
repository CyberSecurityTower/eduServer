// services/media/sourceManager.js
'use strict';

const supabase = require('../../services/data/supabase'); // تأكد من المسار الصحيح لملف supabase
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
  /**
   * 📤 رفع مصدر جديد
   */
  async uploadSource(userId, lessonId, filePath, originalName, mimeType) {
    try {
      logger.info(`📤 Uploading source [${originalName}] for Lesson: ${lessonId || 'Pending'}...`);

      // 1. تحديد نوع المورد بدقة (الحل للمشكلة)
      // الصور والفيديوهات لها معاملة خاصة، أما المستندات (PDF, Word) يجب أن تكون 'raw'
      let resourceType = 'raw'; 
      if (mimeType.startsWith('image/')) resourceType = 'image';
      else if (mimeType.startsWith('video/')) resourceType = 'video';
      
      // ملاحظة: PDF نجعله raw ليتم تحميله كما هو بدون تلاعب من Cloudinary

      // 2. الرفع إلى Cloudinary
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: 'eduapp_sources',
        resource_type: resourceType, // 👈 التغيير هنا: نحدد النوع يدوياً
        use_filename: true,
        public_id: `user_${userId}_${Date.now()}` // اسم فريد
      });

      // 3. حذف الملف المؤقت (تنظيف)
      if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
      }

      // 4. الحفظ في قاعدة البيانات
      const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

      const { data, error } = await supabase
        .from('lesson_sources')
        .insert({
          user_id: userId,
          lesson_id: lessonId || null,
          file_url: uploadResult.secure_url, // الرابط الآن سيكون /raw/upload/ وهو الصحيح
          file_type: simpleType,
          file_name: originalName,
          public_id: uploadResult.public_id,
          processed: false
        })
        .select()
        .single();

      if (error) throw error;

      logger.success(`✅ Source Saved: ID ${data.id}`);
      return data;

    } catch (err) {
      logger.error('❌ Source Upload Failed:', err.message);
      // تنظيف الملف المؤقت حتى لو فشلت العملية
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw err;
    }
  }
  /**
   * 📥 جلب مصادر درس معين
   */
  async getSourcesByLesson(userId, lessonId) {
    const { data, error } = await supabase
      .from('lesson_sources')
      .select('*')
      .eq('lesson_id', lessonId)
      // نسمح للمستخدم يشوف ملفاته، أو نضيف منطق للمشاركة لاحقاً
      .eq('user_id', userId) 
      .order('created_at', { ascending: false });

    if (error) {
        logger.error('Get Sources Error:', error.message);
        return [];
    }
    return data;
  }

  /**
   * 🗑️ حذف مصدر
   */
  async deleteSource(userId, sourceId) {
    // 1. جلب معلومات الملف للتأكد من الملكية والحصول على public_id
    const { data: source } = await supabase
        .from('lesson_sources')
        .select('public_id, user_id')
        .eq('id', sourceId)
        .single();

    if (!source) throw new Error('Source not found');
    if (source.user_id !== userId) throw new Error('Unauthorized');

    // 2. الحذف من Cloudinary
    if (source.public_id) {
        // نحدد نوع المورد للحذف الصحيح
        await cloudinary.uploader.destroy(source.public_id, { resource_type: 'raw' }); 
        // ملاحظة: raw تغطي الـ PDF والملفات، للصور استعمل 'image'
        // Cloudinary أحياناً يتطلب تحديد النوع بدقة، لكن نجربو raw أو auto
    }

    // 3. الحذف من الداتابايز
    const { error } = await supabase.from('lesson_sources').delete().eq('id', sourceId);
    if (error) throw error;

    logger.info(`🗑️ Source deleted: ${sourceId}`);
    return true;
  }
}

module.exports = new SourceManager();
