
'use strict';

const CONFIG = require('../../config');
const supabase = require('../data/supabase');
const { nowISO } = require('../data/dbUtils');
const { sendUserNotification } = require('../data/helpers');
const { runPlannerManager } = require('../ai/managers/plannerManager');
const logger = require('../../utils/logger');

let workerStopped = false;
let handleGeneralQuestionRef; 

function initJobWorker(dependencies) {
  // handleGeneralQuestion is optional depending on architecture, but good to have
  handleGeneralQuestionRef = dependencies.handleGeneralQuestion;
  logger.success('Job Worker Initialized (Supabase).');
}

async function processJob(job) {
  const { id, user_id, type, payload } = job;
  
  try {
    // 1. Mark Processing
    await supabase.from('jobs').update({ status: 'processing', started_at: nowISO() }).eq('id', id);

    // 2. Execute Logic
    if (type === 'background_chat') {
        // Chat Logic Stub
    } else if (type === 'generate_plan') {
       await runPlannerManager(user_id, payload.pathId);
       // Notify user
       await sendUserNotification(user_id, {
           title: 'خطتك جاهزة!',
           message: 'تم تحديث مهامك اليومية بناءً على طلبك.',
           type: 'plan_update'
       });
    } else if (type === 'scheduled_notification') {
        // Nightly Analysis Notification
        await sendUserNotification(user_id, payload);
    }

    // 3. Mark Done
    await supabase.from('jobs').update({ status: 'done', finished_at: nowISO() }).eq('id', id);

  } catch (err) {
    logger.error(`Job ${id} failed:`, err.message);
    const attempts = (job.attempts || 0) + 1;
    await supabase.from('jobs').update({
       status: attempts >= 3 ? 'failed' : 'queued',
       attempts,
       last_error: err.message
    }).eq('id', id);
  }
}

async function jobWorkerLoop() {
  if (workerStopped) return;
  try {
    // Reset stuck scheduled jobs
    await supabase.from('jobs').update({ status: 'queued' }).eq('status', 'scheduled').lte('send_at', nowISO());

    // Fetch queued
    const { data: jobs } = await supabase.from('jobs').select('*').eq('status', 'queued').order('created_at').limit(5);

    if (jobs && jobs.length > 0) {
        await Promise.all(jobs.map(processJob));
    }

  } catch (err) {
    logger.error('Worker Loop Error:', err.message);
  } finally {
    if (!workerStopped) setTimeout(jobWorkerLoop, CONFIG.JOB_POLL_MS);
  }
}

async function checkScheduledActions() {
  try {
    const now = new Date().toISOString();
    
    // 1. جلب المهام المستحقة
    const { data: actions, error } = await supabase
      .from('scheduled_actions')
      .select('*')
      .eq('status', 'pending')
      .lte('execute_at', now)
      .limit(50); // معالجة 50 في كل دورة كحد أقصى

    if (error) throw error;
    if (!actions || actions.length === 0) return;

    logger.log(`[Ticker] Processing ${actions.length} actions.`);

    // 2. المعالجة المتسلسلة (لضمان عدم التداخل)
    for (const action of actions) {
      
      // 🛑 تحقق إضافي: هل تم تغيير الحالة من طرف "worker" آخر في أجزاء الثانية الأخيرة؟
      // نقوم بتحديث الحالة إلى 'processing' أولاً، إذا نجح التحديث، نرسل الإشعار.
      // هذا يضمن أن عملية واحدة فقط ستعالج هذا الصف.
      
      const { error: lockError } = await supabase
        .from('scheduled_actions')
        .update({ status: 'processing' }) // حالة مؤقتة
        .eq('id', action.id)
        .eq('status', 'pending'); // شرط مهم جداً

      if (lockError) {
          // إذا فشل التحديث (ربما تمت معالجته)، نتجاوز
          continue; 
      }

      // 3. إرسال الإشعار الفعلي
      try {
          await sendUserNotification(action.user_id, {
            title: action.title || 'تنبيه',
            message: action.message,
            type: 'smart_reminder',
            meta: { actionId: action.id }
          });

          // 4. وضع علامة الاكتمال
          await supabase
            .from('scheduled_actions')
            .update({ status: 'completed', executed_at: new Date().toISOString() })
            .eq('id', action.id);
            
      } catch (sendErr) {
          logger.error(`[Ticker] Failed to send notification ${action.id}:`, sendErr);
          // في حالة الفشل، نعيده لـ pending أو نضعه failed
          await supabase
            .from('scheduled_actions')
            .update({ status: 'failed', last_error: sendErr.message })
            .eq('id', action.id);
      }
    }

  } catch (err) {
    logger.error('[Ticker] Error:', err.message);
  }
}
module.exports = {
  initJobWorker,
  jobWorkerLoop,
  checkScheduledActions,
  stopWorker
};
