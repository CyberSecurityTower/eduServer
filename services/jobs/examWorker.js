// services/jobs/examWorker.js
'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');
const { extractTextFromResult, getHumanTimeDiff } = require('../../utils');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

function initExamWorker(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Exam Worker Initialized.');
}

async function checkExamTiming() {
  try {
    const now = new Date();
    const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(); 
    const endTime = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

    const { data: exams, error } = await supabase
      .from('exams')
      .select('id, subject_id, exam_date, group_id, subjects(title)')
      .gte('exam_date', startTime)
      .lte('exam_date', endTime);

    if (error) {
        logger.error('ExamWorker DB Error:', error.message);
        return;
    }
    
    if (!exams || exams.length === 0) return;

    for (const exam of exams) {
      const examTime = new Date(exam.exam_date);
      const diffMs = examTime - now;
      const diffMinutes = Math.floor(diffMs / (1000 * 60)); 

      // 👇 طباعة للمراقبة (Debug Log)
      console.log(`🔎 Exam: ${exam.subjects?.title} | Time: ${examTime.toISOString()} | Diff: ${diffMinutes} mins`);

      // =================================================================
      // 🧹 1. المكنسة الذكية
      // =================================================================
      // ⚠️ تعديل مؤقت للتجربة: جعلناها 60 دقيقة لكي تحذف المهمة الآن
      // القيمة الطبيعية يجب أن تكون 15 أو 20
      if (diffMinutes <= 60) { 
         console.log(`🧹 Triggering cleanup for ${exam.subjects?.title}...`);
         await cleanupExamTasks(exam.group_id, exam.subject_id);
      }

      // =================================================================
      // 🔔 2. نظام الإشعارات
      // =================================================================
      let notificationType = null;

      if (diffMinutes >= 45 && diffMinutes <= 75) notificationType = 'pre_exam';
      else if (diffMinutes >= -135 && diffMinutes <= -105) notificationType = 'post_exam';

      if (notificationType) {
        const { data: students } = await supabase
            .from('users')
            .select('id, first_name')
            .eq('group_id', exam.group_id);
            
        if (students && students.length > 0) {
          await Promise.all(students.map(student => 
            processStudentNotification(student, exam, notificationType)
          ));
        }
      }
    }

  } catch (err) {
    logger.error('Exam Worker Critical Error:', err.message);
  }
}

async function cleanupExamTasks(groupId, subjectId) {
  try {
    const { data: students } = await supabase.from('users').select('id').eq('group_id', groupId);
    if (!students || students.length === 0) return;

    const studentIds = students.map(s => s.id);

    for (const userId of studentIds) {
        // 👇 طباعة للتأكد
        // console.log(`   -> Checking tasks for user ${userId}`);
        
        const { error, count } = await supabase
            .from('user_tasks')
            .delete({ count: 'exact' }) // نطلب عدد المحذوفات
            .eq('user_id', userId)
            .contains('meta', { isExamPrep: true }); 
            
        if (error) {
            logger.warn(`Failed to clean tasks for user ${userId}: ${error.message}`);
        } else if (count > 0) {
            logger.success(`✅ DELETED ${count} exam task(s) for user ${userId}`);
        }
    }
  } catch (e) {
    logger.error('Cleanup Logic Error:', e.message);
  }
}

// ... (باقي الدوال processStudentNotification و generatePersonalizedMessage تبقى كما هي في الكود السابق)
async function processStudentNotification(student, exam, type) {
    try {
        const userId = student.id;
        const subjectName = exam.subjects?.title || 'المادة';
        const examId = exam.id;
        const examDate = exam.exam_date;

        const { data: existing } = await supabase
            .from('user_notifications')
            .select('id')
            .eq('user_id', userId)
            .eq('type', type)
            .eq('target_id', examId)
            .limit(1);

        if (existing && existing.length > 0) return; 

        const { data: profile } = await supabase
            .from('ai_memory_profiles')
            .select('facts, emotional_state')
            .eq('user_id', userId)
            .single();

        const facts = profile?.facts || {};
        const mood = profile?.emotional_state?.mood || 'neutral';
        
        const message = await generatePersonalizedMessage(student.first_name, subjectName, type, facts, mood, examDate);

        if (message) {
            await sendUserNotification(userId, {
                title: type === 'pre_exam' ? `⏳ قرب وقت ${subjectName}` : `🏁 خلاصت ${subjectName}؟`,
                message: message,
                type: type,
                meta: { targetId: examId, subject: subjectName }
            });
        }
    } catch (err) {
        logger.error(`Notification Error for user ${student.id}:`, err.message);
    }
}

async function generatePersonalizedMessage(name, subject, type, facts, mood, examDate) {
    if (!generateWithFailoverRef) return null;
    let timeContextStr = "soon";
    if (examDate) timeContextStr = getHumanTimeDiff(new Date(examDate)); 
    const userContext = `User: ${name}, Facts: ${JSON.stringify(facts)}, Mood: ${mood}, Time: ${timeContextStr}`;
    let prompt = "";
    if (type === 'pre_exam') {
      prompt = `You are a supportive Algerian friend. Exam "${subject}" is ${timeContextStr}. User: ${userContext}. Write short encouraging notification in Derja.`;
    } else {
      prompt = `You are a close Algerian friend. Exam "${subject}" finished ${timeContextStr}. User: ${userContext}. Ask casually how it went in Derja.`;
    }
    try {
        const res = await generateWithFailoverRef('notification', prompt, { label: 'ExamMsg' });
        const text = await extractTextFromResult(res);
        return text ? text.replace(/"/g, '') : null;
    } catch (e) {
        return type === 'pre_exam' ? `بالتوفيق في ${subject}!` : `يعطيك الصحة، ارتاح شوية.`;
    }
}

module.exports = { initExamWorker, checkExamTiming };
