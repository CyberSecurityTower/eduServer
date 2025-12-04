// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');

/**
 * Cortex Gravity Engine v2.0 (Exam Rescue Mode)
 * يقوم بحساب ثقل كل درس بناءً على المعامل، المتطلبات، وموعد الامتحان.
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    // 1. جلب الإعدادات العامة (لمعرفة السداسي الحالي)
    const { data: settings } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'current_semester')
      .single();
    
    const currentSemester = settings?.value || 'S1';

    // 2. جلب بيانات المستخدم لمعرفة فوجه (Group ID)
    const { data: user } = await supabase
      .from('users')
      .select('group_id')
      .eq('id', userId)
      .single();

    const groupId = user?.group_id;

    // 3. جلب جدول الامتحانات لهذا الفوج (إن وجد)
    let upcomingExams = {};
    if (groupId) {
        const now = new Date().toISOString();
        const { data: exams } = await supabase
            .from('exams')
            .select('subject_id, exam_date')
            .eq('group_id', groupId)
            .gte('exam_date', now); // نجلب الامتحانات المستقبلية فقط

        if (exams) {
            exams.forEach(ex => {
                // نخزن التاريخ لنحسب الفرق لاحقاً
                upcomingExams[ex.subject_id] = new Date(ex.exam_date);
            });
        }
    }

    // 4. جلب الدروس + المواد + تقدم الطالب
    const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, prerequisites, has_content, order_index,
        subjects ( id, title, coefficient, semester ),
        user_progress ( status, mastery_score )
      `)
      .eq('subjects.path_id', pathId);

    if (error) throw error;

    // تحويل التقدم إلى Map لسرعة البحث
    const progressMap = {};
    lessons.forEach(l => {
      const prog = l.user_progress.find(p => p.user_id === userId); 
      progressMap[l.id] = prog ? prog.status : 'locked';
    });

    // 5. حساب النقاط (The Scoring Loop v2)
    const candidates = lessons.map(lesson => {
      // إذا الدرس مكتمل، لا نريده
      if (progressMap[lesson.id] === 'completed') return null;

      // فلترة حسب السداسي الحالي (اختياري: يمكنك تعطيل هذا السطر إذا أردت إظهار كل شيء)
      if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) {
          return null; 
      }

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;
      const subjectId = lesson.subject_id;

      // A. عامل الثقل الأساسي (المعامل)
      score += subjectCoeff * 10;

      // B. عامل التسلسل (Sequence)
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
        return null; // مغلق
      } else {
        score += 50; // متاح
      }

      // 🔥 C. عامل الطوارئ (Exam Rescue Factor) 🔥
      if (upcomingExams[subjectId]) {
          const examDate = upcomingExams[subjectId];
          const today = new Date();
          const diffTime = examDate - today;
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays <= 1) {
              score += 5000; // 🚨 حالة طوارئ قصوى (غداً الامتحان)
          } else if (diffDays <= 3) {
              score += 2000; // ⚠️ اقترب الموعد
          } else if (diffDays <= 7) {
              score += 500;  // 📅 بقي أسبوع
          }
      }

      // تنسيق العنوان
      let taskTitle = lesson.title;
      if (taskTitle.length > 40) taskTitle = taskTitle.substring(0, 37) + "...";

      return {
        id: lesson.id,
        title: `درس: ${taskTitle} (${lesson.subjects?.title || 'مادة'})`, 
        subjectTitle: lesson.subjects?.title,
        type: lesson.has_content ? 'study' : 'ghost_explain',
        score: score,
        meta: {
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id, 
            relatedLessonTitle: lesson.title,
            isExamPrep: !!upcomingExams[subjectId] // علامة للفرونت أند
        }
      };
    }).filter(Boolean);

    // 6. الترتيب واختيار الأفضل
    candidates.sort((a, b) => b.score - a.score); 
    
    // في وقت الامتحانات، نعرض مهام أكثر (مثلاً 5 بدلاً من 3)
    const limit = Object.keys(upcomingExams).length > 0 ? 5 : 3;
    const topTasks = candidates.slice(0, limit);

    return { tasks: topTasks, source: 'GravityAlgorithm_V2' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
