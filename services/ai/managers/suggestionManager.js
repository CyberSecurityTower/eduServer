// services/ai/managers/suggestionManager.js
'use strict';

const { getProfile, getProgress, fetchUserWeaknesses, refreshUserTasks } = require('../../data/helpers');
const { extractTextFromResult, ensureJsonOrRepair, getAlgiersTimeContext } = require('../../../utils');
const logger = require('../../../utils/logger');
const PROMPTS = require('../../../config/ai-prompts');

let generateWithFailoverRef;

function initSuggestionManager(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

async function runSuggestionManager(userId) {
  try {
    // 1. تجميع المعلومات الاستخباراتية (Intelligence Gathering)
    const [profile, progress, weaknesses, tasks] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      getProgress(userId).catch(() => ({})),
      fetchUserWeaknesses(userId).catch(() => []),
      refreshUserTasks(userId).catch(() => []) // نجلب المهام الحالية
    ]);

    // 2. تحليل السياق الزمني (Time Context)
    const timeData = getAlgiersTimeContext();
    
    // 3. استخراج "أهم مهمة" (Top Task)
    let topTaskTitle = null;
    if (tasks && tasks.length > 0) {
        // المهام مرتبة أصلاً حسب الأولوية في refreshUserTasks
        topTaskTitle = tasks[0].title;
    }

    // 4. استخراج "آخر نشاط" (Last Activity)
    let lastActivity = "Nothing specific";
    if (progress.dailyTasks && progress.dailyTasks.tasks && progress.dailyTasks.tasks.length > 0) {
        // نأخذ آخر مهمة تم العمل عليها أو أول مهمة معلقة
        const last = progress.dailyTasks.tasks.find(t => t.status === 'in_progress') || progress.dailyTasks.tasks[0];
        if (last) lastActivity = last.title;
    }

    // 5. استخراج "نقطة ضعف" (Weakness)
    let weaknessTopic = null;
    if (weaknesses && weaknesses.length > 0) {
        // نختار واحدة عشوائياً للتنويع
        const randomWeakness = weaknesses[Math.floor(Math.random() * weaknesses.length)];
        weaknessTopic = randomWeakness.subjectTitle || randomWeakness.lessonTitle;
    }

    // 6. تجهيز كائن السياق للبرومبت
    const context = {
        name: profile.firstName || 'Student',
        timeVibe: timeData.vibe, // e.g., "Late Night", "Morning Grind"
        lastActivity: lastActivity,
        topTask: topTaskTitle,
        weakness: weaknessTopic
    };

    // 7. استدعاء الذكاء الاصطناعي
    if (!generateWithFailoverRef) return getDefaultSuggestions(timeData);

    const prompt = PROMPTS.managers.suggestion(context);
    
    // نستخدم موديل سريع (flash) مع timeout قصير لأن المستخدم ينتظر
    const res = await generateWithFailoverRef('suggestion', prompt, { label: 'SmartSuggestions', timeoutMs: 8000 }); 
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'suggestion');

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      // نخلط الاقتراحات قليلاً لكي لا يكون الترتيب مملاً دائماً
      return parsed.suggestions.slice(0, 4);
    }

  } catch (error) {
    logger.error(`SuggestionManager failed for ${userId}:`, error.message);
  }

  // Fallback ذكي في حالة الفشل
  return getDefaultSuggestions(getAlgiersTimeContext());
}

/**
 * اقتراحات احتياطية ذكية تعتمد على الوقت فقط
 */
function getDefaultSuggestions(timeData) {
  const hour = timeData.hour;
  
  if (hour >= 5 && hour < 12) { // صباح
      return ["صباح الخير! واش نقراو؟", "واش هي خطة اليوم؟", "بداية درس جديد", "نكتة صباحية"];
  } else if (hour >= 12 && hour < 18) { // مساء
      return ["نكملو القراية؟", "واش كاين تطبيقات؟", "لخصلي واش فات", "استراحة خفيفة"];
  } else if (hour >= 18 && hour < 22) { // ليل
      return ["مراجعة خفيفة", "واش حفظت اليوم؟", "غدوة واش كاين؟", "نصيحة لليل"];
  } else { // ليل متأخر
      return ["نرقد ولا نزيد؟", "قصة قبل النوم", "خطة غدوة", "تصبح على خير"];
  }
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
