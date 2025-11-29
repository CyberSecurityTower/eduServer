// services/jobs/nightWatch.js
'use strict';

const supabase = require('../../data/supabase');
const { sendUserNotification } = require('../../data/helpers');

async function runNightWatch() {
  console.log('🌙 Night Watch started...');
  const results = { groupsChecked: 0, notificationsSent: 0 };

  try {
    // 1. جلب الأفواج التي لديها معلومات مشتركة
    const { data: groups, error } = await supabase
      .from('study_groups')
      .select('id, shared_knowledge');

    if (error || !groups) return results;

    const now = new Date();
    // تصفير الوقت للمقارنة العادلة بالأيام
    now.setHours(0, 0, 0, 0);

    for (const group of groups) {
      const knowledge = group.shared_knowledge;
      if (!knowledge || !knowledge.exams) continue;

      results.groupsChecked++;

      // 2. فحص الامتحانات داخل الفوج
      for (const [subject, info] of Object.entries(knowledge.exams)) {
        // الشروط: قيمة مؤكدة + ثقة عالية (أكثر من 3 أصوات مثلاً)
        if (!info.confirmed_value || info.confidence_score < 3) continue;

        const examDate = new Date(info.confirmed_value);
        examDate.setHours(0, 0, 0, 0);

        // حساب الفرق بالأيام
        const diffTime = examDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // 3. التنبيه إذا كان الامتحان قريباً (غداً أو بعد يومين أو 3)
        if (diffDays > 0 && diffDays <= 3) {
          
          // جلب طلاب الفوج
          const { data: students } = await supabase
            .from('users')
            .select('id')
            .eq('group_id', group.id);

          if (!students || students.length === 0) continue;

          console.log(`📢 Alerting Group ${group.id}: ${subject} exam in ${diffDays} days.`);
          
          let message = "";
          if (diffDays === 1) message = `🚨 غدوة امتحان ${subject}! بالتوفيق، راجع مليح.`;
          else message = `⚠️ تذكير للفوج: امتحان ${subject} ما بقالوش (بعد ${diffDays} أيام).`;

          // إرسال الإشعارات
          const notifications = students.map(student => 
            sendUserNotification(student.id, {
              title: "تنبيه الفوج 📢",
              message: message,
              type: "group_alert",
              meta: { subject, date: info.confirmed_value }
            })
          );

          await Promise.all(notifications);
          results.notificationsSent += students.length;
        }
      }
    }
  } catch (err) {
    console.error('Night Watch Error:', err);
  }
  
  console.log('🌙 Night Watch finished:', results);
  return results;
}

module.exports = { runNightWatch };
