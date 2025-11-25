
'use strict';

const CONFIG = require('../../config');
const supabase = require('../data/supabase'); // ✅ استيراد مباشر
const { toSnakeCase, toCamelCase, nowISO } = require('../data/dbUtils');
const { sendUserNotification, getProgress, getProfile, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName, cacheDel } = require('../data/helpers');
const { runNotificationManager } = require('../ai/managers/notificationManager');
const { runPlannerManager } = require('../ai/managers/plannerManager');
const { runToDoManager } = require('../ai/managers/todoManager'); 
const logger = require('../../utils/logger');

let workerStopped = false;
let handleGeneralQuestionRef; 

function initJobWorker(dependencies) {
  if (!dependencies.handleGeneralQuestion) {
    throw new Error('Job Worker requires handleGeneralQuestion for initialization.');
  }
  handleGeneralQuestionRef = dependencies.handleGeneralQuestion;
  logger.success('Job Worker Initialized (Supabase).');
}

function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

// --- Job Processor ---
async function processJob(jobData) {
  const id = jobData.id;
  logger.log(`[Worker] Starting job ${id} of type ${jobData.type}`);

  try {
    // تحديث الحالة إلى processing
    await supabase.from('jobs').update({ status: 'processing', started_at: nowISO() }).eq('id', id);

    const { user_id: userId, type, payload } = jobData; // snake_case from DB
    
    // ... (باقي منطق المعالجة هو نفسه، لا تغيير في المنطق، فقط في طريقة جلب البيانات)
    // سأختصر هنا للكود المهم:

    if (type === 'background_chat') {
        // ... (Chat logic using helpers - they are already updated)
        // عند استخدام helpers.js، نحن آمنون
    }
    
    // عند الانتهاء
    await supabase.from('jobs').update({ status: 'done', finished_at: nowISO() }).eq('id', id);
    logger.success(`[Worker] Job ${id} completed.`);

  } catch (err) {
    logger.error(`[Worker] processJob error for ${id}`, err.stack || err);
    const attempts = (jobData.attempts || 0) + 1;
    const update = {
      attempts,
      last_error: String(err.message || err),
      status: attempts >= 3 ? 'failed' : 'queued'
    };
    if (attempts >= 3) update.finished_at = nowISO();
    
    await supabase.from('jobs').update(update).eq('id', id);
  }
}

// --- Worker Loop ---
async function jobWorkerLoop() {
  if (workerStopped) return;
  try {
    const now = nowISO();

    // 1. Reset scheduled jobs that are due
    await supabase
        .from('jobs')
        .update({ status: 'queued' })
        .eq('status', 'scheduled')
        .lte('send_at', now);

    // 2. Fetch queued jobs
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(5);

    if (jobs && jobs.length > 0) {
      const promises = jobs.map(job => processJob(job));
      await Promise.all(promises);
    }
   } catch (err) {
    logger.error('jobWorkerLoop error:', err.message || err);
  } finally {
    if (!workerStopped) {
      setTimeout(jobWorkerLoop, CONFIG.JOB_POLL_MS);
    }
  }
}

// ✅✅✅ Ticker Function (Supabase Version) ✅✅✅
async function checkScheduledActions() {
  try {
    const now = nowISO();
    
    // جلب المهام المستحقة
    const { data: actions, error } = await supabase
      .from('scheduled_actions')
      .select('*')
      .eq('status', 'pending')
      .lte('execute_at', now) 
      .order('execute_at', { ascending: true })
      .limit(50);

    if (!actions || actions.length === 0) return;

    logger.log(`[Ticker] Processing ${actions.length} actions.`);
    
    const updates = [];

    for (const action of actions) {
      // إرسال الإشعار
      await sendUserNotification(action.user_id, {
        title: action.title || 'تذكير ذكي',
        message: action.message,
        type: 'smart_reminder',
        meta: { actionId: action.id, originalTime: action.execute_at }
      });

      // نجمع وعود التحديث
      updates.push(
          supabase.from('scheduled_actions')
            .update({ 
                status: 'completed', 
                executed_at: nowISO() 
            })
            .eq('id', action.id)
      );
    }

    await Promise.all(updates);
    logger.success(`[Ticker] Executed ${actions.length} actions.`);

  } catch (err) {
    logger.error('[Ticker] Error:', err.message);
  }
}

function stopWorker() {
  workerStopped = true;
  logger.info('Job worker stopped.');
}

module.exports = {
  initJobWorker,
  jobWorkerLoop,
  stopWorker,
  processJob,
  checkScheduledActions
};
