// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();

// Controllers
const tasksController = require('../controllers/tasksController'); 
const authController = require('../controllers/authController'); 
const analyticsController = require('../controllers/analyticsController');
const chatController = require('../controllers/chatController');
const adminController = require('../controllers/adminController');
const announcementController = require('../controllers/announcementController');
const quizController = require('../controllers/quizController'); // تأكد من وجود هذا إذا كنت تستخدمه

// Middleware
const requireAuth = require('../middleware/authMiddleware'); // للمستخدمين المسجلين
const requireAdmin = require('../middleware/requireAdmin');  // للأدمن فقط

// --- Health Check ---
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ==========================================
// 1. Authentication Routes (المصادقة)
// ==========================================

// تسجيل الدخول والتسجيل
router.post('/auth/initiate-signup', authController.initiateSignup);
router.post('/auth/signup', authController.initiateSignup); // ✅ تم الحل: إضافة رابط للتوافق مع التطبيق
router.post('/auth/complete-signup', authController.completeSignup);
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);
router.post('/auth/verify-signup-otp', authController.verifyEmailOtp);

// استعادة كلمة المرور
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);

// إدارة الحساب (يحتاج تسجيل دخول requireAuth)
// 🟠 تم الحل: تغيير الصلاحية من requireAdmin إلى requireAuth ليتمكن المستخدم من تعديل حسابه
router.post('/auth/update-password', requireAuth, authController.updatePassword);
router.delete('/auth/delete-account', requireAuth, authController.deleteAccount);


// ==========================================
// 2. User App Features (الميزات الأساسية)
// ==========================================

// Chat & AI
router.post('/chat-interactive', chatController.chatInteractive);
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); 

// Tasks & Planning
router.post('/generate-daily-tasks', tasksController.generateDailyTasks);
router.get('/get-daily-tasks', tasksController.getDailyTasks); 
router.post('/update-task-status', tasksController.updateDailyTasks); 

// Announcements (Public for users)
router.get('/announcements', announcementController.getAnnouncements);
router.post('/announcements/:id/view', announcementController.trackView);

// Quiz Analysis
if (quizController && quizController.analyzeQuiz) {
    router.post('/analyze-quiz', quizController.analyzeQuiz);
}


// ==========================================
// 3. Analytics & Telemetry (التحليلات)
// ==========================================

// 🟠 تم الحل: هذه المسارات كانت تتطلب Admin، الآن تتطلب Auth فقط لتسجيل بيانات المستخدمين
router.post('/log-event', analyticsController.logEvent); // يمكن تركه عام أو requireAuth حسب الحاجة
router.post('/process-session', analyticsController.processSession);
router.post('/analytics/heartbeat', analyticsController.heartbeat);
router.post('/log-session-start', analyticsController.logSessionStart);

// المسارات التي كانت تسبب خطأ 403 Forbidden
router.post('/analytics/notification-event', requireAuth, analyticsController.trackNotificationEvent);
router.post('/analytics/campaign', requireAuth, analyticsController.trackCampaignEvent);
router.post('/telemetry/ingest', requireAuth, analyticsController.ingestTelemetryBatch);


// ==========================================
// 4. Admin Panel Routes (لوحة التحكم - محمية) 🛡️
// ==========================================

// Users & Keys
router.get('/admin/users', requireAdmin, adminController.getAllUsers);
router.get('/admin/users/search', requireAdmin, adminController.searchUsers);
router.get('/admin/groups', requireAdmin, adminController.getGroups);

// AI Keys Management
router.get('/admin/keys', requireAdmin, adminController.getKeysStatus);
router.post('/admin/keys', requireAdmin, adminController.addApiKey);
router.post('/admin/keys/revive', requireAdmin, adminController.reviveApiKey);
router.post('/admin/keys/activate-launch', requireAdmin, adminController.activateLaunchKeys);

// Announcements Management
router.post('/admin/announcements', requireAdmin, adminController.createAnnouncement);
router.get('/admin/announcements/history', requireAdmin, adminController.getAnnouncementHistory);

// Monitoring & Stats
router.get('/admin/stats/activity-chart', requireAdmin, adminController.getActivityChart);
router.get('/admin/dashboard-stats', requireAdmin, adminController.getDashboardStatsV2); // أو getDashboardStats

// System Settings & Feature Flags
router.get('/admin/settings', requireAdmin, adminController.getSystemSettings);
router.patch('/admin/settings', requireAdmin, adminController.updateSystemSetting); // أو toggleSystemFeature
router.post('/admin/toggle-feature', requireAdmin, adminController.toggleSystemFeature);

// Advanced Tools (Jobs & Triggers)
router.post('/admin/run-night-watch', requireAdmin, adminController.triggerNightWatch);
router.post('/admin/trigger-indexing', requireAdmin, adminController.triggerFullIndexing);
router.post('/admin/ghost-scan', requireAdmin, adminController.triggerGhostScan);
router.post('/admin/check-exams', requireAdmin, adminController.triggerExamCheck);
router.post('/admin/push-mission', requireAdmin, adminController.pushDiscoveryMission);
router.post('/admin/index-lesson', requireAdmin, adminController.indexSpecificLesson);
router.post('/admin/run-chrono-analysis', requireAdmin, adminController.runDailyChronoAnalysis);
router.post('/admin/reveal-password', requireAdmin, adminController.revealUserPassword);

// Cron Job Entry Point (يستخدم Secret Header بدلاً من التوكن)
router.post('/run-nightly-analysis', adminController.runNightlyAnalysis);

module.exports = router;
