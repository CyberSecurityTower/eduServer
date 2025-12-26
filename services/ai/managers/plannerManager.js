
// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V3.0 (Strategic Planner)
 * الخوارزمية: تحسب "ثقل" كل مادة بناءً على موعد الامتحان وكمية الدروس المتبقية.
 */
async function runPlannerManager(userId, pathId) {
  try {
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V3.0: Calculating trajectory for User=${userId}...`);

    // ============================================================
    // 1. جلب البيانات (المواد، الامتحانات، التقدم)
    // ============================================================
    const [subjectsRes, examsRes, progressRes, lessonsRes] = await Promise.all([
        // أ. المواد
        supabase.from('subjects').select('id, title, coefficient').eq('path_id', safePathId),
        // ب. الامتحانات القادمة (من EduNexus أو الجدول)
        supabase.from('exams').select('subject_id, exam_date').gte('exam_date', new Date().toISOString()),
        // ج. تقدم المستخدم
        supabase.from('user_progress').select('lesson_id, status, mastery_score').eq('user_id', userId),
        // د. كل الدروس (لحساب الكتلة)
        supabase.from('lessons').select('id, title, subject_id, order_index').order('order_index', { ascending: true })
    ]);

    const subjects = subjectsRes.data || [];
    const exams = examsRes.data || [];
    const userProgress = progressRes.data || [];
    const allLessons = lessonsRes.data || [];

    if (subjects.length === 0 || allLessons.length === 0) {
        return { tasks: [{ title: "لا توجد بيانات كافية للتخطيط", type: 'fix', meta: { score: 0 } }] };
    }

    // ============================================================
    // 2. تحليل وضع كل مادة (Subject Profiling)
    // ============================================================
    const subjectProfiles = subjects.map(sub => {
        // 1. الدروس التابعة للمادة
        const subLessons = allLessons.filter(l => l.subject_id === sub.id);
        const totalLessons = subLessons.length;
        
        // 2. الدروس المنجزة
        const completedCount = userProgress.filter(p => 
            subLessons.some(l => l.id === p.lesson_id) && p.status === 'completed'
        ).length;

        const remainingLessons = subLessons.filter(l => 
            !userProgress.some(p => p.lesson_id === l.id && p.status === 'completed')
        );

        // 3. موعد الامتحان
         const examEntry = exams.find(e => e.subject_id === sub.id);
        let daysToExam = 999; // افتراضي بعيد جداً
        
        if (examEntry) {
            const diffTime = new Date(examEntry.exam_date) - new Date();
            daysToExam = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            
            // 🔥 الحماية الإضافية: إذا كان الامتحان اليوم أو فات، نعتبره غير موجود للأولوية
            // (إلا إذا أراد أن يقترح مراجعة ليلة الامتحان، حينها اترك الصفر)
            if (daysToExam < 0) {
                 daysToExam = 999; // نعتبره بعيداً جداً لكي لا يأخذ أولوية الطوارئ
            }
        }

        // 4. حساب معدل الحرق (Burn Rate)
        // كم درس يجب أن يدرس في اليوم لينهي المادة قبل الامتحان؟
        // نضيف 1 للأيام لتجنب القسمة على صفر
        const burnRate = remainingLessons.length / (daysToExam === 999 ? 30 : Math.max(1, daysToExam));

        return {
            ...sub,
            totalLessons,
            completedCount,
            remainingLessons, // قائمة الدروس المتبقية (مرتبة)
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
        if (sub.daysToExam <= 3) score += 5000;       // حالة طوارئ قصوى
        else if (sub.daysToExam <= 7) score += 2000;  // أسبوع الامتحان
        else if (sub.daysToExam <= 14) score += 500;  // اقترب الموعد

        // ب. عامل الكتلة (Mass) - كلما زاد ما تبقى، زاد الثقل
        score += (sub.remainingLessons.length * 50);

        // ج. عامل المعامل (Coefficient) - المواد الأساسية أهم
        score += (sub.coefficient || 1) * 100;

        // د. عامل الحرق (Burn Rate) - إذا كان المعدل عالياً جداً، نرفع الأولوية
        if (sub.burnRate > 1.5) score += 1000; // يحتاج أكثر من درس ونصف يومياً

        return { ...sub, gravityScore: score };
    });

    // ترتيب المواد حسب الجاذبية
    prioritizedSubjects.sort((a, b) => b.gravityScore - a.gravityScore);

    // ============================================================
    // 4. استراتيجية التوزيع (The Allocator)
    // ============================================================
    const topSubject = prioritizedSubjects[0];
    let finalTasks = [];

    // 🚨 سيناريو الطوارئ (Focus Mode)
    // إذا كان الامتحان قريباً جداً (أقل من 3 أيام) أو معدل الحرق عالي جداً
    if (topSubject.daysToExam <= 3 || topSubject.burnRate > 2.0) {
        logger.warn(`🚨 Gravity: FOCUS MODE ACTIVATED for ${topSubject.title}`);
        
        // نملأ الجدول كله بهذه المادة فقط
        const tasksToTake = topSubject.remainingLessons.slice(0, 3);
        
        finalTasks = tasksToTake.map(l => ({
            id: l.id,
            title: `🔥 طوارئ: ${l.title}`,
            type: 'study',
            meta: { 
                score: 9000, 
                subjectId: topSubject.id,
                isExamPrep: true,
                examTiming: `في ${topSubject.daysToExam} أيام`
            }
        }));

        // إذا لم يتبق دروس جديدة، نضع مراجعة
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
        
        // المهمة 1: درس من المادة الأهم (60% أهمية)
        if (topSubject.remainingLessons.length > 0) {
            const l = topSubject.remainingLessons[0];
            finalTasks.push({
                id: l.id,
                title: `الأولوية: ${l.title}`,
                type: 'study',
                meta: { score: topSubject.gravityScore, subjectId: topSubject.id }
            });
        }

        // المهمة 2: درس من المادة الثانية (لتنويع العقل)
        const secondSubject = prioritizedSubjects[1];
        if (secondSubject && secondSubject.remainingLessons.length > 0) {
            const l = secondSubject.remainingLessons[0];
            finalTasks.push({
                id: l.id,
                title: `تنويع: ${l.title}`,
                type: 'study',
                meta: { score: secondSubject.gravityScore, subjectId: secondSubject.id }
            });
        }

        // المهمة 3: مراجعة خفيفة أو درس ثالث
        // نختار مادة عشوائية للمراجعة (Spaced Repetition)
        const reviewSubject = prioritizedSubjects[Math.floor(Math.random() * prioritizedSubjects.length)];
        finalTasks.push({
            title: `مراجعة سريعة: ${reviewSubject.title}`,
            type: 'review',
            meta: { score: 500, subjectId: reviewSubject.id }
        });
    }

    return { tasks: finalTasks, source: 'Gravity_V3.0' };

  } catch (err) {
    logger.error('Gravity V3 Critical Error:', err);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
