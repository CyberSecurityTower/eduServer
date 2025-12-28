// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff } = require('../../../utils');
// 🔥 استيراد getProgress لجلب البيانات الذرية
const { getProgress } = require('../../data/helpers'); 

/**
 * 🪐 CORTEX GRAVITY ENGINE V5.0 (Atomic Planner)
 * الخوارزمية: تحسب "ثقل" كل مادة بناءً على الفجوات الذرية وموعد الامتحان.
 */
async function runPlannerManager(userId, pathId) {
  try {
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V5.0 (Atomic): Calculating trajectory for User=${userId}...`);

    // ============================================================
    // 1. جلب البيانات (المواد، الامتحانات، التقدم الذري)
    // ============================================================
    const [subjectsRes, examsRes, lessonsRes, progressData] = await Promise.all([
        // أ. المواد
        supabase.from('subjects').select('id, title, coefficient').eq('path_id', safePathId),
        // ب. الامتحانات القادمة
        supabase.from('exams').select('subject_id, exam_date').gte('exam_date', new Date().toISOString()),
        // ج. كل الدروس (الهيكل)
        supabase.from('lessons').select('id, title, subject_id, order_index').order('order_index', { ascending: true }),
        // د. 🔥 التقدم الذري (بدلاً من user_progress القديم)
        getProgress(userId)
    ]);

    const subjects = subjectsRes.data || [];
    const exams = examsRes.data || [];
    const allLessons = lessonsRes.data || [];
    // 🔥 خريطة الذرات: { lessonId: { score: 80, status: 'in_progress', ... } }
    const atomicMap = progressData.atomicMap || {}; 

    if (subjects.length === 0 || allLessons.length === 0) {
        return { tasks: [{ title: "لا توجد بيانات كافية للتخطيط", type: 'fix', meta: { score: 0 } }] };
    }

    // ============================================================
    // 2. تحليل وضع كل مادة (Atomic Subject Profiling)
    // ============================================================
    const subjectProfiles = subjects.map(sub => {
        // 1. الدروس التابعة للمادة
        const subLessons = allLessons.filter(l => l.subject_id === sub.id);
        const totalLessons = subLessons.length;
        
        // 2. حساب الدروس المنجزة والمتبقية بناءً على الذرات
        // الدرس يعتبر منجزاً فقط إذا كان الـ score >= 95
        const completedCount = subLessons.filter(l => {
            const atom = atomicMap[l.id];
            return atom && atom.score >= 95;
        }).length;

        // الدروس المتبقية: إما لم تبدأ، أو بدأت ولم تكتمل
        const remainingLessons = subLessons.filter(l => {
            const atom = atomicMap[l.id];
            // متبقي إذا لم يوجد في الخريطة OR موجود وسكوره أقل من 95
            return !atom || atom.score < 95;
        });

        // 3. موعد الامتحان
         const examEntry = exams.find(e => e.subject_id === sub.id);
        let daysToExam = 999; 
        
        if (examEntry) {
            const diffTime = new Date(examEntry.exam_date) - new Date();
            daysToExam = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            if (daysToExam < 0) daysToExam = 999;
        }

        // 4. حساب معدل الحرق (Burn Rate)
        const burnRate = remainingLessons.length / (daysToExam === 999 ? 30 : Math.max(1, daysToExam));

        return {
            ...sub,
            totalLessons,
            completedCount,
            remainingLessons, 
            daysToExam,
            burnRate,
            isExamSoon: daysToExam <= 7
        };
    });

    // ============================================================
    // 3. حساب نقاط الجاذبية (Gravity Scoring)
    // ============================================================
    let prioritizedSubjects = subjectProfiles.map(sub => {
        let score = 0;

        // أ. عامل الإلحاح (Urgency)
        if (sub.daysToExam <= 3) score += 5000;
        else if (sub.daysToExam <= 7) score += 2000;
        else if (sub.daysToExam <= 14) score += 500;

        // ب. عامل الكتلة الذرية (Atomic Mass)
        // الدروس التي بدأها الطالب ولم يكملها تزيد الثقل (لأننا نريد إغلاق الحلقات المفتوحة)
        let unfinishedBonus = 0;
        sub.remainingLessons.forEach(l => {
            const atom = atomicMap[l.id];
            if (atom && atom.score > 0 && atom.score < 95) {
                unfinishedBonus += 50; // درس مفتوح = جاذبية أعلى
            }
        });

        score += (sub.remainingLessons.length * 50) + unfinishedBonus;

        // ج. عامل المعامل
        score += (sub.coefficient || 1) * 100;

        // د. عامل الحرق
        if (sub.burnRate > 1.5) score += 1000;

        return { ...sub, gravityScore: score };
    });

    // ترتيب المواد حسب الجاذبية
    prioritizedSubjects.sort((a, b) => b.gravityScore - a.gravityScore);

    // ============================================================
    // 4. استراتيجية التوزيع (The Atomic Allocator)
    // ============================================================
    const topSubject = prioritizedSubjects[0];
    let finalTasks = [];

    // دالة مساعدة لإنشاء كائن المهمة بشكل ذكي
    const createSmartTask = (lesson, baseScore, typePrefix = "") => {
        const atom = atomicMap[lesson.id];
        const currentScore = atom ? atom.score : 0;
        
        let title = "";
        let reason = "";
        
        if (currentScore === 0) {
            title = `${typePrefix}اكتشاف: ${lesson.title}`;
            reason = "new_molecule";
        } else {
            title = `${typePrefix}إتمام: ${lesson.title} (${currentScore}%)`;
            reason = "stabilize_molecule";
            baseScore += 500; // زيادة الأولوية لإنهاء ما بدأه
        }

        return {
            id: lesson.id,
            title: title,
            type: 'study',
            meta: { 
                score: baseScore, 
                subjectId: lesson.subject_id,
                relatedLessonId: lesson.id,
                relatedLessonTitle: lesson.title,
                currentMastery: currentScore,
                reason: reason
            }
        };
    };

    // 🚨 سيناريو الطوارئ (Focus Mode)
    if (topSubject.daysToExam <= 3 || topSubject.burnRate > 2.0) {
        logger.warn(`🚨 Gravity: FOCUS MODE ACTIVATED for ${topSubject.title}`);
        
        const tasksToTake = topSubject.remainingLessons.slice(0, 3);
        
        finalTasks = tasksToTake.map(l => {
            const task = createSmartTask(l, 9000, "🔥 طوارئ: ");
            task.meta.isExamPrep = true;
            task.meta.examTiming = `في ${topSubject.daysToExam} أيام`;
            return task;
        });

        if (finalTasks.length === 0) {
            finalTasks.push({
                title: `مراجعة شاملة لـ ${topSubject.title}`,
                type: 'review',
                meta: { score: 9000, subjectId: topSubject.id, isExamPrep: true }
            });
        }
    } 
    // ⚖️ سيناريو التوازن (Mix Mode)
    else {
        logger.info(`⚖️ Gravity: MIX MODE (Top: ${topSubject.title})`);
        
        // المهمة 1: درس من المادة الأهم
        if (topSubject.remainingLessons.length > 0) {
            finalTasks.push(createSmartTask(topSubject.remainingLessons[0], topSubject.gravityScore));
        }

        // المهمة 2: درس من المادة الثانية
        const secondSubject = prioritizedSubjects[1];
        if (secondSubject && secondSubject.remainingLessons.length > 0) {
            finalTasks.push(createSmartTask(secondSubject.remainingLessons[0], secondSubject.gravityScore));
        }

        // المهمة 3: مراجعة خفيفة (Spaced Repetition)
        // نختار مادة عشوائية من المواد التي فيها دروس مكتملة
        const subjectsWithCompleted = prioritizedSubjects.filter(s => s.completedCount > 0);
        if (subjectsWithCompleted.length > 0) {
            const reviewSubject = subjectsWithCompleted[Math.floor(Math.random() * subjectsWithCompleted.length)];
            finalTasks.push({
                title: `مراجعة سريعة: ${reviewSubject.title}`,
                type: 'review',
                meta: { score: 500, subjectId: reviewSubject.id }
            });
        }
    }

    return { tasks: finalTasks, source: 'Gravity_V5.0_Atomic' };

  } catch (err) {
    logger.error('Gravity V5 Critical Error:', err);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
