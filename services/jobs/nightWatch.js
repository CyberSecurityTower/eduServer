'use strict';

const supabase = require('../../data/supabase');
const { sendUserNotification } = require('../../data/helpers');

async function runNightWatch() {
  console.log('🌙 Night Watch started...');

  // 1. جلب كل الأفواج التي لديها معلومات مشتركة
  const { data: groups } = await supabase
    .from('study_groups')
    .select('id, shared_knowledge');

  if (!groups) return;

  const now = new Date();

  for (const group of groups) {
    const knowledge = group.shared_knowledge;
    if (!knowledge || !knowledge.exams) continue;

    // 2. فحص الامتحانات
    for (const [subject, info] of Object.entries(knowledge.exams)) {
      if (!info.confirmed_value) continue;

      const examDate = new Date(info.confirmed_value);
      const diffDays = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));

      // إذا الامتحان قريب (بين 1 و 3 أيام) ومؤكد
      if (diffDays > 0 && diffDays <= 3 && info.confidence_score >= 5) {
        
        // 3. جلب طلاب الفوج
        const { data: students } = await supabase
          .from('users')
          .select('id')
          .eq('group_id', group.id);

        if (!students) continue;

        // 4. إرسال إشعار جماعي (Mass Notification)
        console.log(`📢 Alerting Group ${group.id}: ${subject} exam in ${diffDays} days.`);
        
        const message = diffDays === 1 
          ? `🚨 غدوة امتحان ${subject}! بالتوفيق للجميع.` 
          : `⚠️ تذكير للفوج: امتحان ${subject} ما بقالوش (بعد ${diffDays} أيام).`;

        // نرسل للجميع (يمكن تحسينها لإرسال دفعة واحدة عبر FCM Topic لاحقاً)
        for (const student of students) {
          await sendUserNotification(student.id, {
            title: "تنبيه الفوج 📢",
            message: message,
            type: "group_alert"
          });
        }
      }
    }
  }
  console.log('🌙 Night Watch finished.');
}

module.exports = { runNightWatch };
