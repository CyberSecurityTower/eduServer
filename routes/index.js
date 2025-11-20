
// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();

const chatController = require('../controllers/chatController');
const analyticsController = require('../controllers/analyticsController');
const adminController = require('../controllers/adminController');

// Health Check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ✅ The Main Brain Route
router.post('/chat-interactive', chatController.chatInteractive);

// Suggestions (Optional, kept for UI chips)
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); // تأكد من تصديرها في chatController

// Analytics
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);

// Admin / Background Jobs
router.post('/run-nightly-analysis', adminController.runNightlyAnalysis);

// ❌ Removed: /update-daily-tasks, /generate-daily-tasks, /analyze-quiz
// لأن هذه العمليات ستتم الآن ضمنياً داخل الشات أو عبر Widgets

module.exports = router;
