
// services/jobs/streakRescue.js
'use strict';

const supabase = require('../data/supabase');
const { getProfile, sendUserNotification } = require('../data/helpers');
const { extractTextFromResult } = require('../../utils');
const PROMPTS = require('../../config/ai-prompts');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

function initStreakRescue(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('🚑 Streak Rescue Service Initialized.');
}

async function runStreakRescueMission() {
  logger.info('🚑 Starting Operation: Streak Rescue (Scheduling Mode)...');

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // طباعة التاريخ الذي يبحث عنه السيرفر
  console.log(`🔍 DEBUG: Server Date (UTC): ${todayStr}`);
  console.log(`🔍 DEBUG: Searching for users with last_streak_date < ${todayStr} AND last_rescue_warning != ${todayStr}`);

  // 1. جلب المستخدمين
  const { data: users, error } = await supabase
    .from('users')
    .select('id, first_name, streak_count, last_streak_date, last_rescue_warning') // جلبنا الحقول للتأكد
    .gt('streak_count', 0)
    .lt('last_streak_date', todayStr)
    .or(`last_rescue_warning.is.null,last_rescue_warning.neq.${todayStr}`);
  // في Supabase، مقارنة neq مع NULL قد تكون خادعة أحياناً، سنعالجها
  // لكن دعنا نرى النتيجة أولاً

  if (error) {
    logger.error('Streak Rescue DB Error:', error.message);
    return;
  }

  console.log(`🔍 DEBUG: Found ${users?.length || 0} users.`);
  
  // طباعة أول مستخدم وجده (إن وجد)
  if (users && users.length > 0) {
      console.log('🔍 DEBUG: Sample User:', users[0]);
  } else {
      console.log('❌ DEBUG: No users found. Check your DB row!');
  }

  if (!users || users.length === 0) return;

  logger.info(`⚠️ Found ${users.length} users at risk. Calculating schedules...`);

  for (const user of users) {
    await scheduleUserRescue(user);
  }
}

async function scheduleUserRescue(user) {
  try {
    const now = new Date();
    
    // 1. تحديد الموعد النهائي (منتصف الليل)
    const streakDeadline = new Date();
    streakDeadline.setHours(23, 59, 59, 999);

    // 2. تحديد وقت الإرسال (Execution Time)
    const meta = user.ai_scheduler_meta || {};
    const bestHour = meta.next_prime_hour || 20; // الافتراضي 8 مساءً
    
    let executionTime = new Date();
    executionTime.setHours(bestHour, 0, 0, 0);

    // منطق التصحيح (Safety Valve Logic):
    // أ. إذا كان الوقت المفضل قد فات -> أرسل بعد دقيقتين من الآن (فوري)
    if (executionTime <= now) {
        executionTime = new Date(now.getTime() + 2 * 60 * 1000);
    }
    
    // ب. إذا كان الوقت المفضل بعد "وقت الخطر" (مثلاً 11 ليلاً) -> أرسل في 9 ليلاً
    const dangerTime = new Date(streakDeadline.getTime() - 3 * 60 * 60 * 1000); // 21:00
    if (executionTime > dangerTime) {
        executionTime = dangerTime;
        // إذا كنا تجاوزنا وقت الخطر أصلاً، نرسل فوراً
        if (executionTime <= now) executionTime = new Date(now.getTime() + 2 * 60 * 1000);
    }

    // 3. حساب السياق المستقبلي للـ AI
    const msLeftAtExecution = streakDeadline - executionTime;
    const hoursLeftAtExecution = Math.max(0, Math.floor(msLeftAtExecution / (1000 * 60 * 60)));
    const executionTimeStr = `${executionTime.getHours()}:${executionTime.getMinutes().toString().padStart(2, '0')}`;

    // 4. تجهيز البرومبت
    const profile = await getProfile(user.id);
    const facts = profile.facts || {};
    const personalFact = facts.dream ? `dream: ${facts.dream}` : 'loves winning';

    const context = {
      name: user.first_name || 'Champion',
      streak: user.streak_count,
      timeNow: executionTimeStr,
      personalFact: personalFact,
      timeLeft: `${hoursLeftAtExecution} hours`
    };

    const prompt = PROMPTS.notification.streakRescue 
        ? PROMPTS.notification.streakRescue(context)
        : `User ${user.first_name} is losing streak. Write urgent message.`;

    let message = `يا ${user.first_name}، باقي ${hoursLeftAtExecution} سوايع ويخلاص النهار! سوفي الستريك!`;

    if (generateWithFailoverRef) {
        const res = await generateWithFailoverRef('notification', prompt, { label: 'StreakRescueScheduled' });
        const aiText = await extractTextFromResult(res);
        if (aiText) message = aiText.replace(/"/g, '');
    }

    // 5. الإدراج في جدول scheduled_actions
    const { error } = await supabase.from('scheduled_actions').insert({
        user_id: user.id,
        type: 'streak_rescue',
        title: '🚨 إنقاذ الستريك!',
        message: message,
        execute_at: executionTime.toISOString(),
        status: 'pending',
        meta: { 
            streak: user.streak_count,
            targetScreen: '/(tabs)/home',
            strategy: 'chrono_rescue'
        }
    });

    if (!error) {
        // 6. تحديث المستخدم
        const todayStr = new Date().toISOString().split('T')[0];
        await supabase.from('users').update({ last_rescue_warning: todayStr }).eq('id', user.id);
        logger.success(`📅 Scheduled Rescue for ${user.first_name} at ${executionTimeStr}`);
    }

  } catch (err) {
    logger.error(`Scheduling failed for ${user.id}:`, err.message);
  }
}

module.exports = { initStreakRescue, runStreakRescueMission };
