// controllers/quizController.js
'use strict';

const { runQuizAnalyzer } = require('../services/ai/managers/quizManager');
const { markLessonComplete } = require('../services/engines/gatekeeper'); // ✅ استيراد
const { refreshUserTasks } = require('../services/data/helpers'); // ✅ استيراد
const { getAlgiersTimeContext } = require('../utils'); // ✅ استيراد
const logger = require('../utils/logger');

async function analyzeQuiz(req, res) {
  try {
    const { userId, lessonId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    
    // Validation
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions)) {
      return res.status(400).json({ error: 'Invalid data.' });
    }

    // 1. تشغيل المحلل النفسي (AI) للحصول على الفيدباك فقط
    // ملاحظة: سنتجاهل اقتراحه للخطوة التالية ونستبدله بمنطقنا
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });

    // 2. إذا كانت العلامة جيدة (> 70%)، نعتبر الدرس مكتملاً
    const scorePercentage = (totalScore / quizQuestions.length) * 100;
    if (scorePercentage >= 70 && lessonId) {
        await markLessonComplete(userId, lessonId, scorePercentage);
    }

    // 3. 🔥 تشغيل محرك الجاذبية لمعرفة "ماذا بعد؟"
    const newTasks = await refreshUserTasks(userId);
    
    // تصفية الدرس الحالي من القائمة (لضمان عدم تكراره)
    const nextTasks = newTasks.filter(t => t.meta?.relatedLessonId !== lessonId);
    const topTask = nextTasks.length > 0 ? nextTasks[0] : null;

    // 4. 🛡️ تطبيق "حارس النوم" و "طوارئ الامتحان"
    const algiersTime = getAlgiersTimeContext();
    const isLateNight = algiersTime.hour >= 22 || algiersTime.hour < 5;
    const isExamEmergency = topTask?.meta?.isExamPrep || false; // هل المهمة القادمة هي تحضير لامتحان؟

    let smartNextStep = "";
    let actionType = "navigate"; // navigate | sleep | review

    // السيناريو A: وقت متأخر + امتحان غداً = نوم إجباري
    if (isExamEmergency && isLateNight) {
        smartNextStep = "🛑 حبس هنا! غدوة عندك امتحان. الخطوة التالية هي: النوم فوراً لترسيخ المعلومات.";
        actionType = "sleep";
    }
    // السيناريو B: وقت متأخر عادي = اقتراح النوم
    else if (isLateNight) {
        smartNextStep = "يعطيك الصحة! الوقت تأخر، روح تريح وغدوة نكملو.";
        actionType = "sleep";
    }
    // السيناريو C: امتحان غداً (والوقت ليس متأخراً) = مراجعة الامتحان
    else if (isExamEmergency) {
        smartNextStep = `🚨 حالة طوارئ: الانتقال فوراً لمراجعة ${topTask.title} للامتحان!`;
        actionType = "navigate";
    }
    // السيناريو D: الوضع الطبيعي = الدرس التالي
    else if (topTask) {
        smartNextStep = `الخطوة التالية: درس ${topTask.title}`;
        actionType = "navigate";
    } 
    // السيناريو E: لا توجد مهام
    else {
        smartNextStep = "أكملت كل مهامك! استمتع بوقتك.";
        actionType = "chill";
    }

    // 5. دمج النتائج (Override AI Suggestion)
    const finalResponse = {
        ...analysis,
        suggestedNextStep: smartNextStep, // ✅ استبدلنا اقتراح الـ AI الغبي باقتراحنا الذكي
        nextTaskMeta: topTask ? topTask.meta : null, // نرسل الميتا للفرونت أند للتوجيه
        actionType: actionType
    };

    return res.status(200).json(finalResponse);

  } catch (err) {
    logger.error('/analyze-quiz error:', err.stack);
    return res.status(500).json({ error: 'Internal error.' });
  }
}

module.exports = {
  analyzeQuiz,
};
