// controllers/quizController.js
'use strict';

const { runQuizAnalyzer } = require('../services/ai/managers/quizManager');
const { markLessonComplete } = require('../services/engines/gatekeeper'); // ✅ استيراد
const { refreshUserTasks } = require('../services/data/helpers'); // ✅ استيراد
const { getAlgiersTimeContext } = require('../utils'); // ✅ استيراد
const logger = require('../utils/logger');
const supabase = require('../services/data/supabase'); // نحتاج هذا للتعامل المباشر

async function analyzeQuiz(req, res) {
  try {
    const { userId, lessonId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    
    // Validation
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions)) {
      return res.status(400).json({ error: 'Invalid data.' });
    }

    // 1. تشغيل المحلل النفسي (AI) للحصول على الفيدباك
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });

    // 2. حساب النسبة المئوية
    const maxScore = quizQuestions.length;
    const userScore = Number(totalScore);
    const percentage = maxScore > 0 ? (userScore / maxScore) * 100 : 0;

    // 3. 🔥 منطق المكافآت (EduCoin Logic) 🔥
    let rewardData = null;
    let newTotalCoins = 0;

    // نكافئ فقط إذا تجاوز 50%
    if (percentage >= 50) {
        // معادلة المكافأة: 
        // العلامة الكاملة = 50 كوينز
        // نصف العلامة = 10 كوينز (تشجيعية)
        // ما بينهما يحسب نسبياً
        let coinsEarned = Math.floor((percentage / 100) * 50);
        
        // بونوس العلامة الكاملة
        if (percentage === 100) coinsEarned += 10; 

        // تنفيذ المعاملة المالية
        // نستخدم RPC لضمان السرعة والأمان
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
            logger.success(`🪙 User ${userId} earned ${coinsEarned} coins from Quiz (${percentage}%).`);
        }
    }

    // 4. إذا كان الدرس مرتبطاً بـ ID، نحدث حالة الإكمال في Gatekeeper أيضاً
    // (Gatekeeper ذكي ولن يعطي مكافأة مزدوجة إذا قمنا بضبطه، لكن للأمان هنا حسبنا المكافأة يدوياً)
    if (lessonId && percentage >= 70) {
        // نرسل 0 كوينز إضافية لأننا حسبناها في الخطوة 3
        await markLessonComplete(userId, lessonId, percentage, 0); 
    }

    // 5. تحديث المهام (Gravity Engine)
    const newTasks = await refreshUserTasks(userId);
    const nextTasks = newTasks.filter(t => t.meta?.relatedLessonId !== lessonId);
    const topTask = nextTasks.length > 0 ? nextTasks[0] : null;

    // 6. تحديد الخطوة التالية (نفس المنطق السابق)
    const algiersTime = getAlgiersTimeContext();
    const isLateNight = algiersTime.hour >= 22 || algiersTime.hour < 5;
    let smartNextStep = topTask ? `الدرس التالي: ${topTask.title}` : "استراحة";
    let actionType = "navigate";

    if (isLateNight) {
        smartNextStep = "الوقت تأخر، روح ترقد وتدي الراحة.";
        actionType = "sleep";
    }

    // 7. إرسال الرد النهائي
    const finalResponse = {
        ...analysis,
        suggestedNextStep: smartNextStep,
        nextTaskMeta: topTask ? topTask.meta : null,
        actionType: actionType,
        // ✅ البيانات الجديدة للمحفظة
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
