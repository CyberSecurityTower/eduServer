// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V5.2 (Final Fix)
 * - تم إزالة العمود 'type' المسبب للمشاكل.
 * - إضافة نظام إبلاغ عن الأخطاء داخل التطبيق.
 */
async function runPlannerManager(userId, pathId) {
  try {
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V5.2: User=${userId}, Path=${safePathId}`);

    // 1. جلب الإعدادات والتقدم
    const [settingsRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').maybeSingle(),
        supabase.from('user_progress').select('lesson_id, status, last_interaction, mastery_score').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || null;
    
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
    // 🔥 الخطوة أ: جلب المواد (بدون عمود type) 🔥
    // ============================================================
    const { data: subjects, error: subjError } = await supabase
        .from('subjects')
        .select('id, title, coefficient, semester, path_id') // ✅ تم حذف 'type'
        .eq('path_id', safePathId);

    // 🛑 كشف الأخطاء وإرسالها للتطبيق
    if (subjError) {
        logger.error('❌ Gravity Subject Error:', subjError.message);
        return { 
            tasks: [{ 
                title: `خطأ تقني: ${subjError.message}`, 
                type: 'fix', 
                meta: { score: 9999, displayTitle: "DB Error" } 
            }] 
        };
    }

    if (!subjects || subjects.length === 0) {
        return { 
            tasks: [{ 
                title: `تنبيه: لا توجد مواد في المسار ${safePathId}`, 
                type: 'fix', 
                meta: { score: 9999 } 
            }] 
        };
    }

    // ب. تحضير خريطة المواد
    const subjectsMap = {};
    const subjectIds = [];
    subjects.forEach(sub => {
        subjectsMap[sub.id] = sub;
        subjectIds.push(sub.id);
    });

    // ============================================================
    // 🔥 الخطوة ج: جلب الدروس 🔥
    // ============================================================
    const { data: lessonsRaw, error: lessonsError } = await supabase
        .from('lessons')
        .select('id, title, subject_id, has_content, order_index')
        .in('subject_id', subjectIds)
        .order('order_index', { ascending: true });

    if (lessonsError) {
        logger.error('❌ Gravity Lessons Error:', lessonsError.message);
        return { 
            tasks: [{ 
                title: `خطأ في الدروس: ${lessonsError.message}`, 
                type: 'fix', 
                meta: { score: 9999 } 
            }] 
        };
    }

    // د. الدمج اليدوي
    const lessons = lessonsRaw.map(l => ({
        ...l,
        subjects: subjectsMap[l.subject_id]
    }));

    if (lessons.length === 0) {
        return { 
            tasks: [{ 
                title: "لا توجد دروس مسجلة بعد", 
                type: 'study', 
                meta: { score: 100 } 
            }] 
        };
    }

    // 4. الخوارزمية (مع المراجعة اللانهائية)
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
              // ✅ مراجعة لا نهائية: نقاط موجبة (10) لتظهر في القائمة
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
    logger.success(`🏆 Gravity V5.2 Generated ${finalTasks.length} tasks.`);
    
    return { tasks: finalTasks, source: 'Gravity_V5.2' };

  } catch (err) {
    logger.error('Gravity Critical Error:', err.message);
    return { 
        tasks: [{ 
            title: `خطأ نظام: ${err.message}`, 
            type: 'fix', 
            meta: { score: 9999 } 
        }] 
    };
  }
}

module.exports = { runPlannerManager };
