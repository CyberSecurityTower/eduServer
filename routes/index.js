
// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();
const tasksController = require('../controllers/tasksController'); 
const authController = require('../controllers/authController'); 
const requireAuth = require('../middleware/authMiddleware');

const chatController = require('../controllers/chatController');
const analyticsController = require('../controllers/analyticsController');
const adminController = require('../controllers/adminController');
const logSessionStart = require('../controllers/analyticsController');
// Health Check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));


// 1. المرحلة الأولى: إرسال البيانات واستلام الرمز
router.post('/auth/initiate-signup', authController.initiateSignup);

// 2. المرحلة الثانية: إرسال الرمز + البيانات للتفعيل
router.post('/auth/complete-signup', authController.completeSignup);

// 3. إعادة إرسال الرمز (اختياري)
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);

// --- باقي المسارات القديمة  ---
router.post('/auth/update-password', requireAuth, authController.updatePassword);
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);
router.delete('/auth/delete-account', requireAuth, authController.deleteAccount);
// ✅ The Main Brain Route
router.post('/chat-interactive', chatController.chatInteractive);
router.post('/admin/run-night-watch', adminController.triggerNightWatch);
router.post('/admin/push-mission', adminController.pushDiscoveryMission);
router.get('/admin/keys', adminController.getKeysStatus);
router.get('/admin/dashboard-stats', adminController.getDashboardStats);
router.post('/analytics/heartbeat', analyticsController.heartbeat);
router.post('/admin/run-chrono-analysis', adminController.runDailyChronoAnalysis);
router.post('/admin/keys/add', adminController.addApiKey);
router.post('/admin/keys/revive', adminController.reviveApiKey);
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); 
router.get('/get-daily-tasks', tasksController.getDailyTasks); 
router.post('/admin/trigger-indexing', adminController.triggerFullIndexing);
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);
router.post('/run-nightly-analysis', adminController.runNightlyAnalysis);
router.post('/admin/index-lesson', adminController.indexSpecificLesson);
router.post('/admin/check-exams', adminController.triggerExamCheck);
router.post('/generate-daily-tasks', tasksController.generateDailyTasks);
router.post('/admin/ghost-scan', adminController.triggerGhostScan);
// إذا كنت تريد رابطاً لتحديث حالة المهمة (تم الإنجاز)
router.post('/update-task-status', tasksController.updateDailyTasks); 
module.exports = router;
