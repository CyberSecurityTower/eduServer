// services/jobs/smartScheduler.js
'use strict';

const supabase = require('../data/supabase');
const { enqueueJob } = require('./queue'); // الدالة القديمة التي تضع في الطابور
const logger = require('../../utils/logger');

/**
 * 🧠 المجدول الذكي (The Smart Scheduler)
 * هذا هو العقل المدبر الذي يقرر "متى" يتم تنفيذ المهمة.
 * 
 * @param {string} userId - معرف المستخدم
 * @param {string} type - نوع المهمة (reminder, recommendation, alert...)
 * @param {object} payload - بيانات المهمة (العنوان، الرسالة...)
 * @param {object} options - خيارات إضافية (manualTime, isUrgent)
 */
async function scheduleSmartNotification(userId, type, payload, options = {}) {
  try {
    let executionTime;
    let strategyUsed = 'default';

    // 1. الأولوية القصوى: هل حدد المستخدم وقتاً يدوياً؟
    if (options.manualTime) {
      executionTime = new Date(options.manualTime);
      strategyUsed = 'user_manual';
      logger.info(`📅 User defined time selected for ${userId}`);
    } 
    // 2. الأولوية الثانية: هل الأمر طارئ؟ (مثل امتحان غداً)
    else if (options.isUrgent) {
      executionTime = new Date(); // الآن فوراً
      // أو بعد 5 دقائق مثلاً: executionTime.setMinutes(executionTime.getMinutes() + 5);
      strategyUsed = 'urgent';
      logger.info(`🚨 Urgent time selected for ${userId}`);
    } 
    // 3. الأولوية الثالثة: الذكاء الاصطناعي (Chrono-Sniper)
    else {
      // نجلب الوقت المفضل من الداتابايز الذي حسبه الـ Cron Job ليلاً
      const { data: user } = await supabase
        .from('users')
        .select('ai_scheduler_meta') // تذكر؟ هذا العمود الذي ملأناه في nightWatch
        .eq('id', userId)
        .single();

      const meta = user?.ai_scheduler_meta || { next_prime_hour: 20, next_prime_offset: 0 };
      
      // ننشئ تاريخ "غداً" في الساعة المفضلة
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 1); // غداً
      targetDate.setHours(meta.next_prime_hour || 20, 0, 0, 0); // الساعة 20:00 مثلاً
      
      // نضيف إزاحة الدقائق (Exploration Offset)
      targetDate.setMinutes(targetDate.getMinutes() + (meta.next_prime_offset || 0));

      executionTime = targetDate;
      strategyUsed = `ai_optimized (Hour: ${meta.next_prime_hour})`;
      logger.info(`🧠 AI time selected for ${userId}: ${executionTime.toISOString()}`);
    }

    // 4. الحفظ النهائي في جدول scheduled_actions
    // هذا الجدول هو الذي يقرأ منه الـ Worker كل دقيقة وينفذ
    const { error } = await supabase.from('scheduled_actions').insert({
      user_id: userId,
      type: type,
      title: payload.title,
      message: payload.message,
      execute_at: executionTime.toISOString(),
      status: 'pending',
      meta: { 
        ...payload, 
        strategy: strategyUsed, // للاحتفاظ بسجل كيف تم اتخاذ القرار
        created_at: new Date().toISOString()
      }
    });

    if (error) throw error;
    return { success: true, time: executionTime };

  } catch (err) {
    logger.error('Smart Scheduler Failed:', err.message);
    return { success: false };
  }
}

module.exports = { scheduleSmartNotification };
