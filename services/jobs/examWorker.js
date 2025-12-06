// services/jobs/examWorker.js
'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');
const { extractTextFromResult, getHumanTimeDiff } = require('../../utils');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

function initExamWorker(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Exam Worker Initialized (Auto-Cleanup & Notifications).');
}

/**
 * 🕵️‍♂️ مراقب الامتحانات
 * يعمل كل دقيقة لفحص الامتحانات القريبة أو المنتهية
 */
async function checkExamTiming() {
  try {
    const now = new Date();
    
    // نوسع النطاق الزمني:
    // - نعود للوراء 24 ساعة (لالتقاط الامتحانات التي انتهت ونحتاج لتنظيف مهامها المتأخرة)
    // - نتقدم 4 ساعات (للتنبيهات القادمة)
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

      // =================================================================
      // 🧹 1. المكنسة الذكية (The Kill Switch)
      // =================================================================
      // إذا بقي للامتحان 15 دقيقة أو أقل (أو بدأ بالفعل وأصبح الوقت بالسالب)
      // نقوم بحذف "مهمة التحضير" فوراً لكي لا يهلوس الذكاء الاصطناعي
      if (diffMinutes <= 15) { 
         await cleanupExamTasks(exam.group_id, exam.subject_id);
      }

      // =================================================================
      // 🔔 2. نظام الإشعارات
      // =================================================================
      let notificationType = null;

      // ⏰ قبل الامتحان بـ ساعة (بين 45 و 75 دقيقة)
      if (diffMinutes >= 45 && diffMinutes <= 75) {
        notificationType = 'pre_exam';
      }
      // 🏁 بعد الامتحان بـ ساعتين (بين -135 و -105)
      else if (diffMinutes >= -135 && diffMinutes <= -105) {
        notificationType = 'post_exam';
      }

      // إذا وجدنا نوع إشعار مناسب، نرسله للطلاب
      if (notificationType) {
        const { data: students } = await supabase
            .from('users')
            .select('id, first_name')
            .eq('group_id', exam.group_id);
            
        if (students && students.length > 0) {
          // نستخدم Promise.all للسرعة
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

/**
 * 🧹 دالة الحذف القاطع
 * تحذف أي مهمة في user_tasks تحتوي على علامة isExamPrep: true
 */
async function cleanupExamTasks(groupId, subjectId) {
  try {
    // 1. جلب طلاب الفوج
    const { data: students } = await supabase
        .from('users')
        .select('id')
        .eq('group_id', groupId);

    if (!students || students.length === 0) return;

    const studentIds = students.map(s => s.id);

    // 2. الحذف الجماعي (Loop لأن Supabase لا يدعم الحذف بـ Join معقد بسهولة هنا)
    for (const userId of studentIds) {
        const { error } = await supabase
            .from('user_tasks')
            .delete()
            .eq('user_id', userId)
            // 🔥 الشرط القاتل: أي مهمة هي "تحضير امتحان" تحذف فوراً
            .contains('meta', { isExamPrep: true }); 
            
        if (error) logger.warn(`Failed to clean tasks for user ${userId}: ${error.message}`);
    }
  } catch (e) {
    logger.error('Cleanup Logic Error:', e.message);
  }
}

/**
 * 📩 معالجة وإرسال الإشعار للطالب
 */
async function processStudentNotification(student, exam, type) {
    try {
        const userId = student.id;
        const subjectName = exam.subjects?.title || 'المادة';
        const examId = exam.id;
        const examDate = exam.exam_date;

        // 1. منع التكرار: هل أرسلنا هذا الإشعار من قبل؟
        const { data: existing } = await supabase
            .from('user_notifications')
            .select('id')
            .eq('user_id', userId)
            .eq('type', type)
            .eq('target_id', examId)
            .limit(1);

        if (existing && existing.length > 0) return; // تم الإرسال سابقاً

        // 2. جلب بيانات الطالب لتخصيص الرسالة
        const { data: profile } = await supabase
            .from('ai_memory_profiles')
            .select('facts, emotional_state')
            .eq('user_id', userId)
            .single();

        const facts = profile?.facts || {};
        const mood = profile?.emotional_state?.mood || 'neutral';
        
        // 3. توليد الرسالة
        const message = await generatePersonalizedMessage(student.first_name, subjectName, type, facts, mood, examDate);

        // 4. الإرسال
        if (message) {
            await sendUserNotification(userId, {
                title: type === 'pre_exam' ? `⏳ قرب وقت ${subjectName}` : `🏁 خلاصت ${subjectName}؟`,
                message: message,
                type: type,
                meta: { targetId: examId, subject: subjectName }
            });
            // logger.success(`Sent ${type} to ${student.first_name}`);
        }
    } catch (err) {
        logger.error(`Notification Error for user ${student.id}:`, err.message);
    }
}

/**
 * 🤖 مصنع الرسائل الشخصية
 */
async function generatePersonalizedMessage(name, subject, type, facts, mood, examDate) {
    if (!generateWithFailoverRef) return null;

    let timeContextStr = "soon";
    if (examDate) {
      timeContextStr = getHumanTimeDiff(new Date(examDate)); 
    }

    const userContext = `User: ${name}, Facts: ${JSON.stringify(facts)}, Mood: ${mood}, Time: ${timeContextStr}`;
    let prompt = "";

    if (type === 'pre_exam') {
      prompt = `
      You are a supportive Algerian friend.
      Context: Exam "${subject}" is happening ${timeContextStr}.
      User Info: ${userContext}
      Task: Write a short, encouraging notification (max 15 words) in Algerian Derja.
      Example: "يا ${name}، بقات ساعة! وجد دوزانك وربي يوفقك 💪"
      `;
    } else {
      prompt = `
      You are a close Algerian friend.
      Context: Exam "${subject}" finished ${timeContextStr}.
      User Info: ${userContext}
      Task: Write a short notification (max 15 words) in Algerian Derja asking casually how it went.
      Example: "واش ${name}؟ المات كان ساهل؟ المهم ريح راسك دوكا."
      `;
    }

    try {
        const res = await generateWithFailoverRef('notification', prompt, { label: 'ExamMsg' });
        const text = await extractTextFromResult(res);
        return text ? text.replace(/"/g, '') : null;
    } catch (e) {
        // رسالة احتياطية في حالة فشل الـ AI
        return type === 'pre_exam' ? `بالتوفيق في ${subject}!` : `يعطيك الصحة، ارتاح شوية.`;
    }
}

module.exports = { initExamWorker, checkExamTiming };
