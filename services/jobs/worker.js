
'use strict';

const CONFIG = require('../../config');
const { getFirestoreInstance, admin } = require('../data/firestore');
const { sendUserNotification, getProgress } = require('../data/helpers');
const { runNotificationManager } = require('../ai/managers/notificationManager');
const { runPlannerManager } = require('../ai/managers/plannerManager');
const { runToDoManager } = require('../ai/managers/todoManager');
const logger = require('../../utils/logger');

let db;
let workerStopped = false;
let handleGeneralQuestionRef;

function initJobWorker(dependencies) {
  if (!dependencies.handleGeneralQuestion) {
    throw new Error('Job Worker requires handleGeneralQuestion for initialization.');
  }
  db = getFirestoreInstance();
  handleGeneralQuestionRef = dependencies.handleGeneralQuestion;
  logger.success('Job Worker Initialized.');
}

// --- NEW: Function to reset stuck jobs ---
async function resetStuckJobs() {
  try {
    logger.info('[Worker] Checking for stuck jobs...');
    const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const cutoffTime = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const timestamp = admin.firestore.Timestamp.fromDate(cutoffTime);

    // Query jobs that are 'processing' and started before the cutoff time
    const snapshot = await db.collection('jobs')
      .where('status', '==', 'processing')
      .where('startedAt', '<', timestamp)
      .get();

    if (snapshot.empty) {
      logger.info('[Worker] No stuck jobs found.');
      return;
    }

    logger.warn(`[Worker] Found ${snapshot.size} stuck jobs. Resetting to queued...`);
    
    const batch = db.batch();
    let count = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      const currentAttempts = data.attempts || 0;
      
      // If it failed too many times even after reset, mark as failed
      if (currentAttempts >= 3) {
        batch.update(doc.ref, { 
          status: 'failed', 
          lastError: 'Stuck in processing for too long (timeout)',
          finishedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        batch.update(doc.ref, { 
          status: 'queued', 
          startedAt: null, // Clear start time
          lastError: 'System crash or restart detected - Retrying'
        });
      }
      count++;
    });

    await batch.commit();
    logger.success(`[Worker] Successfully reset ${count} stuck jobs.`);
  } catch (err) {
    logger.error('[Worker] Failed to reset stuck jobs:', err.message);
  }
}
// -----------------------------------------

function formatTasksHuman(tasks = [], lang = 'Arabic') {
  if (!Array.isArray(tasks)) return '';
  return tasks.map((t, i) => `${i + 1}. ${t.title} [${t.type}]`).join('\n');
}

async function processJob(jobDoc) {
  const id = jobDoc.id;
  const data = jobDoc.data();

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
        const progress = await getProgress(userId);
        const currentTasks = progress?.dailyTasks?.tasks || [];
        const { change } = await runToDoManager(userId, message, currentTasks);

        let notificationType = 'task_updated';
        if (change.action === 'completed') notificationType = 'task_completed';
        if (change.action === 'added') notificationType = 'task_added';
        if (change.action === 'removed') notificationType = 'task_removed';

        const notificationMessage = await runNotificationManager(notificationType, language, { taskTitle: change.taskTitle });

        await sendUserNotification(userId, {
          title: 'Tasks Updated',
          message: notificationMessage,
          lang: language,
          meta: { jobId: id, source: 'tasks' }
        });

      } else if (intent === 'generate_plan') {
        const pathId = payload.pathId || null;
        const result = await runPlannerManager(userId, pathId);
        const humanSummary = formatTasksHuman(result.tasks, language);
        await sendUserNotification(userId, {
          title: 'New Study Plan',
          message: `Your new study plan is ready:\n${humanSummary}`,
          lang: language,
          meta: { jobId: id, source: 'planner' }
        });

      } else {
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
        }
      }

      await jobDoc.ref.update({ status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });

    } else if (type === 'scheduled_notification') {
      await sendUserNotification(userId, payload);
      await jobDoc.ref.update({ status: 'done', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      await jobDoc.ref.update({ status: 'skipped', finishedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

  } catch (err) {
    logger.error('processJob error for', id, err.message || err);
    const attempts = (data.attempts || 0) + 1;
    const update = {
      attempts,
      lastError: String(err.message || err),
      status: attempts >= 3 ? 'failed' : 'queued'
    };
    if (attempts >= 3) update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
    await jobDoc.ref.update(update);
  }
}

async function jobWorkerLoop() {
  if (workerStopped) return;
  try {
    const now = admin.firestore.Timestamp.now();
    const scheduledJobs = await db.collection('jobs')
      .where('status', '==', 'scheduled')
      .where('sendAt', '<=', now)
      .get();

    scheduledJobs.forEach(doc => {
      doc.ref.update({ status: 'queued' });
    });

    const q = await db.collection('jobs').where('status', '==', 'queued').orderBy('createdAt').limit(5).get();
    if (!q.empty) {
      const promises = [];
      q.forEach(doc => { promises.push(processJob(doc)); });
      await Promise.all(promises);
    }
  } catch (err) {
    logger.error('jobWorkerLoop error:', err.message || err);
  } finally {
    if (!workerStopped) setTimeout(jobWorkerLoop, CONFIG.JOB_POLL_MS);
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
  processJob, // Export for testing/admin
  resetStuckJobs,
};
