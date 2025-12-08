// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V5.0 (DEBUG & RESCUE MODE)
 * هذا الإصدار مصمم لكشف سبب عودة المصفوفة فارغة.
 */
async function runPlannerManager(userId, pathId) {
  try {
    // 1. التأكد من وجود PathId
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V5 Debug: User=${userId}, Path=${safePathId}`);

    // 2. جلب الإعدادات والتقدم
    const [settingsRes, progressRes] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').maybeSingle(),
        supabase.from('user_progress').select('lesson_id, status, last_interaction, mastery_score').eq('user_id', userId)
    ]);

    const currentSemester = settingsRes.data?.value || null; // نجعله null إذا لم يوجد لتجنب الفلترة الخاطئة
    
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

    // 3. 🔥 محاولة جلب الدروس (التصحيح هنا) 🔥
    // قمنا بإزالة "!fk_subject" لأنها تسبب مشاكل إذا اختلف اسم العلاقة في الداتابيز
    const { data: lessons, error } = await supabase
      .from('lessons')
      .select(`
        id, title, subject_id, has_content, order_index,
        subjects ( id, title, coefficient, semester, path_id ) 
      `)
      .eq('subjects.path_id', safePathId)
      .order('order_index', { ascending: true });

    // 🛑 فحص الأخطاء في الجلب
    if (error) {
        logger.error('❌ Gravity DB Error:', error.message);
        // مهمة طوارئ تخبرك بالخطأ
        return { 
            tasks: [{ 
                title: "خطأ في قاعدة البيانات", 
                type: "fix", 
                meta: { displayTitle: "DB Error: " + error.message } 
            }] 
        };
    }
    
    // 🛑 فحص إذا كانت الدروس فارغة
    if (!lessons || lessons.length === 0) {
        logger.warn(`⚠️ Gravity: No lessons found for path "${safePathId}". Check your DB 'lessons' table.`);
        // مهمة طوارئ تخبرك أن المسار فارغ
        return { 
            tasks: [{ 
                title: "لا توجد دروس في هذا المسار", 
                type: "study", 
                meta: { displayTitle: "No lessons found for " + safePathId } 
            }] 
        };
    }

    console.log(`✅ Gravity: Found ${lessons.length} lessons. Processing...`);

    // 4. الخوارزمية
    let candidates = lessons.map(lesson => {
      // فلتر السداسي (متسامح جداً الآن)
      if (currentSemester && lesson.subjects?.semester) {
          const lSem = lesson.subjects.semester.toString().toLowerCase();
          const sSem = currentSemester.toString().toLowerCase();
          // إذا لم يتطابقا، نتجاوز الدرس
          if (!lSem.includes(sSem) && !sSem.includes(lSem)) return null;
      }

      let gravityScore = 100;
      let displayTitle = lesson.title;
      let taskType = 'study';
      
      const userState = progressMap.get(lesson.id);

      if (userState) {
          // إذا درسها الطالب سابقاً
          if (userState.score < 50) {
              gravityScore += 5000; // يحتاج تصحيح
              displayTitle = `تصحيح: ${lesson.title}`;
          } else {
              // ✅ هنا الحل للمراجعة اللانهائية
              // نعطي نقاطاً موجبة (10) بدلاً من سالبة، ليظهر الدرس إذا لم يوجد غيره
              gravityScore = 10; 
              taskType = 'review';
              displayTitle = `مراجعة: ${lesson.title}`;
          }
      } else {
          // درس جديد
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

    // 6. شبكة الأمان (Fallback)
    // إذا كانت المصفوفة فارغة بعد الفلترة، نأخذ أول 3 دروس من القائمة الأصلية
    if (candidates.length === 0) {
        logger.warn(`⚠️ Gravity: Filter removed all lessons. Using Fallback.`);
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: `مراجعة عامة: ${l.title}`,
            type: 'review',
            score: 5,
            meta: { relatedLessonId: l.id, relatedLessonTitle: l.title }
        }));
    }

    const finalTasks = candidates.slice(0, 3);
    return { tasks: finalTasks, source: 'Gravity_V5_Rescue' };

  } catch (err) {
    logger.error('Gravity Critical Error:', err.message);
    // مهمة طوارئ عند انهيار الكود
    return { 
        tasks: [{ 
            title: "حدث خطأ في النظام", 
            type: "fix", 
            meta: { displayTitle: "System Error" } 
        }] 
    };
  }
}

module.exports = { runPlannerManager };
