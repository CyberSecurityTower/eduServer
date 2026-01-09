// src/services/media/mediaManager.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * يعالج المرفقات (صور، ملفات، صوت) ويجهزها للذكاء الاصطناعي
 * ويسجل العملية في قاعدة البيانات
 */
async function processUserAttachments(userId, filesInput) {
  // تحويل المدخل إلى مصفوفة دائماً (سواء كان ملفاً واحداً أو مصفوفة)
  const files = Array.isArray(filesInput) ? filesInput : (filesInput ? [filesInput] : []);
  
  if (files.length === 0) return { payload: [], note: '' };

  const processedPayloads = [];
  let contextNotes = [];

  for (const file of files) {
      if (!file.data || !file.mime) continue;

      // 1. Log (نسجل كل ملف)
      const sizeKB = Math.ceil((file.data.length * 3) / 4 / 1024);
      // لا ننتظر الـ await
      require('../data/supabase').from('upload_logs').insert({
          user_id: userId,
          file_type: file.mime,
          file_size_kb: sizeKB
      }).then();

      // 2. Add to Payload
      processedPayloads.push({
          inlineData: {
              data: file.data,
              mimeType: file.mime
          }
      });

      // 3. Notes
      if (file.mime.startsWith('audio/')) contextNotes.push("audio file");
      else if (file.mime === 'application/pdf') contextNotes.push("PDF document");
      else if (file.mime.startsWith('image/')) contextNotes.push("image");
  }

  const noteString = contextNotes.length > 0 
      ? `\n[System: User attached: ${contextNotes.join(', ')}. Analyze them all.]` 
      : "";

  return { payload: processedPayloads, note: noteString };
}

module.exports = { processUserAttachments };
