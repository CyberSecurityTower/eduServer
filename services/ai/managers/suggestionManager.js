// services/ai/managers/suggestionManager.js
'use strict';

const { getProfile, getProgress, fetchUserWeaknesses, fetchRecentComprehensiveChatHistory } = require('../../data/helpers');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');
const PROMPTS = require('../../../config/ai-prompts');

let generateWithFailoverRef;

function initSuggestionManager(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

async function runSuggestionManager(userId) {
  try {
    // 1. جلب البيانات
    const [progress, chatHistoryRaw] = await Promise.all([
      getProgress(userId).catch(() => ({})),
      fetchRecentComprehensiveChatHistory(userId).catch(() => '')
    ]);

    // 2. استخراج "آخر درس" توقف عنده الطالب
    let lastLessonContext = "No active lesson.";
    if (progress.pathProgress) {
        // نبحث عن آخر درس تم التفاعل معه (بناءً على last_interaction إن وجد، أو تخمين)
        // للتبسيط هنا سنأخذ أول مهمة معلقة أو آخر درس في المصفوفة
        const tasks = progress.dailyTasks?.tasks || [];
        if (tasks.length > 0) {
            lastLessonContext = `Current Task: ${tasks[0].title}`;
        }
    }

    // 3. استخراج "آخر 10 رسائل" فقط (الذاكرة القصيرة)
    // chatHistoryRaw يأتي كنص طويل، سنحاول تقطيعه
    const chatLines = chatHistoryRaw.split('\n');
    const last10Messages = chatLines.slice(-10).join('\n');

    // 4. استدعاء البرومبت الجديد
    const prompt = PROMPTS.managers.suggestion(lastLessonContext, last10Messages);

    if (!generateWithFailoverRef) return getDefaultSuggestions();

    const res = await generateWithFailoverRef('suggestion', prompt, { label: 'SuggestionManager', timeoutMs: 15000 }); 
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'suggestion');

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      return parsed.suggestions.slice(0, 3); // 3 اقتراحات فقط
    }
  } catch (error) {
    logger.error(`SuggestionManager failed for ${userId}:`, error.message);
  }

  return getDefaultSuggestions();
}

function getDefaultSuggestions() {
  return [
    "لخص لي واش هدرنا",
    "كمل الشرح",
    "أعطيني اختبار خفيف",
    "وين رانا واصلين"
  ];
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
