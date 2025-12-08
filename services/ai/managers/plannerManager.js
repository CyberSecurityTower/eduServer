// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V5.1 (Manual Join Fix)
 * حل مشكلة العلاقات المتعددة عن طريق فصل الاستعلامات.
 */
async function runPlannerManager(userId, pathId) {
  try {
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V5.1: User=${userId}, Path=${safePathId}`);

    // 1. جلب الإعدادات والتقدم
    const [settingsRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').maybeSingle(),
        supabase.from('user_progress').select('lesson_id, status, last_interaction, mastery_score').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || null;
    
    // خريطة التقدم
    const progressMap = new Map();
    if (progressRes.data) {
        progressRes.data.forEach(p => {
            progressMap.set(p.lesson_id, {
                status: p.status,
                lastInteraction: new Date(p.last_interaction),
                score: p.mastery_score || 0
            });
        });
    }

    // ============================================================
    // 🔥 الحل الجذري: فصل الاستعلام (Manual Join) 🔥
    // ============================================================

    // أ. نجلب المواد (Subjects) الخاصة بهذا المسار أولاً
    const { data: subjects, error: subjError } = await supabase
        .from('subjects')
        .select('id, title, coefficient, semester, path_id, type')
        .eq('path_id', safePathId);

    if (subjError || !subjects || subjects.length === 0) {
        logger.error('❌ Gravity: No subjects found or DB Error.', subjError?.message);
        return { tasks: [] };
    }

    // ب. ننشئ خريطة للمواد ليسهل الوصول إليها لاحقاً
    // ونستخرج قائمة الـ IDs لجلب الدروس
    const subjectsMap = {};
    const subjectIds = [];
    
    subjects.forEach(sub => {
        subjectsMap[sub.id] = sub;
        subjectIds.push(sub.id);
    });

    // ج. نجلب الدروس التي تتبع هذه المواد فقط
    const { data: lessonsRaw, error: lessonsError } = await supabase
        .from('lessons')
        .select('id, title, subject_id, has_content, order_index')
        .in('subject_id', subjectIds) // نفلتر حسب المواد التي جلبناها
        .order('order_index', { ascending: true });

    if (lessonsError) {
        logger.error('❌ Gravity: Lessons DB Error:', lessonsError.message);
        return { tasks: [] };
    }

    // د. الدمج اليدوي (Re-attach subjects to lessons)
    // لكي يبقى شكل البيانات كما يتوقعه باقي الكود والفرونت أند
    const lessons = lessonsRaw.map(l => ({
        ...l,
        subjects: subjectsMap[l.subject_id] // نضع كائن المادة هنا يدوياً
    }));

    // ============================================================
    // نهاية الحل الجذري - الباقي هو نفس الخوارزمية
    // ============================================================

    if (lessons.length === 0) {
        logger.warn(`⚠️ Gravity: No lessons found for path "${safePathId}".`);
        return { tasks: [] };
    }

    // 4. الخوارزمية
    let candidates = lessons.map(lesson => {
      // فلتر السداسي
      if (currentSemester && lesson.subjects?.semester) {
          const lSem = lesson.subjects.semester.toString().toLowerCase();
          const sSem = currentSemester.toString().toLowerCase();
          if (!lSem.includes(sSem) && !sSem.includes(lSem)) return null;
      }

      let gravityScore = 100;
      let displayTitle = lesson.title;
      let taskType = 'study';
      
      const userState = progressMap.get(lesson.id);

      if (userState) {
          if (userState.score < 50) {
              gravityScore += 5000; 
              displayTitle = `تصحيح: ${lesson.title}`;
          } else {
              // ✅ مراجعة لا نهائية (نقاط موجبة)
              gravityScore = 10; 
              taskType = 'review';
              displayTitle = `مراجعة: ${lesson.title}`;
          }
      } else {
          gravityScore += 1000;
          displayTitle = `درس جديد: ${lesson.title}`;
      }

      return {
        id: lesson.id,
        title: displayTitle,
        type: taskType,
        score: gravityScore,
        meta: {
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id,
            relatedLessonTitle: lesson.title,
            score: gravityScore,
            isExamPrep: false
        }
      };
    }).filter(Boolean);

    // 5. الترتيب
    candidates.sort((a, b) => b.score - a.score);

    // 6. Fallback
    if (candidates.length === 0) {
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: `مراجعة عامة: ${l.title}`,
            type: 'review',
            score: 5,
            meta: { relatedLessonId: l.id, relatedLessonTitle: l.title }
        }));
    }

    const finalTasks = candidates.slice(0, 3);
    logger.success(`🏆 Gravity V5.1 Generated ${finalTasks.length} tasks.`);
    
    return { tasks: finalTasks, source: 'Gravity_V5.1_ManualJoin' };

  } catch (err) {
    logger.error('Gravity Critical Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
