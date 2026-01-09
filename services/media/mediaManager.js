// src/services/media/mediaManager.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * يعالج المرفقات (صور، ملفات، صوت) ويجهزها للذكاء الاصطناعي
 * ويسجل العملية في قاعدة البيانات
 */
async function processUserAttachment(userId, file) {
  // 1. إذا لم يوجد ملف، نرجع فارغاً فوراً
  if (!file || !file.data || !file.mime) {
    return { payload: null, note: '' };
  }

  try {
    // 2. تسجيل العملية (Logging) - Fire & Forget
    // لا ننتظرها (await) لكي لا نؤخر الرد
    const sizeKB = Math.ceil((file.data.length * 3) / 4 / 1024);
    
    supabase.from('upload_logs').insert({
        user_id: userId,
        file_type: file.mime,
        file_size_kb: sizeKB
    }).then(({ error }) => {
        if (error) logger.error('Upload Log Failed:', error.message);
    });

    // 3. تحديد نوع الملاحظة للسياق
    let contextNote = "";
    if (file.mime.startsWith('audio/')) {
        contextNote = "\n[System: User attached an audio file. Listen to it carefully.]";
    } else if (file.mime === 'application/pdf') {
        contextNote = "\n[System: User attached a PDF document. Read its content.]";
    } else if (file.mime.startsWith('image/')) {
        contextNote = "\n[System: User attached an image. Analyze it.]";
    }

    // 4. إرجاع الكائن الجاهز
    return {
      payload: {
        data: file.data, // Base64
        mime: file.mime
      },
      note: contextNote
    };

  } catch (error) {
    logger.error('Media Processing Error:', error);
    return { payload: null, note: '' };
  }
}

module.exports = { processUserAttachment };
