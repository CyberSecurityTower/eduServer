'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');

async function runNightWatch() {
  console.log('🌙 Night Watch started...');
  const results = { groupsChecked: 0, notificationsSent: 0 };

  try {
    // 1. جلب البيانات
    const { data: groups, error } = await supabase
      .from('study_groups')
      .select('id, shared_knowledge');

    // 🔍 DEBUG: لنرى هل هناك خطأ أو هل المصفوفة فارغة
    if (error) console.error('❌ Supabase Error:', error);
    console.log(`🔍 Found ${groups ? groups.length : 0} groups in DB.`);

    if (!groups) return results;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const group of groups) {
      const knowledge = group.shared_knowledge;
      
      // 🔍 DEBUG: لنرى ماذا يوجد داخل كل فوج
      // console.log(`Checking Group: ${group.id}`, JSON.stringify(knowledge));

      if (!knowledge || !knowledge.exams) {
          console.log(`⚠️ Group ${group.id} has no exams data.`);
          continue;
      }

      results.groupsChecked++; // ✅ هنا يزيد العداد

      for (const [subject, info] of Object.entries(knowledge.exams)) {
        // 🔍 DEBUG: لنرى تفاصيل الامتحان
        // console.log(`   - Subject: ${subject}, Date: ${info.confirmed_value}`);

        if (!info.confirmed_value || info.confidence_score < 3) continue;

        const examDate = new Date(info.confirmed_value);
        examDate.setHours(0, 0, 0, 0);

        const diffTime = examDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        console.log(`   -> Diff Days: ${diffDays}`); // 🔍 هل الحساب صحيح؟

        if (diffDays > 0 && diffDays <= 3) {
          // ... (باقي كود الإرسال كما هو)
          const { data: students } = await supabase
            .from('users')
            .select('id')
            .eq('group_id', group.id);

          if (!students || students.length === 0) {
              console.log(`⚠️ No students found in group ${group.id}`);
              continue;
          }

          console.log(`📢 Sending to ${students.length} students...`);
          
          // ... (كود الإرسال)
          const notifications = students.map(student => 
            sendUserNotification(student.id, {
              title: "تنبيه الفوج 📢",
              message: `⚠️ تذكير: امتحان ${subject} بعد ${diffDays} أيام.`,
              type: "group_alert"
            })
          );
          await Promise.all(notifications);
          results.notificationsSent += students.length;
        }
      }
    }
  } catch (err) {
    console.error('Night Watch Critical Error:', err);
  }
  
  console.log('🌙 Finished:', results);
  return results;
}

module.exports = { runNightWatch };
