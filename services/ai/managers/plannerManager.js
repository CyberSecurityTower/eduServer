// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V4.0 (GOD MODE)
 * Features: SRS, Time-Awareness, Weakness Targeting, Smart Labeling.
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    logger.info(`🪐 Gravity Engine V4 (God Mode) Started for ${userId}`);

    // 1. جلب البيانات الغنية (Rich Data Fetching)
    const [settingsRes, userRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single(),
        // نجلب: الحالة، آخر تفاعل، ونقاط الإتقان
        supabase.from('user_progress').select('lesson_id, status, last_interaction, mastery_score').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || 'S1'; 
    const groupId = userRes.data?.group_id;
    
    // خريطة ذكية للتقدم
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

    // 2. جلب الامتحانات (Intel Gathering) - تعديل لجلب الماضي والمستقبل
    let examEvents = {}; // نغير الاسم ليكون أشمل
    if (groupId) {
        // نجلب الامتحانات من "أمس" وحتى المستقبل
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1); 
        
        const { data: exams } = await supabase
            .from('exams')
            .select('subject_id, exam_date')
            .eq('group_id', groupId)
            .gte('exam_date', yesterday.toISOString()); // نعدل الشرط ليشمل الماضي القريب جداً

        if (exams) {
            exams.forEach(ex => {
                const cleanId = ex.subject_id ? ex.subject_id.trim().toLowerCase() : '';
                if (cleanId) examEvents[cleanId] = new Date(ex.exam_date);
            });
        }
    }
    // 3. تحليل الوقت البيولوجي (Bio-Rhythm)
    const timeCtx = getAlgiersTimeContext();
    const currentHour = timeCtx.hour;
    // هل الوقت مناسب للمواد الثقيلة (صباحاً) أم الخفيفة (مساءً)؟
    const isDeepWorkTime = (currentHour >= 5 && currentHour <= 12); 

    // 4. جلب الدروس
     const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, has_content, order_index,
        subjects!fk_subject ( id, title, coefficient, semester, path_id, type ) 
      `)
      .eq('subjects.path_id', pathId)
      .order('order_index', { ascending: true });

    if (error || !lessons) return { tasks: [] };

    // 5. 🧠 الخوارزمية المركزية (The Core Algorithm)
    let candidates = lessons.map(lesson => {
      // فلتر السداسي
      if (lesson.subjects?.semester && lesson.subjects.semester !== currentSemester) return null;

      let gravityScore = 100; // نقاط البداية
      let taskType = 'new';   // new | review | fix
      let displayTitle = lesson.title;
      
      const subjectId = lesson.subject_id ? lesson.subject_id.trim().toLowerCase() : '';
      const userState = progressMap.get(lesson.id);

      // --- العامل 1: الحالة السابقة (The History Factor) ---
      if (userState) {
          const daysSince = (Date.now() - userState.lastInteraction) / (1000 * 60 * 60 * 24);
          
          if (userState.score < 50) {
              // 🚨 حالة طوارئ: الطالب ضعيف في هذا الدرس
              gravityScore += 5000; 
              taskType = 'fix';
              displayTitle = `تصحيح مسار: ${lesson.title}`;
          } else if (daysSince > 3 && daysSince < 7) {
              // 🔄 تكرار متباعد (Spaced Repetition) - مراجعة خفيفة
              gravityScore += 2000;
              taskType = 'review';
              displayTitle = `مراجعة: ${lesson.title}`;
          } else if (daysSince >= 7) {
              // 🧠 تكرار متباعد - مراجعة عميقة (النسيان بدأ)
              gravityScore += 4000;
              taskType = 'review';
              displayTitle = `استرجاع ذاكرة: ${lesson.title}`;
          } else {
              // تمت دراسته قريباً وبدرجة جيدة -> نخفض الأولوية جداً
              gravityScore -= 5000;
              taskType = 'done';
          }
      } else {
          // درس جديد كلياً
          gravityScore += 1000; // نفضل الجديد
          // نضيف نقاط الترتيب (الدروس الأولى أولى)
          gravityScore += (500 - (lesson.order_index || 0));
          displayTitle = `درس جديد: ${lesson.title}`;
      }

      // --- العامل 2: الامتحانات (The Exam Factor) ---
      let humanExamTime = null;
      let isExamPrep = false;
      
      if (examEvents[subjectId]) {
          const examDate = new Date(examEvents[subjectId]);
          const now = new Date();
          const diffHours = (examDate - now) / (1000 * 60 * 60);

          // A. امتحان قادم (Future)
          if (diffHours > 0 && diffHours <= 72) { 
              gravityScore += 100000; 
              isExamPrep = true;
              displayTitle = `🔥 طوارئ امتحان: ${lesson.title}`;
          } 
          // B. امتحان فات للتو (Past - Post Exam) ✅ الإضافة الجديدة
          else if (diffHours <= 0 && diffHours > -48) { 
              // الامتحان فات منذ أقل من 48 ساعة
              gravityScore += 5000; // أولوية متوسطة
              taskType = 'review'; // نوع المهمة مراجعة/تصحيح
              displayTitle = `تصحيح موضوع: ${lesson.title}`; // نغير العنوان
          }
          
          humanExamTime = getHumanTimeDiff(examDate);
      }

      // --- العامل 3: الوقت البيولوجي (Bio-Rhythm Factor) ---
      // إذا كان الصباح، نرفع سكور المواد الأساسية (المعامل العالي)
      const coeff = lesson.subjects?.coefficient || 1;
      if (isDeepWorkTime && coeff >= 3) {
          gravityScore += 500;
      } 
      // إذا كان الليل، نرفع سكور المراجعة
      else if (!isDeepWorkTime && taskType === 'review') {
          gravityScore += 500;
      }

      return {
        id: lesson.id,
        title: displayTitle, // ✅ العنوان الذكي
        type: taskType === 'new' ? 'study' : 'review',
        score: gravityScore,
        meta: {
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id,
            lessonTitle: lesson.title, // العنوان الأصلي
            displayTitle: displayTitle, // العنوان المعدل
            score: gravityScore,
            isExamPrep: isExamPrep,
            examTiming: humanExamTime,
            mastery: userState?.score || 0
        }
      };
    }).filter(Boolean);

    // 6. الترتيب النهائي
    candidates.sort((a, b) => b.score - a.score); 

    // 7. Fallback (شبكة الأمان)
    if (candidates.length === 0 && lessons.length > 0) {
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: `استكشاف: ${l.title}`,
            type: 'study',
            score: 50,
            meta: { relatedLessonId: l.id, isExamPrep: false }
        }));
    }

    // نأخذ أفضل 3 مهام
    const finalTasks = candidates.slice(0, 3);
    
    logger.success(`🏆 Gravity V4 generated tasks for ${userId}. Top: ${finalTasks[0]?.title}`);
    return { tasks: finalTasks, source: 'Gravity_V4_GodMode' };

  } catch (err) {
    logger.error('Gravity Planner V4 Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
