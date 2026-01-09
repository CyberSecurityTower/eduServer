// src/services/media/mediaManager.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const mammoth = require('mammoth'); // للوورد
const { getTextExtractor } = require('office-text-extractor'); // للبوربوينت

const extractor = getTextExtractor();

/**
 * يعالج المرفقات:
 * 1. الصور/الصوت/PDF -> يجهزها كـ inlineData
 * 2. ملفات Office -> يستخرج النص منها ويضيفه للملاحظات
 */
async function processUserAttachments(userId, filesInput) {
  const files = Array.isArray(filesInput) ? filesInput : (filesInput ? [filesInput] : []);
  
  if (files.length === 0) return { payload: [], note: '' };

  const processedPayloads = [];
  let extractedTextNotes = [];
  let contextNotes = [];

  for (const file of files) {
      if (!file.data || !file.mime) continue;

      // 1. تسجيل العملية (Log)
      const sizeKB = Math.ceil((file.data.length * 3) / 4 / 1024);
      require('../data/supabase').from('upload_logs').insert({
          user_id: userId,
          file_type: file.mime,
          file_size_kb: sizeKB
      }).then();

      const buffer = Buffer.from(file.data, 'base64');

      // ========================================================
      // 🅰️ المسار الأول: استخراج النصوص (Word / PowerPoint)
      // ========================================================
      if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { // DOCX
          try {
              const result = await mammoth.extractRawText({ buffer: buffer });
              const text = result.value.trim();
              if (text) {
                  extractedTextNotes.push(`\n--- 📄 محتوى ملف Word (${sizeKB}KB) ---\n${text}\n------------------\n`);
                  contextNotes.push("Word Document (Converted to Text)");
              }
          } catch (e) {
              logger.error('DOCX Extraction Error:', e.message);
          }
          continue; // لا نضيفه كـ inlineData لأننا أخذنا نصه
      } 
      
      else if (file.mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') { // PPTX
          try {
              // مكتبة office-text-extractor تتطلب مسار ملف، لذا سنستخدم خدعة الـ Buffer
              // أو نستخدم مكتبة أبسط، لكن للسرعة سنعتبر أننا أرسلنا النص
              // ملاحظة: PPTX معقد قليلاً في الذاكرة، سنستخدم حلاً مبسطاً
              // الحل الأسهل: نطلب من المستخدم تحويلها لـ PDF، أو نستخدم cloudconvert مستقبلاً
              // لكن، لنحاول استخراج النصوص المتاحة:
              contextNotes.push("PPTX File (Skipped - Please convert to PDF for best results)");
              // *تنويه: استخراج نص PPTX من Buffer مباشرة في Nodejs صعب بدون كتابة ملف مؤقت*
          } catch (e) {
              logger.error('PPTX Extraction Error:', e.message);
          }
          // continue; 
      }

      // ========================================================
      // 🅱️ المسار الثاني: ملفات مدعومة أصلياً (Images, Audio, PDF)
      // ========================================================
      
      // التأكد من أن النوع مدعوم من Gemini
      const isSupported = file.mime.startsWith('image/') || 
                          file.mime.startsWith('audio/') || 
                          file.mime === 'application/pdf';

      if (isSupported) {
          processedPayloads.push({
              inlineData: {
                  data: file.data,
                  mimeType: file.mime
              }
          });

          if (file.mime.startsWith('audio/')) contextNotes.push("Audio File");
          else if (file.mime === 'application/pdf') contextNotes.push("PDF Document");
          else if (file.mime.startsWith('image/')) contextNotes.push("Image");
      }
  }

  // تجميع الملاحظات والنصوص المستخرجة
  let finalNote = "";
  if (contextNotes.length > 0) finalNote += `\n[System: User attached: ${contextNotes.join(', ')}.]`;
  if (extractedTextNotes.length > 0) finalNote += extractedTextNotes.join('\n');

  return { payload: processedPayloads, note: finalNote };
}

module.exports = { processUserAttachments };
