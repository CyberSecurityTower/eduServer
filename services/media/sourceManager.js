// services/media/sourceManager.js
'use strict';

const supabase = require('../../services/data/supabase');
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

      // 1. تحديد نوع المورد بدقة
      let resourceType = 'raw'; 
      if (mimeType.startsWith('image/')) resourceType = 'image';
      else if (mimeType.startsWith('video/')) resourceType = 'video';
      
      // 2. الرفع إلى Cloudinary
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: 'eduapp_sources',
        resource_type: resourceType,
        use_filename: true,
        public_id: `user_${userId}_${Date.now()}`,
        type: 'upload',
        access_mode: 'public'
      });

      // 3. الحفظ في قاعدة البيانات مع الحالة "processing"
      const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

      const { data, error } = await supabase
        .from('lesson_sources')
        .insert({
          user_id: userId,
          lesson_id: lessonId || null,
          file_url: uploadResult.secure_url,
          file_type: simpleType,
          file_name: originalName,
          public_id: uploadResult.public_id,
          processed: false,
          status: 'processing' // 👈 [جديد] الحالة المبدئية
        })
        .select()
        .single();

      if (error) throw error;

      logger.success(`✅ Source Saved & Processing: ID ${data.id}`);
      return data;

    } catch (err) {
      logger.error('❌ Source Upload Failed:', err.message);
      // تنظيف الملف المؤقت فوراً في حال فشل الرفع الأولي
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw err;
    }
  }

  // ... باقي الدوال (getSourcesByLesson, deleteSource) تبقى كما هي ...
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

  /**
   * 🔍 فحص حالة مصدر معين (للاستخدام في Polling)
   */
  async getSourceStatus(userId, sourceId) {
    const { data, error } = await supabase
      .from('lesson_sources')
      .select('status, error_message, extracted_text') // نجلب البيانات المهمة فقط
      .eq('id', sourceId)
      .eq('user_id', userId) // حماية أمنية: المستخدم يرى ملفاته فقط
      .single();

    if (error) {
        // إذا لم يتم العثور عليه أو حدث خطأ
        return null; 
    }
    return data;
  }
module.exports = new SourceManager();
