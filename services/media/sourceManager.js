// services/media/sourceManager.js
'use strict';

const supabase = require('../data/supabase');
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
  
  /**
   * رفع ملف واحد إلى Cloudinary وتسجيله في الداتابايز
   */
  async uploadSource(userId, lessonId, filePath, originalName, mimeType) {
    try {
      logger.info(`📤 Uploading source for User: ${userId}...`);

      // 1. الرفع إلى Cloudinary
      // نستخدم folder خاص لفصل ملفات هذا النظام
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: 'eduapp_sources_temp', // مجلد مؤقت
        resource_type: 'auto', // يقبل pdf, images, raw
        public_id: `user_${userId}_${Date.now()}` // اسم فريد
      });

      // 2. حذف الملف المؤقت من السيرفر (نظافة)
      if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
      }

      // 3. الحفظ في الداتابايز
      const { data, error } = await supabase
        .from('lesson_sources')
        .insert({
          user_id: userId,
          lesson_id: lessonId || null, // يمكن ربطه لاحقاً
          file_url: uploadResult.secure_url,
          file_type: uploadResult.format || mimeType.split('/')[1],
          file_name: originalName,
          public_id: uploadResult.public_id,
          processed: false
        })
        .select()
        .single();

      if (error) throw error;

      logger.success(`✅ Source uploaded: ${originalName} (ID: ${data.id})`);
      return data;

    } catch (err) {
      logger.error('❌ Source Upload Error:', err.message);
      // تنظيف الملف إذا فشل الرفع
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw err;
    }
  }

  /**
   * جلب مصادر درس معين
   */
  async getSourcesForLesson(userId, lessonId) {
    const { data, error } = await supabase
      .from('lesson_sources')
      .select('*')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId);

    if (error) return [];
    return data;
  }

  /**
   * حذف مصدر (يدوياً أو عبر الكرون جوب)
   */
  async deleteSource(sourceId) {
    // 1. جلب الـ public_id
    const { data: source } = await supabase
        .from('lesson_sources')
        .select('public_id')
        .eq('id', sourceId)
        .single();

    if (source && source.public_id) {
        // حذف من Cloudinary
        await cloudinary.uploader.destroy(source.public_id);
    }

    // حذف من الداتابايز
    await supabase.from('lesson_sources').delete().eq('id', sourceId);
  }
}

module.exports = new SourceManager();
