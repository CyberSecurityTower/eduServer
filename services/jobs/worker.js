
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
  // This runs every minute via setInterval in index.js
  try {
    const now = nowISO();
    const { data: actions } = await supabase
      .from('scheduled_actions')
      .select('*')
      .eq('status', 'pending')
      .lte('execute_at', now)
      .limit(50);

    if (!actions?.length) return;

    logger.log(`[Ticker] Executing ${actions.length} actions.`);
    const updates = [];

    for (const action of actions) {
      await sendUserNotification(action.user_id, {
        title: action.title || 'تذكير',
        message: action.message,
        type: 'smart_reminder',
        meta: { actionId: action.id }
      });

      updates.push(
        supabase.from('scheduled_actions').update({ status: 'completed', executed_at: now }).eq('id', action.id)
      );
    }
    await Promise.all(updates);

  } catch (err) {
    logger.error('[Ticker] Error:', err.message);
  }
}

function stopWorker() { workerStopped = true; }

module.exports = {
  initJobWorker,
  jobWorkerLoop,
  checkScheduledActions,
  stopWorker
};
