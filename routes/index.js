
// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();

// Import controllers
const chatController = require('../controllers/chatController');
const analyticsController = require('../controllers/analyticsController');
const tasksController = require('../controllers/tasksController');
const quizController = require('../controllers/quizController');
const adminController = require('../controllers/adminController');

// Health Check
router.get('/health', (req, res) => {
  const { poolNames, modelPools } = require('../services/ai'); // Access directly
  try {
    res.json({ ok: true, pools: Object.fromEntries(poolNames.map(p => [p, modelPools[p].length])), time: new Date().toISOString() });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

// Chat Routes
router.post('/chat', chatController.chat);
router.post('/chat-interactive', chatController.chatInteractive);
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions);

// Analytics Routes
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);

// Tasks Routes
router.post('/update-daily-tasks', tasksController.updateDailyTasks);
router.post('/generate-daily-tasks', tasksController.generateDailyTasks);

// Quiz Routes
router.post('/analyze-quiz', quizController.analyzeQuiz);

// Admin Routes
router.post('/enqueue-job', adminController.enqueueJobRoute);
router.post('/run-nightly-analysis', adminController.runNightlyAnalysis);
router.post('/generate-title', adminController.generateTitleRoute); // Moved from chatController for separation

module.exports = router;
