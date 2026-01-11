// services/ai/lessonGenerator.js
'use strict';

const fs = require('fs');
const generateWithFailover = require('./failover');
const { extractTextFromResult } = require('../../utils');
const { MARKDOWN_LESSON_PROMPT } = require('../../config/lesson-prompts');
const logger = require('../../utils/logger');

/**
 * @param {string} filePath - مسار الملف
 * @param {string} mimeType - نوع الملف
 * @param {string} lessonTitle - عنوان الدرس (لتحسين السياق والبحث)
 */
async function generateLessonFromSource(filePath, mimeType, lessonTitle) {
  try {
    logger.info(`🧠 AI Processing: Generating lesson for "${lessonTitle}" with Search...`);

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    const attachments = [{
      inlineData: {
        data: base64Data,
        mimeType: mimeType
      }
    }];

    // توليد البرومبت الديناميكي مع العنوان
    const finalPrompt = MARKDOWN_LESSON_PROMPT(lessonTitle);

    const response = await generateWithFailover(
      'analysis', // نستخدم بول التحليل
      finalPrompt, 
      { 
        attachments: attachments,
        timeoutMs: 200000, // 3 دقائق (بحث + قراءة ملف يحتاج وقت)
        label: 'LessonGenerator',
        enableSearch: true //  تفعيل البحث لجلب روابط اليوتيوب
      }
    );

    const lessonContent = await extractTextFromResult(response);
    
    // تحقق بسيط: إذا كان المحتوى قصيراً جداً، ربما فشل
    if (!lessonContent || lessonContent.length < 50) return null;

    logger.success(`🧠 AI Generated Lesson with Resources for: ${lessonTitle}`);
    return lessonContent;

  } catch (error) {
    logger.error('❌ AI Lesson Generation Failed:', error.message);
    return null;
  }
}

module.exports = { generateLessonFromSource };
