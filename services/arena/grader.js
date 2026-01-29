
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

// دالة لفتح الدرس التالي (Future-Proof Logic)
async function unlockNextLesson(userId, currentLessonId, subjectId) {
    try {
        // 1. العثور على ترتيب الدرس الحالي
        const { data: currentLesson, error: lError } = await supabase
            .from('lessons')
            .select('order_index')
            .eq('id', currentLessonId)
            .single();
            
        if (lError || !currentLesson) return;

        // 2. العثور على الدرس التالي مباشرة في نفس المادة
        const { data: nextLesson, error: nError } = await supabase
            .from('lessons')
            .select('id')
            .eq('subject_id', subjectId)
            .gt('order_index', currentLesson.order_index) // أكبر من الترتيب الحالي
            .order('order_index', { ascending: true })
            .limit(1)
            .single();

        if (nError || !nextLesson) return; // قد يكون هذا آخر درس

        // 3. فتح الدرس التالي (UPSERT خفيف جداً)
        // نستخدم onConflict للتأكد أننا لا نعيد الكتابة إذا كان مفتوحاً بالفعل بطريقة أخرى (مثل إعلان)
        // لكن هنا نريد ضمان فتحه عبر الـ progression
        await supabase
            .from('user_lesson_stats')
            .upsert({
                user_id: userId,
                lesson_id: nextLesson.id,
                subject_id: subjectId,
                is_unlocked: true, // ✅ المفتاح السحري: يبقى مفتوحاً للأبد
                unlock_method: 'progression', // المصدر: نجاح في الدرس السابق
                last_updated_at: new Date().toISOString()
            }, { 
                onConflict: 'user_id, lesson_id',
                ignoreDuplicates: false 
            });
            
        console.log(`🔓 Next lesson ${nextLesson.id} unlocked for user ${userId}`);

    } catch (err) {
        console.error("Error unlocking next lesson:", err);
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

        // 1. جلب البيانات الأساسية (الأسئلة، هيكلة الدرس، والإحصائيات الحالية) في وقت واحد لتحسين الأداء
        const [questionsRes, structureRes, statsRes, masteryRes] = await Promise.all([
            supabase.from('question_bank').select('id, atom_id, content, widget_type').in('id', userSubmission.map(s => s.questionId)),
            supabase.from('atomic_lesson_structures').select('structure_data, subject_id').eq('lesson_id', lessonId).single(),
            supabase.from('user_lesson_stats').select('*').eq('user_id', userId).eq('lesson_id', lessonId).single(),
            supabase.from('atomic_user_mastery').select('elements_scores').eq('user_id', userId).eq('lesson_id', lessonId).single()
        ]);

        if (questionsRes.error) throw questionsRes.error;
        const correctData = questionsRes.data;
        const structData = structureRes.data;
        const oldStats = statsRes.data;
        const subjectId = structData?.subject_id;

        // 2. بناء خريطة العناوين العربية (Atom Titles Map)
        const atomTitlesMap = {};
        if (structData?.structure_data?.elements) {
            structData.structure_data.elements.forEach(el => {
                atomTitlesMap[el.id] = el.title_ar || el.title || el.id;
            });
        }

        // 3. تصحيح الأسئلة وحساب النقاط لكل مهارة (Atom Updates)
        const questionMap = new Map(correctData.map(q => [q.id, q]));
        let correctCount = 0;
        const totalQuestions = userSubmission.length;
        const atomUpdates = {}; 

        for (const sub of userSubmission) {
            const dbQuestion = questionMap.get(sub.questionId);
            if (!dbQuestion) continue;

            const isCorrect = checkAnswer(dbQuestion, sub.answer); // دالة التحقق المفترضة
            const atomId = dbQuestion.atom_id;

            if (!atomUpdates[atomId]) atomUpdates[atomId] = 0;

            if (isCorrect) {
                correctCount++;
                atomUpdates[atomId] += 100; 
            } else {
                atomUpdates[atomId] -= 50;  
            }
        }

        // 4. حساب الدرجات النهائية (النسبة المئوية والدرجة من 20)
        const finalPercentage = Math.round((correctCount / totalQuestions) * 100);
        let finalScoreOutOf20 = Math.round(((correctCount / totalQuestions) * 20) * 2) / 2;

        // 5. تطبيق "المعادلة العادلة" لإتقان الدرس (Lesson Mastery)
        const oldMastery = oldStats?.mastery_percent || 0;
        const oldHighest = oldStats?.highest_score || 0;
        const wasPassed = oldMastery >= 50;
        let newMastery = finalPercentage;

        if (oldStats) {
            if (finalPercentage >= oldMastery) {
                newMastery = finalPercentage; // تحسن
            } else {
                // تراجع: وزن 70% للقديم و 30% للجديد (عقاب خفيف)
                newMastery = Math.round((oldMastery * 0.7) + (finalPercentage * 0.3));
                if (wasPassed && newMastery < 50) newMastery = 50; // شبكة أمان
            }
        }

        // 6. تحديث مهارات الـ Atoms وحساب مصفوفة التغييرات للفرونت إند
        let dbScores = masteryRes.data?.elements_scores || {};
        const masteryChanges = [];

        Object.keys(atomUpdates).forEach(atomId => {
            const oldScore = dbScores[atomId]?.score || 0;
            const delta = atomUpdates[atomId];
            let newScore = Math.max(0, Math.min(100, oldScore + delta));
            
            dbScores[atomId] = { score: newScore, last_updated: new Date().toISOString() };

            masteryChanges.push({
                atom_id: atomId,
                title: atomTitlesMap[atomId] || atomId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                old_score: oldScore,
                new_score: newScore,
                delta: delta
            });
        });

        // 7. تنفيذ عمليات الحفظ في قاعدة البيانات (في وقت واحد)
        const updates = [
            // تحديث إحصائيات الدرس الكلية
            supabase.from('user_lesson_stats').upsert({
                user_id: userId,
                lesson_id: lessonId,
                subject_id: subjectId,
                mastery_percent: newMastery,
                highest_score: Math.max(oldHighest, finalPercentage),
                is_unlocked: true,
                attempts_count: (oldStats?.attempts_count || 0) + 1,
                last_attempt_at: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' }),

            // تحديث نقاط المهارات الفرعية
            supabase.from('atomic_user_mastery').upsert({
                user_id: userId,
                lesson_id: lessonId,
                elements_scores: dbScores,
                last_updated: new Date().toISOString()
            }, { onConflict: 'user_id, lesson_id' })
        ];

        await Promise.all(updates);

        // 8. مهام الخلفية (الكوينز، فتح الدرس التالي، تقدم المادة)
        const isNowPassed = newMastery >= 50;
        
        // حساب الكوينز
        let coinsEarned = 0;
        if (finalPercentage >= 50) {
            coinsEarned = Math.floor(finalPercentage / 2);
            supabase.rpc('process_coin_transaction', {
                p_user_id: userId, p_amount: coinsEarned, p_reason: 'arena_reward',
                p_meta: { lesson_id: lessonId, score: finalPercentage }
            }).then(() => console.log("Coins granted"));
        }

        // فتح الدرس التالي إذا نجح
        if (isNowPassed) {
            unlockNextLesson(userId, lessonId, subjectId); 
        }

        // تحديث تقدم المادة
        setTimeout(() => {
            updateSubjectProgressFromBackend(userId, lessonId, finalPercentage);
        }, 1000);

        // 9. إرجاع النتيجة النهائية الشاملة
        return {
            success: true,
            score: finalScoreOutOf20,
            maxScore: 20,
            percentage: finalPercentage,
            mastery: newMastery, // النسبة الموزونة
            isPassed: isNowPassed,
            correctCount,
            totalQuestions,
            coinsEarned,
            masteryChanges // تفاصيل المهارات بالعناوين العربية
        };

    } catch (error) {
        console.error(`Arena Grader Error [${userId}]:`, error.message);
        throw error;
    }
}

module.exports = { gradeArenaExam };
