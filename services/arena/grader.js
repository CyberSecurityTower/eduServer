
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

// 🔥 دالة: حساب وتحديث تقدم المادة من الباك إند
async function updateSubjectProgressFromBackend(userId, lessonId, currentLessonScore) {
    try {
        // 1. معرفة المادة التابع لها هذا الدرس
        const { data: lessonMeta, error: metaError } = await supabase
            .from('lessons')
            .select('subject_id')
            .eq('id', lessonId)
            .single();

        if (metaError || !lessonMeta) return; 
        const subjectId = lessonMeta.subject_id;

        // 2. حساب العدد الكلي لدروس هذه المادة
        const { count: totalLessons, error: countError } = await supabase
            .from('lessons')
            .select('*', { count: 'exact', head: true })
            .eq('subject_id', subjectId);

        if (countError || totalLessons === 0) return;

        // 3. جلب مجموع درجات الطالب في هذه المادة
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

        console.log(`📊 [Backend Calc] Subject: ${subjectId} | Mastery: ${subjectMastery}%`);

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

        // 1. جلب الأسئلة الصحيحة للتحقق من الإجابات
        const questionIds = userSubmission.map(s => s.questionId);
        const { data: correctData, error } = await supabase
            .from('question_bank')
            .select('id, atom_id, content, widget_type')
            .in('id', questionIds);

        if (error) throw error;

        // 🆕 2. جلب هيكلة الدرس للحصول على العناوين (Titles) العربية
        // هذا الاستعلام ضروري لربط الـ ID مثل 'roman_conquest' بالعنوان 'مراحل التوسع الروماني'
        const { data: structData, error: structError } = await supabase
            .from('atomic_lesson_structures')
            .select('structure_data')
            .eq('lesson_id', lessonId)
            .single();

        const atomTitlesMap = {};
        if (structData && structData.structure_data && structData.structure_data.elements) {
            structData.structure_data.elements.forEach(el => {
                atomTitlesMap[el.id] = el.title;
            });
        }

        // 3. تجهيز خريطة الأسئلة وبدء التصحيح
        const questionMap = new Map();
        correctData.forEach(q => questionMap.set(q.id, q));

        let correctCount = 0;
        const totalQuestions = userSubmission.length;
        const atomUpdates = {}; 
        
        // حساب الفروقات (Deltas) بناء على الإجابات
        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue;

            const isCorrect = checkAnswer(dbQuestion, sub.answer);
            const atomId = dbQuestion.atom_id;

            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                atomUpdates[atomId] += 100; // زيادة للإجابة الصحيحة
            } else {
                atomUpdates[atomId] -= 50;  // خصم للإجابة الخاطئة
            }
        }

        // حساب الدرجة النهائية للامتحان
        let finalScoreOutOf20 = 0;
        if (totalQuestions > 0) finalScoreOutOf20 = (correctCount / totalQuestions) * 20;
        finalScoreOutOf20 = Math.round(finalScoreOutOf20 * 2) / 2;
        const finalPercentage = Math.round((correctCount / totalQuestions) * 100);

        // 4. جلب حالة الاتقان الحالية (القديمة) من قاعدة البيانات
        const { data: currentProgress } = await supabase
            .from('atomic_user_mastery')
            .select('elements_scores')
            .eq('user_id', userId)
            .eq('lesson_id', lessonId)
            .single();

        // تجهيز كائن الدرجات الجديد وكائن التفاصيل للفرونت إند
        let dbScores = currentProgress?.elements_scores || {}; 
        
        // 🔥 إنشاء مصفوفة لتفاصيل التغيير مع العناوين
        const masteryChanges = [];

        Object.keys(atomUpdates).forEach(atomId => {
            // القيمة القديمة (قبل التحديث)
            const oldScore = dbScores[atomId]?.score || 0;
            
            // حساب القيمة الجديدة
            const delta = atomUpdates[atomId];
            let newScore = Math.max(0, Math.min(100, oldScore + delta));
            
            // تحديث الكائن الذي سيتم حفظه في الداتابيس
            dbScores[atomId] = { 
                score: newScore, 
                last_updated: new Date().toISOString() 
            };

            // إضافة تفاصيل التغيير للمصفوفة التي سنرسلها للفرونت
            masteryChanges.push({
                atom_id: atomId,
                title: atomTitlesMap[atomId] || atomId, // 🆕 إدراج العنوان العربي هنا
                old_score: oldScore,
                new_score: newScore,
                delta: delta, 
            });
        });

        // 5. الحفظ في atomic_user_mastery
        const { error: upsertError } = await supabase
            .from('atomic_user_mastery')
            .upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: dbScores, // نرسل الكائن المحدث
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' });

        if (upsertError) console.error("❌ SUPABASE UPSERT ERROR:", upsertError);
        else console.log("✅ Update Success for User:", userId);

        // تحديث تقدم المادة والكوينز
        setTimeout(() => {
            updateSubjectProgressFromBackend(userId, lessonId, finalPercentage);
        }, 1000);

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

        // 6. إرجاع النتيجة مع بيانات masteryChanges الغنية بالعناوين
        return {
            success: true,
            score: finalScoreOutOf20,
            maxScore: 20,
            percentage: finalPercentage,
            correctCount,
            totalQuestions,
            coinsEarned,
            masteryChanges // 🔥 المصفوفة الجاهزة للعرض
        };

    } catch (error) {
        logger.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

module.exports = { gradeArenaExam };
