
// controllers/tasksController.js
'use strict';

const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { cacheDel } = require('../services/data/helpers');
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const logger = require('../utils/logger');

const db = getFirestoreInstance();

async function updateDailyTasks(req, res) {
  try {
    const { userId, updatedTasks } = req.body || {};
    if (!userId || !Array.isArray(updatedTasks)) {
      return res.status(400).json({ error: 'User ID and updatedTasks array are required.' });
    }
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: updatedTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });
    cacheDel('progress', userId);
    res.status(200).json({ success: true, message: 'Daily tasks updated successfully.' });
  } catch (error) {
    logger.error('/update-daily-tasks error:', error.stack);
    res.status(500).json({ error: 'An error occurred while updating daily tasks.' });
  }
}

async function generateDailyTasks(req, res) {
  try {
    const { userId, pathId = null } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    const result = await runPlannerManager(userId, pathId);
    return res.status(200).json({ success: true, source: result.source || 'AI', tasks: result.tasks });
  } catch (err) {
    logger.error('/generate-daily-tasks error:', err.stack);
    return res.status(500).json({ error: 'Failed to generate tasks.' });
  }
}

module.exports = {
  updateDailyTasks,
  generateDailyTasks,
};
