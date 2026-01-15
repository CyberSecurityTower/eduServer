
// services/arena/grader.js
'use strict';

const supabase = require('../data/supabase');
const { updateAtomicProgress } = require('../atomic/atomicManager');
const logger = require('../../utils/logger');

/**
 * خدمة المصحح الذري (The Atomic Grader)
 * 1. تتحقق من الإجابات مقابل قاعدة البيانات.
 * 2. تحسب النتيجة.
 * 3. تقوم بتحديث ذري (Atomic Update) لكل مفهوم (Atom) على حدة.
 */
async function gradeArenaExam(userId, lessonId, userSubmission) {
    // userSubmission = [{ questionId: "...", answer: "..." }, ...]
    
    try {
        if (!userSubmission || userSubmission.length === 0) {
            throw new Error("Empty submission");
        }

        // 1. جلب الإجابات الصحيحة من قاعدة البيانات
        const questionIds = userSubmission.map(s => s.questionId);
        const { data: correctData, error } = await supabase
            .from('question_bank')
            .select('id, atom_id, content, widget_type')
            .in('id', questionIds);

        if (error) throw error;

        // تحويل المصفوفة إلى Map لسهولة البحث
        const questionMap = new Map();
        correctData.forEach(q => questionMap.set(q.id, q));

        // 2. التصحيح وحساب التغييرات الذرية
        let totalScore = 0;
        let correctCount = 0;
        const atomUpdates = {}; // { 'atom_id': { delta: +20 } }

        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue; // سؤال غير موجود (تجاهل)

            const isCorrect = checkAnswer(dbQuestion, sub.answer);
            const atomId = dbQuestion.atom_id;

            // منطق التحديث الذري
            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                totalScore += 1; // نقطة لكل سؤال
                // إذا أجاب صح، نزيد قوة الذرة
                atomUpdates[atomId] += 20; 
            } else {
                // إذا أخطأ، نخفض قوة الذرة (عقاب تعليمي)
                atomUpdates[atomId] -= 10;
            }
        }

        const finalPercentage = Math.round((correctCount / userSubmission.length) * 100);

        // 3. تطبيق التحديثات الذرية (Atomic Commit)
        // نحتاج لجلب السكورات الحالية أولاً لتعديلها
        const { data: currentProgress } = await supabase
            .from('atomic_user_mastery')
            .select('elements_scores')
            .eq('user_id', userId)
            .eq('lesson_id', lessonId)
            .single();

        let newScores = currentProgress?.elements_scores || {};

        // تطبيق الدلتا (Deltas)
        Object.keys(atomUpdates).forEach(atomId => {
            const currentVal = newScores[atomId]?.score || 0;
            const delta = atomUpdates[atomId];
            
            // معادلة بسيطة: Score الجديد = القديم + التغيير (بين 0 و 100)
            let nextVal = Math.max(0, Math.min(100, currentVal + delta));
            
            newScores[atomId] = {
                score: nextVal,
                last_updated: new Date().toISOString()
            };
        });

        // حفظ JSON المحدث (هذا سيشغل الـ Trigger في الداتابايز لتحديث المتوسطات)
        await supabase
            .from('atomic_user_mastery')
            .upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: newScores,
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' });


        // 4. المكافأة (Coins)
        let coinsEarned = 0;
        if (finalPercentage >= 50) {
            coinsEarned = Math.floor(finalPercentage / 2); // 50% = 25 coins, 100% = 50 coins
            
            // إضافة الكوينز
            await supabase.rpc('process_coin_transaction', {
                p_user_id: userId,
                p_amount: coinsEarned,
                p_reason: 'arena_reward',
                p_meta: { lesson_id: lessonId, score: finalPercentage }
            });
        }

        return {
            success: true,
            score: finalPercentage,
            correctCount,
            totalQuestions: userSubmission.length,
            coinsEarned,
            atomUpdates // نرجع التحديثات للفرونت ليقوم بأنيميشن المهارات
        };

    } catch (error) {
        logger.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

// دالة مساعدة لمقارنة الإجابات حسب النوع
function checkAnswer(dbQuestion, userAnswer) {
    const type = dbQuestion.widget_type;
    const correct = dbQuestion.content.correctAnswer;

    if (type === 'MCQ' || type === 'TRUE_FALSE') {
        return String(correct) === String(userAnswer);
    }
    
    // يمكن إضافة منطق لأنواع أخرى (ترتيب، ملء فراغات) هنا
    return false;
}

module.exports = { gradeArenaExam };
