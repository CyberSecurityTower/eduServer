
// services/arena/grader.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

// --- 1. دوال المساعدة (Helpers) ---

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
        // تنظيف المدخلات للمقارنة النصية
        if (['MCQ', 'TRUE_FALSE', 'YES_NO'].includes(type)) {
            return String(content.correct_answer).trim().toLowerCase() === String(userAnswer).trim().toLowerCase();
        }
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

// --- 2. دالة تحديث تقدم المادة (Backend Progress) ---

async function updateSubjectProgressFromBackend(userId, lessonId, currentLessonScore) {
    try {
        // أ. معرفة المادة التابع لها هذا الدرس
        const { data: lessonMeta, error: metaError } = await supabase
            .from('lessons')
            .select('subject_id')
            .eq('id', lessonId)
            .single();

        if (metaError || !lessonMeta) return; 
        const subjectId = lessonMeta.subject_id;

        // ب. حساب العدد الكلي لدروس هذه المادة
        const { count: totalLessons, error: countError } = await supabase
            .from('lessons')
            .select('*', { count: 'exact', head: true })
            .eq('subject_id', subjectId);

        if (countError || totalLessons === 0) return;

        // ج. جلب مجموع درجات الطالب في هذه المادة
        const { data: sumData } = await supabase
            .from('user_lesson_stats')
            .select('mastery_percent')
            .eq('user_id', userId)
            .eq('subject_id', subjectId);
            
        let finalSum = 0;
        if (sumData) {
            finalSum = sumData.reduce((acc, curr) => acc + (curr.mastery_percent || 0), 0);
        }

        // د. المعادلة
        let subjectMastery = (finalSum / totalLessons);
        if (subjectMastery > 100) subjectMastery = 100;

        console.log(`📊 [Backend Calc] Subject: ${subjectId} | Mastery: ${subjectMastery}%`);

        // هـ. تحديث جدول المادة
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

// --- 3. الدالة الرئيسية: تصحيح الامتحان (Grade Exam) ---

async function gradeArenaExam(userId, lessonId, userSubmission) {
    try {
        if (!userSubmission || userSubmission.length === 0) throw new Error("Empty submission");

        // 1. جلب الأسئلة الصحيحة من قاعدة البيانات
        const questionIds = userSubmission.map(s => s.questionId);
        const { data: correctData, error } = await supabase
            .from('question_bank')
            .select('id, atom_id, content, widget_type')
            .in('id', questionIds);

        if (error) throw error;

        // 2. 🔥 جلب العناوين العربية (هيكلة الدرس)
        // هذا الجزء يضمن عرض أسماء المهارات بالعربي بدلاً من الرموز الإنجليزية
        const { data: structData } = await supabase
            .from('atomic_lesson_structures')
            .select('structure_data')
            .eq('lesson_id', lessonId)
            .single();

        const atomTitlesMap = {};
        
        if (structData?.structure_data?.elements) {
            structData.structure_data.elements.forEach(el => {
                // الأولوية للعنوان العربي، ثم الإنجليزي، ثم المعرف
                atomTitlesMap[el.id] = el.title_ar || el.title || el.id; 
            });
            // console.log("✅ Titles Map Loaded:", Object.keys(atomTitlesMap).length, "atoms found.");
        } else {
            console.warn("⚠️ No structure data found for lesson:", lessonId);
        }

        // 3. تصحيح الأسئلة وحساب التغييرات
        const questionMap = new Map();
        correctData.forEach(q => questionMap.set(q.id, q));

        let correctCount = 0;
        const totalQuestions = userSubmission.length;
        const atomUpdates = {}; // لتجميع النقاط لكل مهارة (Atom)
        
        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue;

            const isCorrect = checkAnswer(dbQuestion, sub.answer); 
            const atomId = dbQuestion.atom_id;

            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                atomUpdates[atomId] += 100; // زيادة عند الإجابة الصحيحة
            } else {
                atomUpdates[atomId] -= 50;  // خصم عند الخطأ
            }
        }

        // حساب الدرجة النهائية للامتحان (من 20) والنسبة المئوية
        let finalScoreOutOf20 = (totalQuestions > 0) ? ((correctCount / totalQuestions) * 20) : 0;
        finalScoreOutOf20 = Math.round(finalScoreOutOf20 * 2) / 2; // التقريب لأقرب 0.5
        const finalPercentage = Math.round((correctCount / totalQuestions) * 100);

        // 4. جلب حالة الاتقان الحالية (القديمة) لتحديثها
        const { data: currentProgress } = await supabase
            .from('atomic_user_mastery')
            .select('elements_scores')
            .eq('user_id', userId)
            .eq('lesson_id', lessonId)
            .single();

        let dbScores = currentProgress?.elements_scores || {}; 
        
        // 🔥 مصفوفة لتفاصيل التغيير مع العناوين (للفرونت إند)
        const masteryChanges = [];

        Object.keys(atomUpdates).forEach(atomId => {
            // القيمة القديمة
            const oldScore = dbScores[atomId]?.score || 0;
            
            // حساب القيمة الجديدة (بين 0 و 100)
            const delta = atomUpdates[atomId];
            let newScore = Math.max(0, Math.min(100, oldScore + delta));
            
            // تحديث كائن التخزين
            dbScores[atomId] = { 
                score: newScore, 
                last_updated: new Date().toISOString() 
            };

            // تحديد عنوان العرض (Display Title)
            let displayTitle = atomTitlesMap[atomId];
            if (!displayTitle) {
                // Fallback: تحويل roman_conquest_stages إلى Roman Conquest Stages
                displayTitle = atomId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            }

            // إضافة تفاصيل التغيير للمصفوفة
            masteryChanges.push({
                atom_id: atomId,
                title: displayTitle, // ✅ العنوان جاهز للعرض
                old_score: oldScore,
                new_score: newScore,
                delta: delta, 
            });
        });

        // 5. حفظ التغييرات في قاعدة البيانات (atomic_user_mastery)
        const { error: upsertError } = await supabase
            .from('atomic_user_mastery')
            .upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: dbScores,
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' });

        if (upsertError) console.error("❌ SUPABASE UPSERT ERROR:", upsertError);
        else console.log("✅ Mastery Update Success for User:", userId);

        // 6. مهام الخلفية: تحديث تقدم المادة والكوينز
        setTimeout(() => {
            updateSubjectProgressFromBackend(userId, lessonId, finalPercentage);
        }, 1000);

        let coinsEarned = 0;
        if (finalPercentage >= 50) {
            coinsEarned = Math.floor(finalPercentage / 2);
            // تسجيل المعاملة في الخلفية
            await supabase.rpc('process_coin_transaction', {
                p_user_id: userId,
                p_amount: coinsEarned,
                p_reason: 'arena_reward',
                p_meta: { lesson_id: lessonId, score: finalPercentage }
            });
        }

        // 7. إرجاع النتيجة النهائية
        return {
            success: true,
            score: finalScoreOutOf20,
            maxScore: 20,
            percentage: finalPercentage,
            correctCount,
            totalQuestions,
            coinsEarned,
            masteryChanges // ✅ تحتوي الآن على العناوين
        };

    } catch (error) {
        logger.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

module.exports = { gradeArenaExam };
