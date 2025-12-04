// services/jobs/nightWatch.js
'use strict';

const supabase = require('../data/supabase');
const { sendUserNotification } = require('../data/helpers');
const CONFIG = require('../../config');
// تأكد من وجود ملف logger في المسار المحدد، وإلا يمكنك استبداله بـ console
const logger = require('../../utils/logger'); 

async function runNightWatch() {
  // إيقاف الدالة فوراً إذا كان النظام معطلاً
  if (CONFIG.ENABLE_EDUNEXUS === false) {
      console.log('🌙 Night Watch is DISABLED via config.');
      return { status: 'disabled' };
  }

  const results = { notificationsSent: 0, groupsChecked: 0 };
  
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // ============================================================
    // 1️⃣ الجزء الجديد: التحقق من الامتحانات التي جرت "اليوم" (Post-Exam)
    // ============================================================
    
    const startOfDay = new Date(now).toISOString();
    const endOfDay = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    // نفترض وجود جدول 'exams' يحتوي على تواريخ دقيقة
    const { data: examsToday, error: examsError } = await supabase
        .from('exams')
        .select('group_id, subject_id, subjects(title)')
        .gte('exam_date', startOfDay)
        .lt('exam_date', endOfDay);

    if (examsError) logger.error('Exams Fetch Error:', examsError);

    if (examsToday && examsToday.length > 0) {
        console.log(`🎓 Found ${examsToday.length} exams taking place today.`);

        for (const exam of examsToday) {
            const groupID = exam.group_id;
            const subjectName = exam.subjects?.title || 'المادة';

            // جلب طلاب هذا الفوج
            const { data: students } = await supabase
                .from('users')
                .select('id, first_name')
                .eq('group_id', groupID);

            if (students && students.length > 0) {
                console.log(`📢 Sending post-exam check to ${students.length} students for ${subjectName}...`);
                
                const promises = students.map(student => {
                    // رسائل عشوائية لطيفة
                    const messages = [
                        `كيفاش جاز امتحان ${subjectName}؟ المهم ريح شوية وبدا توجد لغدوة! 💪`,
                        `تهنيت من ${subjectName}! 🥳 انسى واش فات وركز في الجاي.`,
                        `بصحتك فوت ${subjectName}! 🧠 ارتاح شوية ومبعد نوض للكراس.`
                    ];
                    const randomMsg = messages[Math.floor(Math.random() * messages.length)];

                    return sendUserNotification(student.id, {
                        title: "واش، خدمت شوية؟ 👀",
                        message: randomMsg,
                        type: "post_exam_check",
                        meta: { subject: subjectName }
                    });
                });

                await Promise.all(promises);
                results.notificationsSent += students.length;
            }
        }
    }

    // ============================================================
    // 2️⃣ الجزء القديم: التذكير بالامتحانات القادمة (Upcoming Exams)
    // ============================================================

    // جلب البيانات من study_groups (shared_knowledge)
    const { data: groups, error: groupsError } = await supabase
      .from('study_groups')
      .select('id, shared_knowledge');

    if (groupsError) console.error('❌ Supabase Error (Groups):', groupsError);
    
    if (groups && groups.length > 0) {
        console.log(`🔍 Checking ${groups.length} groups for upcoming exams...`);

        for (const group of groups) {
            const knowledge = group.shared_knowledge;
            
            if (!knowledge || !knowledge.exams) {
                continue;
            }

            results.groupsChecked++;

            for (const [subject, info] of Object.entries(knowledge.exams)) {
                if (!info.confirmed_value || info.confidence_score < 3) continue;

                const examDate = new Date(info.confirmed_value);
                examDate.setHours(0, 0, 0, 0);

                const diffTime = examDate - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                // التذكير قبل 1 إلى 3 أيام
                if (diffDays > 0 && diffDays <= 3) {
                    console.log(`   -> Upcoming Exam: ${subject} in ${diffDays} days for Group ${group.id}`);

                    const { data: students } = await supabase
                        .from('users')
                        .select('id')
                        .eq('group_id', group.id);

                    if (!students || students.length === 0) {
                        continue;
                    }

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
    }

  } catch (err) {
    // استخدام logger إذا كان متاحاً، أو console كبديل
    if (logger && logger.error) {
        logger.error('Night Watch Critical Error:', err);
    } else {
        console.error('Night Watch Critical Error:', err);
    }
  }
  
  console.log('🌙 Finished Night Watch:', results);
  return results;
}

module.exports = { runNightWatch };
}

module.exports = { runNightWatch };
