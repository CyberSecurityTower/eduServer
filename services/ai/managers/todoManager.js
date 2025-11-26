
// services/ai/managers/todoManager.js
'use strict';

const PROMPTS = require('../../../config/ai-prompts');
const logger = require('../../../utils/logger');
const { extractTextFromResult, parseJSONFromText } = require('../../../utils');
const { getProgress, fetchUserWeaknesses } = require('../../data/helpers');

let generateWithFailoverRef;

function initTodoManager(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * يولد قائمة مهام ذكية بناءً على وضع الطالب
 */
async function generateSmartTodos(userId, requestCount = 3) {
  try {
    // 1. جلب البيانات (Progress + Weaknesses)
    const [progress, weaknesses] = await Promise.all([
      getProgress(userId),
      fetchUserWeaknesses(userId)
    ]);

    // 2. تحضير البرومبت
    // نفترض أن requestCount هو عدد المهام المطلوبة
    const prompt = PROMPTS.managers.todo(
      { studyLevel: 'University' }, // يمكن جلبه من البروفايل الحقيقي
      JSON.stringify(progress).slice(0, 1000), // تقليص النص لتوفير التوكيز
      weaknesses,
      requestCount
    );

    // 3. استدعاء الموديل (نستخدم موديل سريع مثل flash)
    const response = await generateWithFailoverRef('todo', prompt, { 
      label: 'TodoManager',
      timeoutMs: 15000 
    });

    const text = await extractTextFromResult(response);
    const json = parseJSONFromText(text);

    return json?.tasks || [];

  } catch (error) {
    logger.error(`TodoManager Error for user ${userId}:`, error.message);
    // إرجاع مهمة افتراضية في حالة الفشل
    return [{ title: "مراجعة عامة", type: "review", priority: "medium" }];
  }
}

module.exports = {
  initTodoManager,
  generateSmartTodos
};
