// services/jobs/examWorker.js
'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');
const { extractTextFromResult } = require('../../utils');
const logger = require('../../utils/logger');
const { getHumanTimeDiff } = require('../../utils');

let generateWithFailoverRef;

function initExamWorker(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

async function checkExamTiming() {
  try {
    const now = new Date();
    // نوسع النطاق قليلاً لنلتقط الامتحانات التي بدأت للتو
    const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(); 
    const endTime = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

    const { data: exams, error } = await supabase
      .from('exams')
      .select('id, subject_id, exam_date, group_id, subjects(title)')
      .gte('exam_date', startTime)
      .lte('exam_date', endTime);

    if (error || !exams || exams.length === 0) return;

    for (const exam of exams) {
      const examTime = new Date(exam.exam_date);
      const diffMs = examTime - now;
      const diffMinutes = Math.floor(diffMs / (1000 * 60)); 

      // 🧹 1. المكنسة الذكية (The Cleaner)
      // إذا الامتحان بدأ أو سيبدأ خلال 10 دقائق
      if (diffMinutes <= 10) { 
         await cleanupExamTasks(exam.group_id, exam.subject_id);
      }

      // 🔔 2. الإشعارات
      let notificationType = null;
      if (diffMinutes >= 45 && diffMinutes <= 75) notificationType = 'pre_exam';
      else if (diffMinutes >= -135 && diffMinutes <= -105) notificationType = 'post_exam';

      if (notificationType) {
        const { data: students } = await supabase.from('users').select('id, first_name').eq('group_id', exam.group_id);
        if (students) {
          for (const student of students) {
            await processStudentNotification(student, exam, notificationType);
          }
        }
      }
    }
  } catch (err) {
    logger.error('Exam Worker Error:', err.message);
  }
}

// دالة داخلية (لا تحتاج لتصدير)
async function cleanupExamTasks(groupId, subjectId) {
  try {
    const { data: students } = await supabase.from('users').select('id').eq('group_id', groupId);
    if (!students || students.length === 0) return;

    const studentIds = students.map(s => s.id);

    for (const userId of studentIds) {
        // حذف مهام التحضير للامتحان
        await supabase
            .from('user_tasks')
            .delete()
            .eq('user_id', userId)
            .contains('meta', { isExamPrep: true });
    }
  } catch (e) {
    logger.error('Cleanup Error:', e.message);
  }
}

async function processStudentNotification(student, exam, type) {
    // ... (نفس الكود السابق للإشعارات)
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
    
    const res = await generateWithFailoverRef('notification', prompt, { label: 'ExamMsg' });
    const text = await extractTextFromResult(res);
    return text ? text.replace(/"/g, '') : null;
}

module.exports = { initExamWorker, checkExamTiming };
