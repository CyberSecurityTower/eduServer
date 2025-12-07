// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff } = require('../../../utils');

/**
 * Cortex Gravity Engine v3.0 (Fail-Safe Edition)
 * يضمن عودة مهام دائماً حتى لو لم تكن هناك امتحانات
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    logger.info(`🪐 Gravity Engine Started for ${userId} (Path: ${pathId})`);

    // 1. جلب البيانات الأساسية
    const [settingsRes, userRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single(),
        // نجلب آخر تفاعل لنعرف الدروس التي "لمسها" الطالب
        supabase.from('user_progress').select('lesson_id, last_interaction').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || 'S1'; 
    const groupId = userRes.data?.group_id;
    
    // خريطة الدروس التي تفاعل معها الطالب (نعتبرها "جارية" أو "منجزة")
    const interactedLessons = new Set();
    if (progressRes.data) {
        progressRes.data.forEach(p => interactedLessons.add(p.lesson_id));
    }

    // 2. جلب الامتحانات (إن وجدت)
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

    // 3. جلب كل الدروس المرتبطة بالمسار
     const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, has_content, order_index,
        subjects!fk_subject ( id, title, coefficient, semester, path_id ) 
      `) // 👈 التغيير هنا: حددنا اسم العلاقة بدقة
      .eq('subjects.path_id', pathId)
      .order('order_index', { ascending: true }); // الترتيب مهم جداً

    if (error) {
        logger.error('Gravity DB Error:', error);
        return { tasks: [] };
    }

    if (!lessons || lessons.length === 0) {
        logger.warn(`⚠️ No lessons found for path: ${pathId}`);
        return { tasks: [] };
    }

    // 4. حساب النقاط (Scoring)
    let candidates = lessons.map(lesson => {
      // فلتر السداسي (اختياري: يمكن تخفيفه)
      if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) {
          return null; 
      }

      let score = 100; // نقاط أساسية
      const subjectId = lesson.subject_id ? lesson.subject_id.trim().toLowerCase() : '';

      // أ. هل تفاعل معه سابقاً؟
      // إذا تفاعل معه، نقلل النقاط قليلاً لأننا نريد اقتراح الجديد، 
      // إلا إذا كان هناك امتحان قريب فنرفع النقاط للمراجعة
      if (interactedLessons.has(lesson.id)) {
          score -= 50; 
      } else {
          // درس جديد: نعطيه أولوية حسب ترتيبه (الدروس الأولى أهم)
          score += (1000 - (lesson.order_index || 0));
      }

      // ب. الطوارئ (Exams)
      let humanExamTime = null;
      let isExamPrep = false;

      if (upcomingExams[subjectId]) {
          const examDate = new Date(upcomingExams[subjectId]);
          const now = new Date();
          const diffHours = (examDate - now) / (1000 * 60 * 60);

          if (diffHours > 0 && diffHours <= 72) { 
              score += 50000; // طوارئ قصوى
              isExamPrep = true;
          } else if (diffHours > 0 && diffHours <= 168) { 
              score += 10000; // تحضير أسبوعي
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
    }).filter(Boolean); // حذف الـ null

    // 5. الترتيب النهائي
    candidates.sort((a, b) => b.score - a.score); 

    // 🔥🔥 FALLBACK MECHANISM (شبكة الأمان) 🔥🔥
    // إذا كانت المصفوفة فارغة (مثلاً بسبب فلتر السداسي)، نجلب أي درس
    if (candidates.length === 0 && lessons.length > 0) {
        logger.warn('Gravity returned 0 tasks. Activating Fallback Mode.');
        // نأخذ أول 3 دروس من القائمة الأصلية بغض النظر عن السداسي
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: l.title,
            type: 'study',
            score: 50,
            meta: {
                relatedLessonId: l.id,
                relatedSubjectId: l.subject_id,
                lessonTitle: l.title,
                score: 50,
                isExamPrep: false
            }
        }));
    }

    // نأخذ أفضل 3 مهام
    const finalTasks = candidates.slice(0, 3);
    
    logger.info(`🏆 Gravity Generated ${finalTasks.length} tasks.`);
    return { tasks: finalTasks, source: 'Gravity_V3' };

  } catch (err) {
    logger.error('Gravity Planner Critical Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
