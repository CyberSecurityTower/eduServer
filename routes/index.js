
// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();
const tasksController = require('../controllers/tasksController'); 
const authController = require('../controllers/authController'); 
const requireAdmin = require('../middleware/requireAdmin');
const analyticsController = require('../controllers/analyticsController');
const chatController = require('../controllers/chatController');
const adminController = require('../controllers/adminController');
const logSessionStart = require('../controllers/analyticsController');

const announcementController = require('../controllers/announcementController'); // ✅ جديد

// Middleware
const requireAuth = require('../middleware/authMiddleware'); 

// Health Check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
// ✅ Endpoint تتبع الإشعارات الذكي
router.post('/analytics/notification-event', requireAdmin, analyticsController.trackNotificationEvent);
// ✅ مسار تتبع الحملات الإعلانية (محمي بالتوكن)
router.post('/analytics/campaign', requireAdmin, analyticsController.trackCampaignEvent);
// 1. المرحلة الأولى: إرسال البيانات واستلام الرمز
router.post('/auth/initiate-signup', authController.initiateSignup);

// 2. المرحلة الثانية: إرسال الرمز + البيانات للتفعيل
router.post('/auth/complete-signup', authController.completeSignup);

// 3. إعادة إرسال الرمز (اختياري)
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);

router.get('/admin/users', adminController.getAllUsers);

// --- باقي المسارات القديمة  ---
router.post('/auth/update-password', requireAdmin, authController.updatePassword);
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);
router.delete('/auth/delete-account', requireAdmin, authController.deleteAccount);
router.post('/admin/toggle-feature', adminController.toggleSystemFeature);

// ✅ مسار التتبع الجديد (يجب أن يكون محمياً)
router.post('/telemetry/ingest', requireAdmin, analyticsController.ingestTelemetryBatch);
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
// -------- V2 --------

// --- Public / Health ---
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// --- Auth Routes ---
router.post('/auth/initiate-signup', authController.initiateSignup);
router.post('/auth/complete-signup', authController.completeSignup);
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);

// --- User App Routes ---
router.post('/chat-interactive', chatController.chatInteractive);
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); 
router.post('/generate-daily-tasks', tasksController.generateDailyTasks);
router.get('/get-daily-tasks', tasksController.getDailyTasks); 
router.post('/update-task-status', tasksController.updateDailyTasks); 
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);
router.post('/analytics/heartbeat', analyticsController.heartbeat);

// ✅ EduApp Integration (Announcements)
router.get('/announcements', announcementController.getAnnouncements);
router.post('/announcements/:id/view', announcementController.trackView);

// --- Admin Panel Routes (Protected) --- 🛡️

// 1. Announcements Tower
router.post('/admin/announcements', requireAdmin, adminController.createAnnouncement);
router.get('/admin/announcements/history', requireAdmin, adminController.getAnnouncementHistory);

// 2. Monitoring & Stats
router.get('/admin/stats/activity-chart', requireAdmin, adminController.getActivityChart);
router.get('/admin/dashboard-stats', requireAdmin, adminController.getDashboardStatsV2); // النسخة المحدثة

// 3. AI Keys Management
router.get('/admin/keys', requireAdmin, adminController.getKeysStatus);
router.post('/admin/keys', requireAdmin, adminController.addApiKey); // إضافة
router.post('/admin/keys/revive', requireAdmin, adminController.reviveApiKey);

// 4. Feature Flags (Settings)
router.get('/admin/settings', requireAdmin, adminController.getSystemSettings);
router.patch('/admin/settings', requireAdmin, adminController.updateSystemSetting);

// 5. Night Watch & Tools
router.post('/admin/run-night-watch', requireAdmin, adminController.triggerNightWatch);
router.post('/admin/trigger-indexing', requireAdmin, adminController.triggerFullIndexing);
router.post('/admin/ghost-scan', requireAdmin, adminController.triggerGhostScan);
router.post('/admin/check-exams', requireAdmin, adminController.triggerExamCheck);
router.get('/admin/users', requireAdmin, adminController.getAllUsers);
router.post('/admin/push-mission', requireAdmin, adminController.pushDiscoveryMission);

// --- Analytics (Protected) ---
router.post('/analytics/notification-event', requireAdmin, analyticsController.trackNotificationEvent);
router.post('/analytics/campaign', requireAdmin, analyticsController.trackCampaignEvent);
router.post('/telemetry/ingest', requireAdmin, analyticsController.ingestTelemetryBatch);

// ✅ أدوات المساعدة للوحة التحكم (Admin Helpers)
router.get('/admin/groups', requireAdmin, adminController.getGroups);
router.get('/admin/users/search', requireAdmin, adminController.searchUsers);
module.exports = router;
module.exports = router;
