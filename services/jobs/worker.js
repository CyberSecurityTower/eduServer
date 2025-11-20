
// services/jobs/worker.js
'use strict';

const CONFIG = require('../../config');
const { getFirestoreInstance, admin } = require('../data/firestore');
const { sendUserNotification, getProgress, cacheDel } = require('../data/helpers');
const { runNotificationManager } = require('../ai/managers/notificationManager');
const { runPlannerManager } = require('../ai/managers/plannerManager');
const { runToDoManager } = require('../ai/managers/todoManager'); 
const { handleGeneralQuestion } = require('../../controllers/chatController');
const logger = require('../../utils/logger');

let db;
let workerStopped = false;
let handleGeneralQuestionRef; // Injected dependency

function initJobWorker(dependencies) {
  if (!dependencies.handleGeneralQuestion) {
    throw new Error('Job Worker requires handleGeneralQuestion for initialization.');
  }
  db = getFirestoreInstance();
  handleGeneralQuestionRef = dependencies.handleGeneralQuestion;
  logger.success('Job Worker Initialized.');
}

function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

// --- Job Processor (Queue System) ---
async function processJob(jobDoc) {
  const id = jobDoc.id;
  const data = jobDoc.data();
  logger.log(`[Worker] Starting job ${id} of type ${data.type}`);

  try {
    await jobDoc.ref.update({
      status: 'processing',
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const { userId, type, payload } = data;
    if (!payload || typeof payload !== 'object') {
      throw new Error('Missing or invalid payload');
    }

    const message = payload.message || '';
    const intent = payload.intent || null;
    const language = payload.language || 'Arabic';

    if (type === 'background_chat') {
      if (intent === 'manage_todo') {
        logger.log(`[Worker] Job ${id}: Handling manage_todo for user ${userId}`);
        const progress = await getProgress(userId);
        const currentTasks = progress?.dailyTasks?.tasks || [];
        
        const { updatedTasks = [], change = {} } = await runToDoManager(userId, message, currentTasks);
        const action = change.action || 'updated';
        const taskTitle = change.taskTitle || '';

        let notificationType = 'task_updated';
        if (action === 'completed') notificationType = 'task_completed';
        if (action === 'added') notificationType = 'task_added';
        if (action === 'removed') notificationType = 'task_removed';

        const notificationMessage = await runNotificationManager(notificationType, language, { taskTitle });

        await sendUserNotification(userId, {
          title: 'تم تحديث المهام',
          message: notificationMessage,
          lang: language,
          meta: { jobId: id, source: 'tasks' }
        });
        logger.log(`[Worker] Job ${id}: Notification sent for todo change (${action}).`);

      } else if (intent === 'generate_plan') {
        logger.log(`[Worker] Job ${id}: Handling generate_plan for user ${userId}`);
        const pathId = payload.pathId || null;
        const result = await runPlannerManager(userId, pathId);
        const tasks = result?.tasks || [];
        const humanSummary = formatTasksHuman(tasks, language);
        await sendUserNotification(userId, {
          title: 'New Study Plan',
          message: `Your new study plan is ready:\n${humanSummary}`,
          lang: language,
          meta: { jobId: id, source: 'planner' }
        });
        logger.log(`[Worker] Job ${id}: Planner notification sent. Tasks: ${tasks.length}`);

      } else {
        // General chat handling
        if (!handleGeneralQuestionRef) {
          logger.error('processJob: handleGeneralQuestion is not set.');
          await sendUserNotification(userId, {
            title: 'Error',
            message: 'Failed to process your request due to an internal error.',
            meta: { jobId: id, source: 'chat' }
          });
        } else {
          const { getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName } = require('../data/helpers');
          const [userProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
            getProfile(userId),
            getProgress(userId),
            fetchUserWeaknesses(userId),
            formatProgressForAI(userId),
            getUserDisplayName(userId)
          ]);

          const reply = await handleGeneralQuestionRef(
            payload.message, payload.language || 'Arabic', payload.history || [],
            userProfile, userProgress, weaknesses, formattedProgress, userName
          );
          await sendUserNotification(userId, {
            title: 'New Message from EduAI',
            message: reply,
            meta: { jobId: id, source: 'chat' }
          });
          logger.log(`[Worker] Job ${id}: Chat reply sent.`);
        }
      }
    } else {
      logger.log(`[Worker] Job ${id}: Unsupported job type ${type}`);
    }

    await jobDoc.ref.update({ status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
    logger.success(`[Worker] Job ${id} completed successfully.`);

  } catch (err) {
    logger.error(`[Worker] processJob error for ${id}`, err.stack || err);
    const attempts = (data.attempts || 0) + 1;
    const update = {
      attempts,
      lastError: String(err.message || err),
      status: attempts >= 3 ? 'failed' : 'queued'
    };
    if (attempts >= 3) update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
    try {
      await jobDoc.ref.update(update);
    } catch (uErr) {
      logger.error(`[Worker] Failed to update job ${id} status after error:`, uErr.message || uErr);
    }
  }
}

// --- Worker Loop (Processing Queue) ---
async function jobWorkerLoop() {
  if (workerStopped) return;
  try {
    const now = admin.firestore.Timestamp.now();
    const scheduledJobs = await db.collection('jobs')
      .where('status', '==', 'scheduled')
      .where('sendAt', '<=', now)
      .get();

    if (!scheduledJobs.empty) {
      const updPromises = [];
      scheduledJobs.forEach(doc => {
        updPromises.push(doc.ref.update({ status: 'queued' }));
      });
      await Promise.all(updPromises);
    }

    const q = await db.collection('jobs').where('status', '==', 'queued').orderBy('createdAt').limit(5).get();
    if (!q.empty) {
      const promises = [];
      q.forEach(doc => { promises.push(processJob(doc)); });
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

// ✅✅✅ THE NEW TICKER FUNCTION (SMART SCHEDULER) ✅✅✅
async function checkScheduledActions() {
  try {
    const now = admin.firestore.Timestamp.now();
    
    // 1. Find actions that are pending AND their execution time has passed (or is now)
    const snapshot = await db.collection('scheduledActions')
      .where('status', '==', 'pending')
      .where('executeAt', '<=', now)
      .limit(50) // Batch size to prevent overload
      .get();

    if (snapshot.empty) return; // Nothing to do

    logger.log(`[Ticker] Found ${snapshot.size} scheduled actions due.`);
    
    const batch = db.batch();
    const promises = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // 2. Send the Notification (Title/Message was already prepared by AI)
      const notifPromise = sendUserNotification(data.userId, {
        title: data.title || 'تذكير ذكي',
        message: data.message, 
        type: data.type || 'smart_reminder',
        meta: { actionId: doc.id, source: 'scheduler' }
      });
      promises.push(notifPromise);

      // 3. Mark as Completed in DB
      batch.update(doc.ref, {
        status: 'completed',
        executedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // 4. Execute all
    await Promise.all(promises); // Send notifications
    await batch.commit(); // Update DB status
    
    logger.success(`[Ticker] Successfully executed ${snapshot.size} actions.`);

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
  checkScheduledActions // ✅ Exported to be used in index.js
};
