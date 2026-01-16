
// services/arena/grader.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

// --- دوال المساعدة (كما هي) ---
function isEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!isEqual(a[i], b[i])) return false;
        return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) if (!Object.prototype.hasOwnProperty.call(b, key) || !isEqual(a[key], b[key])) return false;
        return true;
    }
    return false;
}

function checkAnswer(dbQuestion, userAnswer) {
    const type = dbQuestion.widget_type;
    const content = dbQuestion.content;
    try {
        if (['MCQ', 'TRUE_FALSE', 'YES_NO'].includes(type)) return String(content.correct_answer).trim() === String(userAnswer).trim();
        if (type === 'MCM') {
            if (!Array.isArray(userAnswer)) return false;
            const correct = content.correct_answer || [];
            return [...correct].sort().join('|') === [...userAnswer].sort().join('|');
        }
        if (type === 'ORDERING') return isEqual(content.correct_order || [], userAnswer);
        if (type === 'MATCHING') return isEqual(content.correct_matches || {}, userAnswer);
        if (type === 'FILL_BLANKS') return isEqual(content.correct_answer || [], userAnswer);
        return false;
    } catch (e) {
        console.error("Error checking answer:", e);
        return false;
    }
}

// 🔥 دالة جديدة: حساب وتحديث تقدم المادة من الباك إند
async function updateSubjectProgressFromBackend(userId, lessonId, currentLessonScore) {
    try {
        // 1. معرفة المادة التابع لها هذا الدرس
        const { data: lessonMeta, error: metaError } = await supabase
            .from('lessons')
            .select('subject_id')
            .eq('id', lessonId)
            .single();

        if (metaError || !lessonMeta) return; // لا يمكن المتابعة
        const subjectId = lessonMeta.subject_id;

        // 2. حساب العدد الكلي لدروس هذه المادة
        const { count: totalLessons, error: countError } = await supabase
            .from('lessons')
            .select('*', { count: 'exact', head: true })
            .eq('subject_id', subjectId);

        if (countError || totalLessons === 0) return;

        // 3. جلب مجموع درجات الطالب في هذه المادة
        // نستخدم RPC أو استعلام مباشر لجمع الدرجات من جدول إحصائيات الدروس
        const { data: allStats, error: statsError } = await supabase
            .from('user_lesson_stats')
            .select('mastery_percent')
            .eq('user_id', userId)
            .eq('subject_id', subjectId);

        if (statsError) return;

        // 4. الحساب اليدوي للمجموع
        // ملاحظة: نقوم بجمع الدرجات، ولكن يجب أن نتأكد أن درجة الدرس الحالي محدثة
        // لذلك سنقوم بحساب المجموع مع استبدال/ضمان وجود درجة الدرس الحالي
        let totalScoreSum = 0;
        
        // خريطة لتخزين الدرجات لتجنب التكرار وضمان آخر درجة
        const scoresMap = {};
        
        // نملأ الخريطة بالبيانات من القاعدة
        allStats.forEach(stat => {
            // بما أن user_lesson_stats لا يرجع lesson_id في هذا الاستعلام البسيط، 
            // سنعتمد على الجمع المباشر، ولكن الأفضل هو الاعتماد على القيمة التي حسبناها للتو
            totalScoreSum += (stat.mastery_percent || 0);
        });

        // ⚠️ تصحيح دقيق: بما أن قاعدة البيانات قد تكون بطيئة في تحديث user_lesson_stats عبر التريجر القديم
        // قد يكون المجموع ناقصاً لدرجة الدرس الحالي أو يحتوي على القيمة القديمة.
        // الحل الأسلم: إعادة حساب المجموع الكلي استناداً إلى المنطق.
        
        // النهج الأبسط والأكثر فاعلية للباك إند:
        // نعتمد على أن التريجر الداخلي قد حدث user_lesson_stats، أو نقوم بتحديثه يدوياً هنا.
        // لكن لتبسيط الأمور، سنقوم بتحديث user_subject_stats مباشرة
        
        // إعادة الاستعلام بدقة أكبر للحصول على المجموع الصحيح
        const { data: sumData } = await supabase
            .from('user_lesson_stats')
            .select('mastery_percent')
            .eq('user_id', userId)
            .eq('subject_id', subjectId);
            
        let finalSum = 0;
        if (sumData) {
            finalSum = sumData.reduce((acc, curr) => acc + (curr.mastery_percent || 0), 0);
        }

        // المعادلة
        let subjectMastery = (finalSum / totalLessons);
        if (subjectMastery > 100) subjectMastery = 100;

        console.log(`📊 [Backend Calc] Subject: ${subjectId} | Total Lessons: ${totalLessons} | Sum: ${finalSum} | Mastery: ${subjectMastery}%`);

        // 5. تحديث جدول المادة
        await supabase
            .from('user_subject_stats')
            .upsert({
                user_id: userId,
                subject_id: subjectId,
                mastery_percent: subjectMastery,
                last_updated_at: new Date().toISOString()
            }, { onConflict: 'user_id, subject_id' });

    } catch (err) {
        console.error("Error updating subject progress:", err);
    }
}


async function gradeArenaExam(userId, lessonId, userSubmission) {
    try {
        if (!userSubmission || userSubmission.length === 0) throw new Error("Empty submission");

        const questionIds = userSubmission.map(s => s.questionId);
        const { data: correctData, error } = await supabase
            .from('question_bank')
            .select('id, atom_id, content, widget_type')
            .in('id', questionIds);

        if (error) throw error;

        const questionMap = new Map();
        correctData.forEach(q => questionMap.set(q.id, q));

        let correctCount = 0;
        const totalQuestions = userSubmission.length;
        const atomUpdates = {}; 
        
        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue;

            const isCorrect = checkAnswer(dbQuestion, sub.answer);
            const atomId = dbQuestion.atom_id;

            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                atomUpdates[atomId] += 100; // إتقان فوري
            } else {
                atomUpdates[atomId] -= 50;
            }
        }

        let finalScoreOutOf20 = 0;
        if (totalQuestions > 0) finalScoreOutOf20 = (correctCount / totalQuestions) * 20;
        finalScoreOutOf20 = Math.round(finalScoreOutOf20 * 2) / 2;

        const finalPercentage = Math.round((correctCount / totalQuestions) * 100);

        // تحديث Atomic Mastery
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
            newScores[atomId] = { score: nextVal, last_updated: new Date().toISOString() };
        });

        // 1. الحفظ في atomic_user_mastery
        const { error: upsertError } = await supabase
            .from('atomic_user_mastery')
            .upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: newScores,
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' });

        if (upsertError) console.error("❌ SUPABASE UPSERT ERROR:", upsertError);
        else console.log("✅ Update Success for User:", userId);

        // -------------------------------------------------------------
        // 🔥 الانتظار قليلاً لضمان أن التريجر الداخلي حدث user_lesson_stats
        // ثم استدعاء دالة تحديث المادة من الباك إند
        // -------------------------------------------------------------
        setTimeout(() => {
            updateSubjectProgressFromBackend(userId, lessonId, finalPercentage);
        }, 1000); // تأخير ثانية واحدة لضمان استقرار قاعدة البيانات

        // الكوينز
        let coinsEarned = 0;
        if (finalPercentage >= 50) {
            coinsEarned = Math.floor(finalPercentage / 2);
            await supabase.rpc('process_coin_transaction', {
                p_user_id: userId,
                p_amount: coinsEarned,
                p_reason: 'arena_reward',
                p_meta: { lesson_id: lessonId, score: finalPercentage }
            });
        }

        return {
            success: true,
            score: finalScoreOutOf20,
            maxScore: 20,
            percentage: finalPercentage,
            correctCount,
            totalQuestions,
            coinsEarned,
            atomUpdates
        };

    } catch (error) {
        logger.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

module.exports = { gradeArenaExam };
