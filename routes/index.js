
// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();

const chatController = require('../controllers/chatController');
const analyticsController = require('../controllers/analyticsController');
const adminController = require('../controllers/adminController');
const logSessionStart = require('../controllers/analyticsController');
// Health Check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ✅ The Main Brain Route
router.post('/chat-interactive', chatController.chatInteractive);

// Suggestions (Optional, kept for UI chips)
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); // تأكد من تصديرها في chatController

// Analytics
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);

module.exports = router;
