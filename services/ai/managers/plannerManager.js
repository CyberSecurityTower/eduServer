// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');

/**
 * Cortex Gravity Engine v2.1 (Production Ready)
 * - Exam Rescue Mode: ON
 * - Debugging: OFF
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    // 1. جلب الإعدادات والفوج
    const [settingsRes, userRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single()
    ]);

    const currentSemester = settingsRes.data?.value || 'S1';
    const groupId = userRes.data?.group_id;

    // 2. جلب الامتحانات القادمة (أو التي حدثت اليوم)
    let upcomingExams = {};
    if (groupId) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const { data: exams } = await supabase
            .from('exams')
            .select('subject_id, exam_date')
            .eq('group_id', groupId)
            .gte('exam_date', todayStart.toISOString());

        if (exams) {
            exams.forEach(ex => {
                const cleanId = ex.subject_id ? ex.subject_id.trim() : '';
                if (cleanId) upcomingExams[cleanId] = new Date(ex.exam_date);
            });
        }
    }

    // 3. جلب الدروس والتقدم
    const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, prerequisites, has_content, order_index,
        subjects ( id, title, coefficient, semester ),
        user_progress ( status, mastery_score )
      `)
      .eq('subjects.path_id', pathId);

    if (error) throw error;

    const progressMap = {};
    lessons.forEach(l => {
      const prog = l.user_progress.find(p => p.user_id === userId); 
      progressMap[l.id] = prog ? prog.status : 'locked';
    });

    // 4. حساب النقاط
    const candidates = lessons.map(lesson => {
      if (progressMap[lesson.id] === 'completed') return null;

      // فلترة السداسي (اختياري)
      // if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) return null;

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;
      const subjectId = lesson.subject_id ? lesson.subject_id.trim() : '';

      // A. المعامل
      score += subjectCoeff * 10;

      // B. المتطلبات
      let prerequisitesMet = true;
      if (lesson.prerequisites && lesson.prerequisites.length > 0) {
        for (const preId of lesson.prerequisites) {
          if (progressMap[preId] !== 'completed') {
            prerequisitesMet = false;
            break;
          }
        }
      }

      if (!prerequisitesMet) return null;
      score += 50;

      // 🔥 C. وضع الطوارئ (Exam Rescue) 🔥
      if (upcomingExams[subjectId]) {
          const examDate = upcomingExams[subjectId];
          const today = new Date();
          const diffTime = examDate - today;
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays <= 1) score += 5000;      // غداً
          else if (diffDays <= 3) score += 2000; // بعد 3 أيام
          else if (diffDays <= 7) score += 500;  // بعد أسبوع
      }

      let taskTitle = lesson.title;
      if (taskTitle.length > 40) taskTitle = taskTitle.substring(0, 37) + "...";

      return {
        id: lesson.id,
        title: `درس: ${taskTitle} (${lesson.subjects?.title || 'مادة'})`, 
        type: lesson.has_content ? 'study' : 'ghost_explain',
        score: score,
        meta: {
            relatedLessonId: lesson.id,
            subjectId: subjectId, 
            lessonTitle: lesson.title,
            isExamPrep: !!upcomingExams[subjectId]
        }
      };
    }).filter(Boolean);

    // 5. الترتيب
    candidates.sort((a, b) => b.score - a.score); 
    const limit = Object.keys(upcomingExams).length > 0 ? 5 : 3;

    return { tasks: candidates.slice(0, limit), source: 'GravityAlgorithm_V2' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
