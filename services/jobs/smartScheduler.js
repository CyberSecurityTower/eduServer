
// services/jobs/smartScheduler.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * 🧠 المجدول الذكي (The Smart Scheduler)
 */
async function scheduleSmartNotification(userId, type, payload, options = {}) {
  try {
    let executionTime;
    let strategyUsed = 'default';

    // 1. الأولوية القصوى: المستخدم حدد وقتاً (Manual)
    if (options.manualTime) {
      executionTime = new Date(options.manualTime);
      strategyUsed = 'user_manual';
      logger.info(`📅 User defined time selected for ${userId}`);
    } 
    // 2. الأولوية الثانية: حدث طارئ (Urgent)
    else if (options.isUrgent) {
      executionTime = new Date(); // فوراً
      // أو بعد قليل لضمان المعالجة: executionTime.setMinutes(executionTime.getMinutes() + 2);
      strategyUsed = 'urgent';
      logger.info(`🚨 Urgent time selected for ${userId}`);
    } 
    // 3. الأولوية الثالثة: الذكاء الاصطناعي (Chrono-Sniper)
    else {
      // نجلب الوقت المفضل الذي حسبه الـ Cron Job
      const { data: user } = await supabase
        .from('users')
        .select('ai_scheduler_meta')
        .eq('id', userId)
        .single();

      const meta = user?.ai_scheduler_meta || { next_prime_hour: 20, next_prime_offset: 0 };
      
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 1); // غداً
      targetDate.setHours(meta.next_prime_hour || 20, 0, 0, 0);
      targetDate.setMinutes(targetDate.getMinutes() + (meta.next_prime_offset || 0));

      executionTime = targetDate;
      strategyUsed = `ai_optimized (Hour: ${meta.next_prime_hour})`;
      logger.info(`🧠 AI time selected for ${userId}: ${executionTime.toISOString()}`);
    }

    // 4. الحفظ في جدول scheduled_actions
    const { error } = await supabase.from('scheduled_actions').insert({
      user_id: userId,
      type: type,
      title: payload.title,
      message: payload.message,
      execute_at: executionTime.toISOString(),
      status: 'pending',
      meta: { 
        ...payload, 
        strategy: strategyUsed, 
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
