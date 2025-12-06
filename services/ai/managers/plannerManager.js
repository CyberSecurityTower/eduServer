// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
// 👇 1. التأكد من استيراد الدالة هنا
const { getHumanTimeDiff } = require('../../../utils');

/**
 * Cortex Gravity Engine v2.3 (Updated: Added Human Exam Timing)
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    logger.info(`🪐 Gravity Engine Started for ${userId} (Path: ${pathId})`);

    // 1. جلب الإعدادات، الفوج، والتقدم
    const [settingsRes, userRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single(),
        // 🔥 جلب التقدم بشكل منفصل لضمان الدقة
        supabase.from('user_progress').select('lesson_id, status').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || 'S1'; 
    const groupId = userRes.data?.group_id;
    
    // خريطة الدروس المكتملة (Set للسرعة)
    const completedLessons = new Set();
    if (progressRes.data) {
        progressRes.data.forEach(p => {
            if (p.status === 'completed') completedLessons.add(p.lesson_id);
        });
    }

    // 2. جلب الامتحانات القادمة
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
                // 🔥 تنظيف الـ ID لضمان التطابق
                const cleanId = ex.subject_id ? ex.subject_id.trim().toLowerCase() : '';
                if (cleanId) upcomingExams[cleanId] = new Date(ex.exam_date);
            });
        }
    }

    console.log("📅 Upcoming Exams Map:", upcomingExams);

    // 3. جلب الدروس
     const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, prerequisites, has_content, order_index,
        subjects!subject_id ( id, title, coefficient, semester ) 
      `)
      .eq('subjects.path_id', pathId);

    if (error) throw error;

    // 4. حساب النقاط (Gravity Calculation)
    const candidates = lessons.map(lesson => {
      // 🛑 الفلتر الأول: هل الدرس مكتمل؟
      if (completedLessons.has(lesson.id)) {
          return null;
      }

      // 🛑 الفلتر الثاني: هل هو في السداسي الحالي؟
      if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) {
          return null; 
      }

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;
      // 🔥 تنظيف الـ ID للمقارنة
      const subjectId = lesson.subject_id ? lesson.subject_id.trim().toLowerCase() : '';

      // A. المعامل (Base Score)
      score += subjectCoeff * 10;

      // B. الترتيب (الدروس الأولى أهم)
      score += (100 - (lesson.order_index || 0));

      // C. المتطلبات (Prerequisites)
      let prerequisitesMet = true;
      if (lesson.prerequisites && lesson.prerequisites.length > 0) {
        for (const preId of lesson.prerequisites) {
          if (!completedLessons.has(preId)) {
            prerequisitesMet = false;
            break;
          }
        }
      }
      if (!prerequisitesMet) return null; // لا يمكن دراسته الآن
      score += 50; // بونص لأن الطريق مفتوح

      // 🔥 D. وضع الطوارئ (Exam Rescue) 🔥
      let humanExamTime = null;

      if (upcomingExams[subjectId]) {
          const examDate = new Date(upcomingExams[subjectId]);
          const now = new Date();
          const diffHours = (examDate - now) / (1000 * 60 * 60);

          // 👇 التغيير هنا: درنا 0 عوض -5
          // معناها: إذا فات وقت الامتحان (أصبح بالسالب)، خلاص لم تعد هناك طوارئ
          if (diffHours > 0 && diffHours <= 48) { 
              score += 10000; // طوارئ حقيقية (المستقبل)
          } else if (diffHours <= 168 && diffHours > 0) { 
              score += 2000; // تحضير عادي
          }

          // 👇 هذا السطر مهم جداً: نمرر الوقت البشري للميتا
          humanExamTime = getHumanTimeDiff(examDate);
      }

      return {
        id: lesson.id,
        title: `درس: ${lesson.title}`, 
        type: lesson.has_content ? 'study' : 'ghost_explain',
        score: score,
        meta: {
          
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id, // Original ID
            relatedLessonTitle: lesson.title,    // Legacy support
            lessonTitle: lesson.title,           // Requested Format
            score: score,                        // Requested Format
            isExamPrep: (diffHours > 0),
            examTiming: humanExamTime            // 👈 النص الجاهز (مثلاً: "غدوة")
        }
      };
    }).filter(Boolean);

    // 5. الترتيب النهائي
    candidates.sort((a, b) => b.score - a.score); 
    
    // طباعة الفائز الأول للتأكد
    if (candidates.length > 0) {
        console.log(`🏆 Top Task: ${candidates[0].title} (Score: ${candidates[0].score})`);
    }

    return { tasks: candidates.slice(0, 5), source: 'GravityAlgorithm_V2.3' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
