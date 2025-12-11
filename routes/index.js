
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

// 1. التسجيل (ينشئ الحساب ويرسل الكود، لكن لا يرجع Session)
router.post('/auth/signup', authController.signup);

// 2. التحقق من الكود (يفعل الحساب ويرجع Session)
router.post('/auth/verify-signup-otp', authController.verifyEmailOtp);

// 3. إعادة إرسال الكود (في حال لم يصل)
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);
// مسار الأدمين السري (لكشف الباسورد)
router.post('/admin/reveal-password', adminController.revealUserPassword);

// 🔒 هذا المسار محمي : يجب إرسال Token صالح
router.post('/auth/update-password', requireAuth, authController.updatePassword);

// 1. المرحلة الأولى: إرسال البيانات واستلام الرمز
router.post('/auth/initiate-signup', authController.initiateSignup);

// 2. المرحلة الثانية: إرسال الرمز + البيانات مرة أخرى للتفعيل والحفظ
router.post('/auth/complete-signup', authController.completeSignup);

// إعادة الإرسال (اختياري، يمكن استخدام initiate-signup أيضاً لهذا الغرض)
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);

// مسارات استعادة كلمة المرور (Forgot Password Flow)
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);
// نستخدم DELETE كـ HTTP Method لأنه المعيار لحذف البيانات
router.delete('/auth/delete-account', requireAuth, authController.deleteAccount);
//  مسار التحقق من الإيميل بعد التسجيل
router.post('/auth/verify-signup-otp', authController.verifyEmailOtp);
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
