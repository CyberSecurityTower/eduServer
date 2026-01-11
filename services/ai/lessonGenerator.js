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
      'lesson_generator', // ✅ سيستخدم الآن gemini-1.5-pro
      finalPrompt, 
      { 
        attachments: attachments,
        timeoutMs: 300000, // 🔥 نعطيه 5 دقائق كاملة لأن Pro أبطأ لكن أدق
        label: 'LessonGeneratorPro', // Label للتتبع
        enableSearch: true ,
        maxRetries: 20
      }
    );
 // ✅ التحقق القوي من النتيجة
    if (!response || !response.text) {
        logger.warn(`AI returned empty response for ${lessonTitle}`);
        return null;
    }

    const lessonContent = await extractTextFromResult(response);
    
    // ✅ حماية إضافية: التأكد من أن المحتوى صالح للحفظ
    if (lessonContent.length < 100) {
        throw new Error("AI generated content is too short (Potential Failure).");
    }

    return lessonContent;

  } catch (error) {
    // نضمن أننا نلتقط الخطأ ولا نوقف السيرفر
    logger.error('❌ AI Lesson Generator Handled Error:', error.message);
    return null; // نرجع null ليعرف الكونترولر أنه فشل
  }
}

module.exports = { generateLessonFromSource };
