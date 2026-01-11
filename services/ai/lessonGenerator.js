// services/ai/lessonGenerator.js
'use strict';

const fs = require('fs');
const { generateWithFailover } = require('./failover'); // نستخدم نظام الفشل الذكي
const { extractTextFromResult } = require('../../utils');
const { MARKDOWN_LESSON_PROMPT } = require('../../config/lesson-prompts');
const logger = require('../../utils/logger');

/**
 * دالة تقوم بقراءة الملف وإرساله للذكاء الاصطناعي لتوليد الدرس
 * @param {string} filePath - مسار الملف المؤقت
 * @param {string} mimeType - نوع الملف
 */
async function generateLessonFromSource(filePath, mimeType) {
  try {
    logger.info('🧠 AI Processing: Reading file for lesson generation...');

    // 1. تحويل الملف إلى Buffer (لإرساله للـ AI)
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // 2. تجهيز المرفق (Payload)
    const attachments = [{
      inlineData: {
        data: base64Data,
        mimeType: mimeType
      }
    }];

    // 3. الإرسال للموديل (نستخدم 'analysis' أو 'chat' حسب ما تفضل)
    // نمرر البرومبت الصارم + المرفق
    const response = await generateWithFailover(
      'analysis', 
      MARKDOWN_LESSON_PROMPT, 
      { 
        attachments: attachments,
        timeoutMs: 120000, // نعطيه وقت أطول (دقيقتين) لأن قراءة الملفات قد تكون ثقيلة
        label: 'LessonGenerator'
      }
    );

    // 4. استخراج النص
    const lessonContent = await extractTextFromResult(response);
    
    logger.success(`🧠 AI successfully generated lesson content (${lessonContent.length} chars).`);
    return lessonContent;

  } catch (error) {
    logger.error('❌ AI Lesson Generation Failed:', error.message);
    // في حالة الفشل، نرجع null ولا نوقف العملية كاملة (الملف أهم)
    return null; 
  }
}

module.exports = { generateLessonFromSource };
