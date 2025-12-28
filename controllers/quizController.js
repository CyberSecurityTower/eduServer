// controllers/quizController.js
'use strict';

const { runQuizAnalyzer } = require('../services/ai/managers/quizManager');
const { markLessonComplete } = require('../services/engines/gatekeeper'); 
const { refreshUserTasks } = require('../services/data/helpers'); 
const { getAlgiersTimeContext } = require('../utils'); 
const logger = require('../utils/logger');
const supabase = require('../services/data/supabase'); 
// ✅ استيراد مدير النظام الذري
const { updateAtomicProgress } = require('../services/atomic/atomicManager');

async function analyzeQuiz(req, res) {
  try {
    const { userId, lessonId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    
    // Validation
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions)) {
      return res.status(400).json({ error: 'Invalid data.' });
    }

    // 1. تشغيل المحلل النفسي (AI)
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });

    // 2. حساب النسبة المئوية
    const maxScore = quizQuestions.length;
    const userScore = Number(totalScore);
    const percentage = maxScore > 0 ? (userScore / maxScore) * 100 : 0;

    // 3. 🔥 التحديث الذري (The Atomic Override)
    // إذا نجح في الكويز، نعتبره أتقن كل الذرات (Bulk Update)
    if (percentage >= 70) {
        await updateAtomicProgress(userId, lessonId, { 
            element_id: 'ALL', 
            new_score: 100,
            reason: 'quiz_passed'
        });
        // ملاحظة: هذا الاستدعاء سيشغل Gatekeeper داخلياً ويمنح مكافأة "إتقان الدرس" (50 كوينز)
    }

    // 4. 🔥 مكافأة الكويز (Quiz Performance Reward)
    // هذه مكافأة إضافية على "الأداء الجيد" في الامتحان (منفصلة عن إتمام الدرس)
    let rewardData = null;
    let newTotalCoins = 0;

    if (percentage >= 50) { // <--- ✅ أصلحنا الخطأ هنا (أضفنا الشرط المفقود)
        
        // معادلة المكافأة: نصف العلامة كوينز
        let coinsEarned = Math.floor((percentage / 100) * 50);
        
        // بونوس العلامة الكاملة
        if (percentage === 100) coinsEarned += 10; 

        // تنفيذ المعاملة المالية
        const { data: balance, error } = await supabase.rpc('process_coin_transaction', {
            p_user_id: userId,
            p_amount: coinsEarned,
            p_reason: 'quiz_reward',
            p_meta: { 
                lesson_id: lessonId, 
                score_percentage: percentage,
                lesson_title: lessonTitle 
            }
        });

        if (!error) {
            newTotalCoins = balance;
            rewardData = {
                coins_added: coinsEarned,
                reason: percentage === 100 ? 'perfect_score' : 'quiz_passed'
            };
            logger.success(`🪙 User ${userId} earned ${coinsEarned} coins from Quiz Performance.`);
        }
    }

    // 5. (اختياري) تحديث النظام القديم للأمان (Backward Compatibility)
    // يمكنك حذف هذا لاحقاً عندما تتأكد أن النظام الذري يعمل 100%
    if (lessonId && percentage >= 70) {
        // نرسل 0 كوينز لأننا منحناها أعلاه
        await markLessonComplete(userId, lessonId, percentage, 0); 
    }

    // 6. تحديث المهام (Gravity Engine)
    const newTasks = await refreshUserTasks(userId);
    const nextTasks = newTasks.filter(t => t.meta?.relatedLessonId !== lessonId);
    const topTask = nextTasks.length > 0 ? nextTasks[0] : null;

    // 7. تحديد الخطوة التالية
    const algiersTime = getAlgiersTimeContext();
    const isLateNight = algiersTime.hour >= 22 || algiersTime.hour < 5;
    let smartNextStep = topTask ? `الدرس التالي: ${topTask.title}` : "استراحة";
    let actionType = "navigate";

    if (isLateNight) {
        smartNextStep = "الوقت تأخر، روح ترقد وتدي الراحة.";
        actionType = "sleep";
    }

    // 8. إرسال الرد النهائي
    const finalResponse = {
        ...analysis,
        suggestedNextStep: smartNextStep,
        nextTaskMeta: topTask ? topTask.meta : null,
        actionType: actionType,
        reward: rewardData,
        new_total_coins: newTotalCoins
    };

    return res.status(200).json(finalResponse);

  } catch (err) {
    logger.error('/analyze-quiz error:', err.stack);
    return res.status(500).json({ error: 'Internal error.' });
  }
}

module.exports = { analyzeQuiz };
