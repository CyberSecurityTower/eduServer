// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');

/**
 * Cortex Gravity Engine v1.0
 * يقوم بحساب ثقل كل درس بناءً على المعامل والمتطلبات.
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    // 1. جلب كل البيانات المطلوبة دفعة واحدة (Join Query)
    // نجلب الدروس + المواد + تقدم الطالب
    const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, prerequisites, has_content, order_index,
        subjects ( id, title, coefficient ),
        user_progress ( status, mastery_score )
      `)
      .eq('subjects.path_id', pathId); // تأكد من وجود path_id في جدول subjects

    if (error) throw error;

    // تحويل التقدم إلى Map لسرعة البحث
    const progressMap = {};
    lessons.forEach(l => {
      // user_progress يعود كمصفوفة، نأخذ العنصر الخاص بالمستخدم الحالي (يجب فلترته في الكويري أو هنا)
      // ملاحظة: الأفضل فلترته في الكويري، لكن للتبسيط هنا:
      const prog = l.user_progress.find(p => p.user_id === userId); 
      progressMap[l.id] = prog ? prog.status : 'locked';
    });

    // 2. حساب النقاط (The Scoring Loop)
    const candidates = lessons.map(lesson => {
      // إذا الدرس مكتمل، لا نريده في مهام اليوم (في الـ MVP)
      if (progressMap[lesson.id] === 'completed') return null;

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;

      // A. عامل الثقل (Weight Factor)
      score += subjectCoeff * 10;

      // B. عامل التسلسل (Sequence Factor)
      let prerequisitesMet = true;
      if (lesson.prerequisites && lesson.prerequisites.length > 0) {
        for (const preId of lesson.prerequisites) {
          if (progressMap[preId] !== 'completed') {
            prerequisitesMet = false;
            break;
          }
        }
      }

      if (!prerequisitesMet) {
        return null; // الدرس مغلق لأن المتطلبات غير مكتملة
      } else {
        score += 100; // دفعة قوية لأن الدرس متاح الآن
      }

      // C. عامل الحالة (State Factor) - المعلم الشبح
      // حتى لو لم يكن هناك محتوى، نظهره لأن الـ AI سيشرحه
      
      return {
        id: lesson.id,
        title: lesson.title,
        subjectTitle: lesson.subjects?.title,
        type: lesson.has_content ? 'study' : 'ghost_explain', // نوع جديد للمهمة
        score: score,
        relatedLessonId: lesson.id
      };
    }).filter(Boolean); // إزالة القيم null

    // 3. الترتيب واختيار الأفضل
    candidates.sort((a, b) => b.score - a.score); // الأعلى سكور أولاً
    const topTasks = candidates.slice(0, 3); // نأخذ أهم 3 مهام

    return { tasks: topTasks, source: 'GravityAlgorithm' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
