
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

// مسار التسجيل الجديد (يستقبل البيانات من التطبيق)
router.post('/auth/signup', authController.signup);
// مسار الأدمين السري (لكشف الباسورد)
router.post('/admin/reveal-password', adminController.revealUserPassword);

// 🔒 هذا المسار محمي : يجب إرسال Token صالح
router.post('/auth/update-password', requireAuth, authController.updatePassword);

// التسجيل لا يحتاج حماية (لأنه مستخدم جديد)
router.post('/auth/signup', authController.signup);

// مسارات استعادة كلمة المرور (Forgot Password Flow)
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);
// نستخدم DELETE كـ HTTP Method لأنه المعيار لحذف البيانات
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
