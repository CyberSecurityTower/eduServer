// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff } = require('../../../utils');

async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    logger.info(`🪐 Gravity Engine Started for ${userId}`);

    // 1. جلب البيانات
    const [settingsRes, userRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single(),
        supabase.from('user_progress').select('lesson_id, status').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || 'S1'; 
    const groupId = userRes.data?.group_id;
    
    const completedLessons = new Set();
    if (progressRes.data) {
        progressRes.data.forEach(p => {
            if (p.status === 'completed') completedLessons.add(p.lesson_id);
        });
    }

    // 2. جلب الامتحانات (اختياري)
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
                const cleanId = ex.subject_id ? ex.subject_id.trim().toLowerCase() : '';
                if (cleanId) upcomingExams[cleanId] = new Date(ex.exam_date);
            });
        }
    }

    // 3. جلب كل الدروس
     const { data: lessons } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, prerequisites, has_content, order_index,
        subjects!subject_id ( id, title, coefficient, semester ) 
      `)
      .eq('subjects.path_id', pathId)
      .order('order_index', { ascending: true }); // ترتيب تسلسلي

    if (!lessons) return { tasks: [] };

    // 4. تصفية وحساب النقاط
    let candidates = lessons.map(lesson => {
      // تجاهل المكتمل
      if (completedLessons.has(lesson.id)) return null;
      // تجاهل السداسي الخطأ (إلا إذا كان استدراك)
      if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) return null;

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;
      const subjectId = lesson.subject_id ? lesson.subject_id.trim().toLowerCase() : '';

      // Base Score
      score += subjectCoeff * 10;
      
      // الترتيب التسلسلي (الدروس الأولى لها أولوية أعلى قليلاً بشكل طبيعي)
      score += (1000 - (lesson.order_index || 0));

      // المتطلبات
      if (lesson.prerequisites && lesson.prerequisites.length > 0) {
        const unmet = lesson.prerequisites.some(preId => !completedLessons.has(preId));
        if (unmet) return null; // مغلق
      }

      // Gravity (Exams)
      let humanExamTime = null;
      let isExamPrep = false;
      if (upcomingExams[subjectId]) {
          const examDate = new Date(upcomingExams[subjectId]);
          const now = new Date();
          const diffHours = (examDate - now) / (1000 * 60 * 60);

          if (diffHours > 0 && diffHours <= 72) { // خلال 3 أيام
              score += 50000; // أولوية قصوى
              isExamPrep = true;
          } else if (diffHours > 0 && diffHours <= 168) { // خلال أسبوع
              score += 10000;
              isExamPrep = true;
          }
          humanExamTime = getHumanTimeDiff(examDate);
      }

      return {
        id: lesson.id,
        title: lesson.title,
        type: lesson.has_content ? 'study' : 'ghost_explain',
        score: score,
        meta: {
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id,
            lessonTitle: lesson.title,
            score: score,
            isExamPrep: isExamPrep,
            examTiming: humanExamTime
        }
      };
    }).filter(Boolean);

    // 5. الترتيب والقص
    candidates.sort((a, b) => b.score - a.score); 

    // 🔥 Fallback Logic (الحل لمشكلة الخطط الفارغة)
    // إذا لم نجد مهام "جاذبية" كافية، نملأ الفراغ بالدروس المتاحة التالية
    if (candidates.length < 3) {
        const existingIds = new Set(candidates.map(c => c.id));
        
        // البحث عن دروس لم تكتمل ولم تضف بعد
        const fillers = lessons
            .filter(l => !completedLessons.has(l.id) && !existingIds.has(l.id))
            .slice(0, 3 - candidates.length)
            .map(l => ({
                id: l.id,
                title: l.title,
                type: 'study',
                score: 100, // سكور عادي
                meta: {
                    relatedLessonId: l.id,
                    relatedSubjectId: l.subject_id,
                    lessonTitle: l.title,
                    score: 100,
                    isExamPrep: false
                }
            }));
            
        candidates = [...candidates, ...fillers];
    }

    return { tasks: candidates.slice(0, 5), source: 'Gravity_V2.5_WithFallback' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
