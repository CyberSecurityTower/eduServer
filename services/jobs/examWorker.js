// services/jobs/examWorker.js
'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');
const { extractTextFromResult } = require('../../utils');
const logger = require('../../utils/logger');
const { getHumanTimeDiff } = require('../../utils');
// نحتاج لحقن دالة التوليد (Dependency Injection)
let generateWithFailoverRef;

function initExamWorker(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * 🕵️‍♂️ مراقب الامتحانات
 * يعمل كل بضع دقائق ليفحص هل اقترب امتحان أو انتهى
 */
async function checkExamTiming() {
  try {
    const now = new Date();
    console.log(`🕒 Exam Worker Running at: ${now.toISOString()}`);

    // 1. جلب الامتحانات التي تحدث اليوم (نطاق واسع)
    // نأخذ الامتحانات التي وقتها بين (الآن - 3 ساعات) و (الآن + 2 ساعة)
    // لكي نغطي حالتي "قبل ساعة" و "بعد ساعتين"
    const startTime = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const endTime = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

    const { data: exams, error } = await supabase
      .from('exams')
      .select('id, subject_id, exam_date, group_id, subjects(title)')
      .gte('exam_date', startTime)
      .lte('exam_date', endTime);

if (error || !exams || exams.length === 0) {
        console.log("⚠️ No exams found in range.");
        return;
    }
    // 2. معالجة كل امتحان
    for (const exam of exams) {
      const examTime = new Date(exam.exam_date);
      const diffMs = examTime - now;
      const diffMinutes = Math.floor(diffMs / (1000 * 60)); // بالسالب يعني فات الوقت
      // 👇👇👇 هنا السحر: سنطبع الفرق لنعرف السبب
      console.log(`🔎 Checking Exam: ${exam.subjects?.title}`);
      console.log(`   - Exam Time: ${examTime.toISOString()}`);
      console.log(`   - Minutes Left: ${diffMinutes} minutes`); 
      // 👆👆👆
      let notificationType = null;

      // ⏰ الحالة 1: قبل الامتحان بـ 45 إلى 75 دقيقة (حوالي ساعة)
      if (diffMinutes >= 45 && diffMinutes <= 75) {
        console.log("   ✅ Condition Met: PRE_EXAM"); // 👈 تأكيد

        notificationType = 'pre_exam';
      }
      // ⏰ الحالة 2: بعد الامتحان بـ 105 إلى 135 دقيقة (حوالي ساعتين)
      // (الامتحان بدأ منذ ساعتين، يعني انتهى تقريباً)
      else if (diffMinutes >= -135 && diffMinutes <= -105) {
                console.log("   ✅ Condition Met: POST_EXAM"); // 👈 تأكيد

        notificationType = 'post_exam';
      }
      else {
        console.log("   ❌ Condition Failed: Not time yet."); // 👈 تأكيد
      }


      if (!notificationType) continue; // ليس وقته

      // 3. جلب طلاب الفوج
      const { data: students } = await supabase
        .from('users')
        .select('id, first_name, fcm_token') // 👈 أضفنا fcm_token هنا
        .eq('group_id', exam.group_id);

      if (!students) continue;

      // 4. المعالجة لكل طالب
      for (const student of students) {
        // 🛑 تحقق سريع قبل حتى الدخول في المعالجة الثقيلة
        if (!student.fcm_token) {
             console.log(`⏩ Skipping ${student.first_name} (No Token)`);
             continue; 
        }
        
        await processStudentNotification(student, exam, notificationType);
      }
    }

  } catch (err) {
    logger.error('Exam Worker Error:', err.message);
  }
}


async function processStudentNotification(student, exam, type) {
  const userId = student.id;
  const subjectName = exam.subjects?.title || 'المادة';
  const examId = exam.id;
  const examDate = exam.exam_date; // 👈 نحتاج التاريخ هنا

  // 🛑 1. فحص التكرار (مهم جداً)
  const { data: existing } = await supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type) // pre_exam أو post_exam
    .eq('target_id', examId) // نربطها بمعرف الامتحان
    .limit(1);

  if (existing && existing.length > 0) return; // تم الإرسال سابقاً

  // 🧠 2. جلب بروفايل الطالب
  const { data: profile } = await supabase
    .from('ai_memory_profiles')
    .select('facts, emotional_state')
    .eq('user_id', userId)
    .single();

  const facts = profile?.facts || {};
  const mood = profile?.emotional_state?.mood || 'neutral';
  
  // 🎨 3. توليد الرسالة بالذكاء الاصطناعي (تم تمرير examDate)
  const message = await generatePersonalizedMessage(
    student.first_name, 
    subjectName, 
    type, 
    facts, 
    mood, 
    examDate // 👈 التعديل هنا
  );

  if (message) {
    // 🚀 4. إرسال الإشعار مع تمرير التوكن
    await sendUserNotification(student.id, {
      title: type === 'pre_exam' ? `⏳ قرب وقت ${subjectName}` : `🏁 خلاصت ${subjectName}؟`,
      message: message,
      type: type,
      meta: { targetId: examId, subject: subjectName }
    }, student.fcm_token); // 👈 مررنا التوكن هنا لتفادي استعلام جديد
    
    logger.success(`[ExamWorker] Sent ${type} to ${student.first_name}`);
  }
}
// 🤖 مصنع الرسائل الشخصية
async function generatePersonalizedMessage(name, subject, type, facts, mood, examDate) {
  try {
    if (!generateWithFailoverRef) return null;

    // 🕒 حساب الوقت البشري للسياق (مثال: "in 55 minutes")
    // نستخدم الدالة المساعدة أو نحسبها يدوياً لتكون دقيقة للـ Prompt
    let timeContextStr = "soon";
    if (examDate) {
      // نستخدم الدالة المستوردة (تعيد نصاً مثل "خلال ساعة" أو "منذ ساعتين")
      timeContextStr = getHumanTimeDiff(new Date(examDate)); 
    }

    const userContext = `
    User: ${name}
    Facts: ${JSON.stringify(facts)}
    Current Mood: ${mood}
    Exam Time Info: ${timeContextStr}
    `;

    let prompt = "";

    if (type === 'pre_exam') {
      prompt = `
      You are a supportive Algerian friend.
      Context: The exam for "${subject}" is happening ${timeContextStr}.
      User Info: ${userContext}
      
      Task: Write a short, encouraging notification (max 15 words) in Algerian Derja.
      - If time is very close (less than 1 hour), tell them to get ready/focus.
      - Wish them luck based on their mood (calm them if anxious, hype them if confident).
      - Remind them of ONE practical thing (ID card, calculator, water).
      - Example: "يا ${name}، بقات ساعة! وجد دوزانك وربي يوفقك، راك قدها 💪"
      `;
    } else {
      prompt = `
      You are a close Algerian friend.
      Context: The exam for "${subject}" finished recently (${timeContextStr}).
      User Info: ${userContext}
      
      Task: Write a short notification (max 15 words) in Algerian Derja.
      - Ask casually how it went.
      - Tell them to forget it and rest.
      - Example: "واش ${name}؟ المات كان ساهل؟ المهم ريح راسك دوكا."
      `;
    }

    const res = await generateWithFailoverRef('notification', prompt, { label: 'ExamMsg' });
    const text = await extractTextFromResult(res);
    return text ? text.replace(/"/g, '') : null;

  } catch (e) {
    logger.error('AI Gen Error:', e.message);
    
    // Fallback messages
    if (type === 'pre_exam') return `بالتوفيق يا ${name}! ركز مليح وما تنساش دوزانك.`;
    return `يعطيك الصحة يا ${name}! ارتاح شوية وانسى واش فات.`;
  }
}
module.exports = { initExamWorker, checkExamTiming };
