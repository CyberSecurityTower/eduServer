
// services/arena/grader.js
'use strict';

const supabase = require('../data/supabase');
const { updateAtomicProgress } = require('../atomic/atomicManager');
const logger = require('../../utils/logger');

/**
 * 🛠️ دالة مساعدة لمقارنة المصفوفات والكائنات بعمق (Deep Equality)
 */
function isEqual(a, b) {
    // 1. إذا كانت القيم بسيطة (نصوص، أرقام)
    if (a === b) return true;
    
    // 2. إذا كانت مصفوفات (Arrays)
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isEqual(a[i], b[i])) return false;
        }
        return true;
    }
    
    // 3. إذا كانت كائنات (Objects)
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!Object.prototype.hasOwnProperty.call(b, key) || !isEqual(a[key], b[key])) return false;
        }
        return true;
    }
    
    return false;
}

/**
 * 🧠 الدالة الذكية للتحقق من الإجابات حسب نوع السؤال
 */
function checkAnswer(dbQuestion, userAnswer) {
    const type = dbQuestion.widget_type;
    const content = dbQuestion.content;

    try {
        // 1. MCQ, TRUE_FALSE, YES_NO (مقارنة نصوص)
        if (['MCQ', 'TRUE_FALSE', 'YES_NO'].includes(type)) {
            return String(content.correct_answer).trim() === String(userAnswer).trim();
        }

        // 2. MCM (ترتيب غير مهم)
        if (type === 'MCM') {
            if (!Array.isArray(userAnswer)) return false;
            const correct = content.correct_answer || [];
            
            // نفرز المصفوفتين ثم نقارنهما كنصوص لضمان تطابق المحتوى بغض النظر عن الترتيب
            const sortedCorrect = [...correct].sort().join('|');
            const sortedUser = [...userAnswer].sort().join('|');
            return sortedCorrect === sortedUser;
        }

        // 3. ORDERING (ترتيب مهم)
        // المفتاح هنا هو correct_order
        if (type === 'ORDERING') {
            const correct = content.correct_order || [];
            return isEqual(correct, userAnswer);
        }

        // 4. FILL_BLANKS (ترتيب مهم)
        if (type === 'FILL_BLANKS') {
            const correct = content.correct_answer || [];
            return isEqual(correct, userAnswer);
        }

        // 5. MATCHING (كائنات)
        // المفتاح هنا هو correct_matches
        if (type === 'MATCHING') {
            const correct = content.correct_matches || {};
            return isEqual(correct, userAnswer);
        }

        return false;
    } catch (e) {
        console.error("Error checking answer:", e);
        return false;
    }
}

/**
 * 🎓 خدمة المصحح الرئيسي
 */
async function gradeArenaExam(userId, lessonId, userSubmission) {
    try {
        if (!userSubmission || userSubmission.length === 0) {
            throw new Error("Empty submission");
        }

        // 1. جلب الإجابات الصحيحة
        const questionIds = userSubmission.map(s => s.questionId);
        const { data: correctData, error } = await supabase
            .from('question_bank')
            .select('id, atom_id, content, widget_type')
            .in('id', questionIds);

        if (error) throw error;

        const questionMap = new Map();
        correctData.forEach(q => questionMap.set(q.id, q));

        // 2. التصحيح
        let correctCount = 0;
        const atomUpdates = {}; 
        
        const POINTS_PER_QUESTION = 2; // للحصول على 20 درجة

        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue;

            // 🔥 استخدام دالة التحقق الذكية الجديدة
            const isCorrect = checkAnswer(dbQuestion, sub.answer);
            const atomId = dbQuestion.atom_id;

            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                atomUpdates[atomId] += 20; 
            } else {
                atomUpdates[atomId] -= 10;
            }
        }

        // 3. الحسابات النهائية
        const finalScoreOutOf20 = correctCount * POINTS_PER_QUESTION; 
        const finalPercentage = Math.round((finalScoreOutOf20 / 20) * 100);


        // 4. تحديث الـ Mastery في قاعدة البيانات
        const { data: currentProgress } = await supabase
            .from('atomic_user_mastery')
            .select('elements_scores')
            .eq('user_id', userId)
            .eq('lesson_id', lessonId)
            .single();

        let newScores = currentProgress?.elements_scores || {};

        Object.keys(atomUpdates).forEach(atomId => {
            const currentVal = newScores[atomId]?.score || 0;
            const delta = atomUpdates[atomId];
            let nextVal = Math.max(0, Math.min(100, currentVal + delta));
            
            newScores[atomId] = {
                score: nextVal,
                last_updated: new Date().toISOString()
            };
        });

        const { error: upsertError } = await supabase
            .from('atomic_user_mastery')
            .upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: newScores,
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' });

        // 👇 إضافة هذا السطر لكشف الخطأ
        if (upsertError) {
            console.error("❌ SUPABASE UPSERT ERROR:", upsertError);
        } else {
            console.log("✅ Update Success for User:", userId);
        }

        // 5. المكافأة (Coins)
         let coinsEarned = 0;
        if (finalPercentage >= 50) {
            coinsEarned = Math.floor(finalPercentage / 2); // مثال: 100% = 50 كوينز
            
            await supabase.rpc('process_coin_transaction', {
                p_user_id: userId,
                p_amount: coinsEarned,
                p_reason: 'arena_reward',
                p_meta: { lesson_id: lessonId, score: finalPercentage }
            });
        }

        // 6. الرد النهائي
        return {
            success: true,
            score: finalScoreOutOf20,
            maxScore: 20,
            percentage: finalPercentage,
            // 🔥 تعديل: تم حذف xpEarned من هنا
            correctCount,
            totalQuestions: userSubmission.length,
            coinsEarned,
            atomUpdates
        };

    } catch (error) {
        logger.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

module.exports = { gradeArenaExam };
