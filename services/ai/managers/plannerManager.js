// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');

async function runPlannerManager(userId, pathId = 'UAlger3_L1_ITCF') {
  try {
    console.log(`\n🔍 --- DEBUG PLANNER START for ${userId} ---`);

    // 1. جلب الإعدادات
    const { data: settings } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'current_semester')
      .single();
    const currentSemester = settings?.value || 'S1';

    // 2. جلب الفوج
    const { data: user } = await supabase
      .from('users')
      .select('group_id')
      .eq('id', userId)
      .single();

    const groupId = user?.group_id;
    console.log(`👤 User Group ID: "${groupId}"`); // هل الفوج صحيح؟

    // 3. جلب الامتحانات
    let upcomingExams = {};
    if (groupId) {
        // نبدأ من بداية اليوم لضمان التقاط امتحانات اليوم
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayISO = todayStart.toISOString();

        console.log(`📅 Searching exams for group "${groupId}" after ${todayISO}`);

        const { data: exams, error } = await supabase
            .from('exams')
            .select('subject_id, exam_date')
            .eq('group_id', groupId)
            .gte('exam_date', todayISO);

        if (error) console.error("❌ Exam Fetch Error:", error);

        if (exams && exams.length > 0) {
            console.log(`🎓 Found ${exams.length} exams:`, exams);
            exams.forEach(ex => {
                // تنظيف الـ ID من المسافات الزائدة إن وجدت
                const cleanId = ex.subject_id.trim(); 
                upcomingExams[cleanId] = new Date(ex.exam_date);
            });
        } else {
            console.log("⚠️ No exams found for this group.");
        }
    } else {
        console.log("⚠️ User has no Group ID.");
    }

    // 4. جلب الدروس
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

    // 5. حساب النقاط
    const candidates = lessons.map(lesson => {
      if (progressMap[lesson.id] === 'completed') return null;

      let score = 0;
      const subjectCoeff = lesson.subjects?.coefficient || 1;
      const subjectId = lesson.subject_id.trim(); // تنظيف الـ ID هنا أيضاً

      // A. الأساسي
      score += subjectCoeff * 10;

      // B. التسلسل
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

      // 🔥 C. فحص الامتحان 🔥
      if (upcomingExams[subjectId]) {
          console.log(`🚨 MATCH FOUND for subject: ${subjectId}! Boosting score...`);
          const examDate = upcomingExams[subjectId];
          const today = new Date();
          const diffTime = examDate - today;
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          console.log(`   -> Exam Date: ${examDate.toISOString()}, Diff Days: ${diffDays}`);

          if (diffDays <= 1) score += 5000;
          else if (diffDays <= 3) score += 2000;
          else if (diffDays <= 7) score += 500;
      } else {
          // طباعة المواد التي لم نجد لها امتحان للتأكد
           console.log(`   - No exam for subject: ${subjectId}`);
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
            score: score // لنرى السكور في الـ JSON
        }
      };
    }).filter(Boolean);

    candidates.sort((a, b) => b.score - a.score); 
    const limit = Object.keys(upcomingExams).length > 0 ? 5 : 3;
    
    console.log(`✅ Returning ${candidates.length} tasks. Top score: ${candidates[0]?.score}`);
    console.log(`🔍 --- DEBUG END ---\n`);

    return { tasks: candidates.slice(0, limit), source: 'GravityAlgorithm_V2_Debug' };

  } catch (err) {
    logger.error('Gravity Planner Error:', err.message);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
