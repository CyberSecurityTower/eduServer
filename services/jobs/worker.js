
'use strict';

const CONFIG = require('../../config');
const supabase = require('../data/supabase');
const { nowISO } = require('../data/dbUtils');
const { sendUserNotification } = require('../data/helpers');
const { runPlannerManager } = require('../ai/managers/plannerManager');
const { runToDoManager } = require('../ai/managers/todoManager'); 
const logger = require('../../utils/logger');

let workerStopped = false;
let handleGeneralQuestionRef; 

function initJobWorker(dependencies) {
  if (!dependencies.handleGeneralQuestion) throw new Error('Job Worker requires handleGeneralQuestion.');
  handleGeneralQuestionRef = dependencies.handleGeneralQuestion;
  logger.success('Job Worker Initialized (Supabase).');
}

async function processJob(job) {
  const { id, user_id, type, payload } = job;
  logger.log(`[Worker] Processing ${type} for ${user_id}`);

  try {
    // Mark as processing
    await supabase.from('jobs').update({ status: 'processing', started_at: nowISO() }).eq('id', id);

    if (type === 'background_chat') {
       // Chat Logic Here (Simplified)
       if (handleGeneralQuestionRef) {
          const reply = await handleGeneralQuestionRef(payload.message, payload.language || 'Arabic', 'Student');
          await sendUserNotification(user_id, {
             title: 'EduAI Reply', message: reply, type: 'chat', meta: { jobId: id }
          });
       }
    } else if (type === 'generate_plan') {
       // Planner Logic
       await runPlannerManager(user_id, payload.pathId); // Assuming planner is updated to Supabase
    }

    // Mark done
    await supabase.from('jobs').update({ status: 'done', finished_at: nowISO() }).eq('id', id);

  } catch (err) {
    logger.error(`Job ${id} failed:`, err);
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
    const now = nowISO();

    // 1. Reset Scheduled
    await supabase.from('jobs').update({ status: 'queued' }).eq('status', 'scheduled').lte('send_at', now);

    // 2. Fetch Queued
    const { data: jobs } = await supabase.from('jobs').select('*').eq('status', 'queued').order('created_at').limit(5);

    if (jobs?.length) await Promise.all(jobs.map(processJob));

  } catch (err) {
    logger.error('Worker Loop Error:', err);
  } finally {
    if (!workerStopped) setTimeout(jobWorkerLoop, CONFIG.JOB_POLL_MS);
  }
}

async function checkScheduledActions() {
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
    logger.error('[Ticker] Error:', err);
  }
}

module.exports = {
  initJobWorker,
  jobWorkerLoop,
  stopWorker,
  checkScheduledActions
};
