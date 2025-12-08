// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V4.5 (Infinite Loop Mode)
 * التعديلات:
 * 1. إصلاح مشكلة المصفوفة الفارغة.
 * 2. اقتراح مراجعة الدروس القديمة حتى لو كانت مكتملة (نقاط موجبة بدل سالبة).
 * 3. تخفيف قيود السداسي (Semester) لتجنب الفلترة الخاطئة.
 */
async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    logger.info(`🪐 Gravity Engine V4.5 Started for ${userId} (Path: ${pathId})`);

    // 1. جلب البيانات الغنية (Rich Data Fetching)
    const [settingsRes, userRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        supabase.from('users').select('group_id').eq('id', userId).single(),
        supabase.from('user_progress').select('lesson_id, status, last_interaction, mastery_score').eq('user_id', userId)
    ]);

    // تنظيف السداسي (مثلاً تحويل "Semester 1" إلى "S1" للمقارنة)
    let currentSemester = settingsRes.data?.value || 'S1'; 
    const groupId = userRes.data?.group_id;
    
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

    // 2. جلب الامتحانات (Intel Gathering)
    let examEvents = {};
    if (groupId) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1); 
        
        const { data: exams } = await supabase
            .from('exams')
            .select('subject_id, exam_date')
            .eq('group_id', groupId)
            .gte('exam_date', yesterday.toISOString());

        if (exams) {
            exams.forEach(ex => {
                const cleanId = ex.subject_id ? ex.subject_id.trim().toLowerCase() : '';
                if (cleanId) examEvents[cleanId] = new Date(ex.exam_date);
            });
        }
    }

    // 3. الوقت البيولوجي
    const timeCtx = getAlgiersTimeContext();
    const currentHour = timeCtx.hour;
    const isDeepWorkTime = (currentHour >= 5 && currentHour <= 12); 

    // 4. جلب الدروس (مع التحقق من وجود بيانات)
     const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, has_content, order_index,
        subjects!fk_subject ( id, title, coefficient, semester, path_id, type ) 
      `)
      .eq('subjects.path_id', pathId)
      .order('order_index', { ascending: true });

    if (error) {
        logger.error('Gravity DB Error:', error.message);
        return { tasks: [] };
    }
    
    if (!lessons || lessons.length === 0) {
        logger.warn(`⚠️ Gravity: No lessons found for path ${pathId}`);
        return { tasks: [] };
    }

    // 5. 🧠 الخوارزمية المركزية
    let candidates = lessons.map(lesson => {
      // 🛡️ فلتر السداسي (مرن أكثر)
      // إذا كان الدرس لديه سداسي محدد والنظام لديه سداسي محدد، وهما مختلفان -> تجاهل
      // لكن نستخدم includes بدلاً من المطابقة التامة لتجنب مشاكل مثل "S1" vs "Semester 1"
      if (lesson.subjects?.semester && currentSemester) {
          const lessonSem = lesson.subjects.semester.trim().toUpperCase(); // S1
          const sysSem = currentSemester.trim().toUpperCase(); // S1
          
          if (!lessonSem.includes(sysSem) && !sysSem.includes(lessonSem)) {
              return null; 
          }
      }

      let gravityScore = 100; // نقاط البداية
      let taskType = 'new';   
      let displayTitle = lesson.title;
      
      const subjectId = lesson.subject_id ? lesson.subject_id.trim().toLowerCase() : '';
      const userState = progressMap.get(lesson.id);

      // --- العامل 1: الحالة السابقة (History) ---
      if (userState) {
          const daysSince = (Date.now() - userState.lastInteraction) / (1000 * 60 * 60 * 24);
          
          if (userState.score < 50) {
              // 🚨 ضعيف جداً -> أولوية قصوى
              gravityScore += 5000; 
              taskType = 'fix';
              displayTitle = `تصحيح مسار: ${lesson.title}`;
          } else if (daysSince > 3 && daysSince < 7) {
              // 🔄 مراجعة دورية
              gravityScore += 2000;
              taskType = 'review';
              displayTitle = `مراجعة: ${lesson.title}`;
          } else if (daysSince >= 7) {
              // 🧠 استرجاع (نسيان)
              gravityScore += 4000;
              taskType = 'review';
              displayTitle = `استرجاع ذاكرة: ${lesson.title}`;
          } else {
              // ✅ تم إنجازه حديثاً (هنا كان الخلل)
              // بدلاً من جعله سالباً (-5000) وإخفائه، نعطيه نقاطاً منخفضة لكن موجبة
              // ليظهر في القائمة إذا لم يكن هناك غيره
              gravityScore = 10; // نقاط قليلة جداً
              taskType = 'review'; // نعتبره مراجعة إضافية
              displayTitle = `تثبيت معلومات: ${lesson.title}`;
          }
      } else {
          // درس جديد
          gravityScore += 1000; 
          gravityScore += (500 - (lesson.order_index || 0)); // ترتيب الدروس
          displayTitle = `درس جديد: ${lesson.title}`;
      }

      // --- العامل 2: الامتحانات ---
      let humanExamTime = null;
      let isExamPrep = false;
      
      if (examEvents[subjectId]) {
          const examDate = new Date(examEvents[subjectId]);
          const now = new Date();
          const diffHours = (examDate - now) / (1000 * 60 * 60);

          if (diffHours > 0 && diffHours <= 72) { 
              gravityScore += 100000; // أولوية قصوى
              isExamPrep = true;
              displayTitle = `🔥 طوارئ امتحان: ${lesson.title}`;
          } 
          else if (diffHours <= 0 && diffHours > -48) { 
              gravityScore += 5000; 
              taskType = 'review'; 
              displayTitle = `تصحيح موضوع: ${lesson.title}`;
          }
          humanExamTime = getHumanTimeDiff(examDate);
      }

      // --- العامل 3: الوقت البيولوجي ---
      const coeff = lesson.subjects?.coefficient || 1;
      if (isDeepWorkTime && coeff >= 3) {
          gravityScore += 500;
      } 

      return {
        id: lesson.id,
        title: displayTitle,
        type: taskType === 'new' ? 'study' : 'review',
        score: gravityScore,
        meta: {
            relatedLessonId: lesson.id,
            relatedSubjectId: lesson.subject_id,
            relatedLessonTitle: lesson.title, // العنوان الأصلي مهم
            score: gravityScore,
            isExamPrep: isExamPrep,
            examTiming: humanExamTime,
            mastery: userState?.score || 0
        }
      };
    }).filter(Boolean); // حذف الـ nulls

    // 6. الترتيب النهائي
    candidates.sort((a, b) => b.score - a.score); 

    // 7. Fallback (شبكة الأمان القصوى)
    // إذا كانت المصفوفة فارغة تماماً (بسبب فلتر السداسي مثلاً)، نجلب أي درس عشوائي
    if (candidates.length === 0 && lessons.length > 0) {
        logger.warn(`⚠️ Gravity: Candidates empty after filter. Using fallback.`);
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: `مراجعة عامة: ${l.title}`,
            type: 'review',
            score: 5,
            meta: { relatedLessonId: l.id, relatedLessonTitle: l.title, isExamPrep: false }
        }));
    }

    // نأخذ أفضل 3 مهام
    const finalTasks = candidates.slice(0, 3);
    
    logger.success(`🏆 Gravity V4.5 generated ${finalTasks.length} tasks for ${userId}. Top: ${finalTasks[0]?.title}`);
    return { tasks: finalTasks, source: 'Gravity_V4.5' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    // إرجاع مصفوفة فارغة في حالة الخطأ الكارثي فقط
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
