// services/ai/lessonGenerator.js
'use strict';

const fs = require('fs');
const generateWithFailover = require('./failover');
const { extractTextFromResult } = require('../../utils');
const { MARKDOWN_LESSON_PROMPT } = require('../../config/lesson-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth'); 
const CONFIG = require('../../config'); // ✅ استيراد الكونفيج

/**
 * @param {string} filePath - مسار الملف
 * @param {string} mimeType - نوع الملف
 * @param {string} lessonTitle - عنوان الدرس
 */
async function generateLessonFromSource(filePath, mimeType, lessonTitle) {
  try {
    logger.info(`🧠 AI Processing: Generating lesson for "${lessonTitle}"...`);

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    const attachments = [{
      inlineData: {
        data: base64Data,
        mimeType: mimeType
      }
    }];

    const finalPrompt = MARKDOWN_LESSON_PROMPT(lessonTitle);

    // 🔥 التغيير الجذري: نستخدم اسم الموديل من الكونفيج (الذي يجب أن يكون flash)
    // أو نكتب 'gemini-1.5-flash' مباشرة هنا لضمان عدم توقف النظام
    const targetModel = CONFIG.MODEL.lesson_generator || 'gemini-1.5-flash';

    const response = await generateWithFailover(
      'lesson_generator', 
      finalPrompt, 
      { 
        attachments: attachments,
        timeoutMs: 120000, // دقيقتين كافية للـ pro
        label: 'LessonGenFlash', 
        enableSearch: false, 
        maxRetries: 10
      }
    );

    if (!response || !response.text) {
        logger.warn(`AI returned empty response for ${lessonTitle}`);
        return null;
    }

    const lessonContent = await extractTextFromResult(response);
    
    if (lessonContent.length < 100) {
        throw new Error("AI generated content is too short.");
    }

    systemHealth.reportSuccess(); 
    return lessonContent;

  } catch (error) {
    logger.error('❌ AI Lesson Generator Handled Error:', error.message);
    systemHealth.reportCriticalFailure(error);
    return null; 
  }
}

module.exports = { generateLessonFromSource };
