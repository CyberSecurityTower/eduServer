// services/media/sourceManager.js
'use strict';

const supabase = require('../../services/data/supabase');
const cloudinary = require('../../config/cloudinary');
const logger = require('../../utils/logger');
const fs = require('fs');

class SourceManager {
  /**
   * 📤 رفع مصدر جديد
   * @param {string} displayName - الاسم الذي سيظهر للمستخدم (Custom or Original)
   * @param {string} originalFileName - الاسم الحقيقي للملف (لأغراض الأرشفة)
   */
  async uploadSource(userId, lessonId, filePath, displayName, mimeType, originalFileName) {
    try {
      logger.info(`📤 Uploading source [${displayName}] (Original: ${originalFileName}) for Lesson: ${lessonId || 'Pending'}...`);

      // 1. تحديد نوع المورد
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

      // 3. الحفظ في قاعدة البيانات
      const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

      const insertData = {
          user_id: userId,
          lesson_id: lessonId || null,
          file_url: uploadResult.secure_url,
          file_type: simpleType,
          
          file_name: displayName, // ✅ هذا الاسم الذي سيظهر في التطبيق (Custom Name)
          original_file_name: originalFileName, 
          
          public_id: uploadResult.public_id,
          processed: false,
          status: 'processing'
      };

      const { data, error } = await supabase
        .from('lesson_sources')
        .insert(insertData)
        .select()
        .single();

      if (error) throw error;

      logger.success(`✅ Source Saved: ${data.file_name} (ID: ${data.id})`);
      return data;

    } catch (err) {
      logger.error('❌ Source Upload Failed:', err.message);
      // تنظيف الملف المؤقت فوراً في حال فشل الرفع الأولي
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
      // ✅ نختار (*) لجلب النص المستخرج، الحالة، ورسالة الخطأ
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

  /**
   * 🔍 فحص حالة مصدر معين (للاستخدام في Polling)
   */
  async getSourceStatus(userId, sourceId) {
    const { data, error } = await supabase
      .from('lesson_sources')
      .select('status, error_message, extracted_text')      .eq('id', sourceId)
      .eq('user_id', userId)       .single();

    if (error) {
       
        return null; 
    }
    return data;
  }
} 
async function getLibraryStats(req, res) {
    const userId = req.user?.id;

    try {
        // 1. جلب بيانات المرفوعات (Uploaded Sources)
        const { data: uploads, error: uploadError } = await supabase
            .from('lesson_sources')
            .select('file_size_bytes, file_size') // سأفترض وجود حجم أو سنحسبه
            .eq('user_id', userId);

        if (uploadError) throw uploadError;

        // 2. جلب بيانات المشتريات (Purchased Items)
        // نربط مع جدول store_items لجلب أحجام الملفات
        const { data: purchases, error: purchaseError } = await supabase
            .from('user_inventory')
            .select(`
                item_id,
                store_items (file_size)
            `)
            .eq('user_id', userId);

        if (purchaseError) throw purchaseError;

        // --- حسابات المرفوعات ---
        const uploadedCount = uploads.length;
        let totalUploadedBytes = 0;
        uploads.forEach(item => {
            // تحويل النص (مثلا "1.2 MB") إلى Bytes
            totalUploadedBytes += parseSizeToBytes(item.file_size || '0 Bytes');
        });

        // --- حسابات المشتريات ---
        const purchasedCount = purchases.length;
        let totalPurchasedBytes = 0;
        purchases.forEach(item => {
            if (item.store_items && item.store_items.file_size) {
                totalPurchasedBytes += parseSizeToBytes(item.store_items.file_size);
            }
        });

        // 3. تحويل النتائج النهائية لصيغة مقروءة
        res.json({
            success: true,
            stats: {
                uploads: {
                    count: uploadedCount,
                    totalSize: formatBytes(totalUploadedBytes)
                },
                purchases: {
                    count: purchasedCount,
                    totalSize: formatBytes(totalPurchasedBytes)
                },
                grandTotalSize: formatBytes(totalUploadedBytes + totalPurchasedBytes)
            }
        });

    } catch (err) {
        console.error('❌ Error fetching library stats:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// --- Helpers للتعامل مع الأحجام ---

// تحويل من نص (KB, MB) إلى رقم (Bytes)
function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== 'string') return 0;
    const units = { 'bytes': 1, 'kb': 1024, 'mb': 1024 * 1024, 'gb': 1024 * 1024 * 1024 };
    const match = sizeStr.toLowerCase().match(/([\d.]+)\s*(bytes|kb|mb|gb)/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    return value * (units[unit] || 1);
}

// تحويل من رقم (Bytes) إلى نص مقروء (MB, GB)
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
module.exports = new SourceManager();
