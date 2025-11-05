
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const { escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const logger = require('../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initAdminController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Admin Controller requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

const db = getFirestoreInstance();

async function runNightlyAnalysisForUser(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;
    const userCreationDate = userDoc.createTime.toDate();
    const daysSinceJoined = (new Date() - userCreationDate) / (1000 * 60 * 60 * 24);
    if (daysSinceJoined < 3) {
      return;
    }

    const eventsSnapshot = await db.collection('userBehaviorAnalytics').doc(userId).collection('events')
      .where('name', '==', 'app_open')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    let primeTimeHour = 20;
    if (!eventsSnapshot.empty) {
      const hours = eventsSnapshot.docs.map(doc => doc.data().timestamp.toDate().getHours());
      const hourCounts = hours.reduce((acc, hour) => {
        acc[hour] = (acc[hour] || 0) + 1;
        return acc;
      }, {});
      primeTimeHour = parseInt(Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b));
    }

    const reEngagementMessage = await runReEngagementManager(userId);
    if (!reEngagementMessage) return;

    const scheduleTime = new Date();
    scheduleTime.setHours(primeTimeHour - 1, 30, 0, 0);

    await enqueueJob({
      type: 'scheduled_notification',
      userId: userId,
      payload: {
        title: 'اشتقنا لوجودك!',
        message: reEngagementMessage,
      },
      sendAt: admin.firestore.Timestamp.fromDate(scheduleTime)
    });

  } catch (error) {
    logger.error(`Nightly analysis failed for user ${userId}:`, error);
  }
}

async function enqueueJobRoute(req, res) {
  try {
    const job = req.body;
    if (!job) return res.status(400).json({ error: 'job body required' });
    const id = await enqueueJob(job);
    return res.json({ jobId: id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
}

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    res.status(202).json({ message: 'Nightly analysis job started.' });

    logger.log(`Starting nightly analysis...`);

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const inactiveUsersSnapshot = await db.collection('userProgress')
      .where('lastLogin', '<', twoDaysAgo.toISOString()) // Ensure string comparison
      .get();

    if (inactiveUsersSnapshot.empty) {
      logger.log('No inactive users found. Job finished.');
      return;
    }

    const analysisPromises = [];
    inactiveUsersSnapshot.forEach(doc => {
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    logger.log(`Nightly analysis finished for ${inactiveUsersSnapshot.size} users.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
  }
}

async function generateTitleRoute(req, res) {
  try {
    const { message, language = 'Arabic' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text, no JSON or extra words.\n\nMessage: "${escapeForPrompt(safeSnippet(message, 300))}"\n\nTitle:`;

    if (!generateWithFailoverRef) {
      logger.error('generateTitleRoute: generateWithFailover is not set.');
      return res.status(500).json({ title: message.substring(0, 30) });
    }
    const modelResp = await generateWithFailoverRef('titleIntent', prompt, {
      label: 'GenerateTitle',
      timeoutMs: 5000,
    });

    const title = await extractTextFromResult(modelResp);

    if (!title) {
      return res.json({ title: message.substring(0, 30) });
    }

    return res.json({ title: title.replace(/["']/g, '') });
  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    const fallbackTitle = req.body.message ? req.body.message.substring(0, 30) : 'New Chat';
    return res.status(500).json({ title: fallbackTitle });
  }
}

module.exports = {
  initAdminController,
  enqueueJobRoute,
  runNightlyAnalysis,
  generateTitleRoute,
};
