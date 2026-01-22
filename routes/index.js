// routes/index.js
'use strict';

const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
// Controllers
const tasksController = require('../controllers/tasksController'); 
const authController = require('../controllers/authController'); 
const analyticsController = require('../controllers/analyticsController');
const chatController = require('../controllers/chatController');
const adminController = require('../controllers/adminController');
const announcementController = require('../controllers/announcementController');
const { runStreakRescueMission } = require('../services/jobs/streakRescue');
const streakController = require('../controllers/streakController'); 
const searchController = require('../controllers/searchController');
const sourceController = require('../controllers/sourceController');
const uploadMiddleware = require('../middleware/upload');
const smartQueueMiddleware = require('../middleware/smartQueue'); // استيراد الجديد
const chatBrainController = require('../controllers/ChatBrainController'); 
const arenaController = require('../controllers/arenaController'); 
const bankController = require('../controllers/bankController');
const storeController = require('../controllers/storeController');
const folderController = require('../controllers/folderController');
const subjectController = require('../controllers/subjectController'); 


/*
// ⏰ تشغيل منقذ الستريك كل ساعة (60 دقيقة)
setInterval(() => {
  console.log('⏰ Hourly Cron: Checking for streaks at risk...');
  runStreakRescueMission().catch(err => console.error(err));
}, 60 * 60 * 1000);*/
// محاولة استيراد quizController بشكل آمن (لتجنب الأخطاء إذا لم يكن الملف مكتملاً)
let quizController;
try {
    quizController = require('../controllers/quizController');
} catch (e) {
    console.warn("⚠️ QuizController not found or incomplete.");
}

// Middleware
const requireAuth = require('../middleware/authMiddleware'); // للمستخدمين
const requireAdmin = require('../middleware/requireAdmin');  // للأدمن
//index lessons (RAG system)
router.post('/admin/trigger-indexing', requireAdmin, adminController.triggerFullIndexing);

// --- Health Check ---
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ==========================================
// 1. Authentication Routes (المصادقة)
// ==========================================

// ✅ المسار الجديد للتحقق من الإيميل (Step 1)
router.post('/auth/check-email', authController.checkEmailExists);
// تسجيل الدخول والتسجيل
router.post('/auth/initiate-signup', authController.initiateSignup);
// ✅ إضافة المسار المفقود لدعم التطبيق القديم (يوجه لنفس دالة initiateSignup)
router.post('/auth/signup', authController.initiateSignup); 
router.post('/auth/complete-signup', authController.completeSignup);
router.post('/auth/resend-signup-otp', authController.resendSignupOtp);
router.post('/auth/verify-signup-otp', authController.verifyEmailOtp);

// استعادة كلمة المرور
router.post('/auth/forgot-password', authController.forgotPassword);
router.post('/auth/verify-otp', authController.verifyOtp);
router.post('/auth/reset-password', authController.resetPassword);

// ✅ إضافة المسارات المفقودة (تحديث الباسورد وحذف الحساب) مع requireAuth
router.post('/auth/update-password', requireAuth, authController.updatePassword);
router.delete('/auth/delete-account', requireAuth, authController.deleteAccount);


// ==========================================
// 2. User App Features (الميزات الأساسية)
// ==========================================

// router.post('/chat-interactive', chatController.chatInteractive);
router.post('/generate-chat-suggestions', chatController.generateChatSuggestions); 

router.post('/generate-daily-tasks', tasksController.generateDailyTasks);
router.get('/get-daily-tasks', tasksController.getDailyTasks); 
router.post('/update-task-status', tasksController.updateDailyTasks); 

router.get('/announcements', announcementController.getAnnouncements);
router.post('/announcements/:id/view', announcementController.trackView);

// Quiz Analysis (حماية ضد الكراش إذا لم تكن الدالة موجودة)
if (quizController && quizController.analyzeQuiz) {
    router.post('/analyze-quiz', quizController.analyzeQuiz);
}

// ==========================================
// 3. Analytics & Telemetry (التحليلات)
// ==========================================

// ✅ تصحيح الصلاحيات: استخدام requireAuth بدلاً من requireAdmin
// لأن التطبيق (المستخدم العادي) هو من يرسل هذه البيانات
router.post('/analytics/notification-event', requireAuth, analyticsController.trackNotificationEvent);
router.post('/analytics/campaign', requireAuth, analyticsController.trackCampaignEvent);
router.post('/telemetry/ingest', requireAuth, analyticsController.ingestTelemetryBatch);

// مسارات عامة أو محمية جزئياً
router.post('/log-event', analyticsController.logEvent);
router.post('/process-session', analyticsController.processSession);
router.post('/analytics/heartbeat', analyticsController.heartbeat);
router.post('/log-session-start', analyticsController.logSessionStart);


// ==========================================
// 4. Admin Panel Routes (لوحة التحكم - محمية) 🛡️
// ==========================================
//live traffic
router.get('/admin/live-traffic', requireAdmin, adminController.getLiveTraffic);

// Users & Groups
router.get('/admin/users', requireAdmin, adminController.getAllUsers);
router.get('/admin/users/search', requireAdmin, adminController.searchUsers);
router.get('/admin/groups', requireAdmin, adminController.getGroups);

// AI Keys
router.get('/admin/keys', requireAdmin, adminController.getKeysStatus);
router.post('/admin/keys', requireAdmin, adminController.addApiKey);
router.post('/admin/keys/revive', requireAdmin, adminController.reviveApiKey);
router.post('/admin/keys/activate-launch', requireAdmin, adminController.activateLaunchKeys);

// Announcements Admin
router.post('/admin/announcements', requireAdmin, adminController.createAnnouncement);
router.get('/admin/announcements/history', requireAdmin, adminController.getAnnouncementHistory);

// Monitoring & Stats
// ✅ استخدام getDashboardStatsV2 إذا كانت موجودة، وإلا العودة للنسخة القديمة لتجنب الكراش
const dashboardStatsHandler = adminController.getDashboardStatsV2 || adminController.getDashboardStats;
router.get('/admin/dashboard-stats', requireAdmin, dashboardStatsHandler);
router.get('/admin/stats/activity-chart', requireAdmin, adminController.getActivityChart);

// Settings
router.get('/admin/settings', requireAdmin, adminController.getSystemSettings);
router.patch('/admin/settings', requireAdmin, adminController.updateSystemSetting);
router.post('/admin/toggle-feature', requireAdmin, adminController.toggleSystemFeature);

// مسار لفحص سياق المنهج
router.get('/admin/debug-curriculum', adminController.debugCurriculumContext);
// Tools & Triggers
router.post('/admin/run-night-watch', requireAdmin, adminController.triggerNightWatch);
router.post('/admin/trigger-indexing', requireAdmin, adminController.triggerFullIndexing);
router.post('/admin/ghost-scan', requireAdmin, adminController.triggerGhostScan);
router.post('/admin/check-exams', requireAdmin, adminController.triggerExamCheck);
router.post('/admin/push-mission', requireAdmin, adminController.pushDiscoveryMission);
router.post('/admin/index-lesson', requireAdmin, adminController.indexSpecificLesson);
router.post('/admin/run-chrono-analysis', requireAdmin, adminController.runDailyChronoAnalysis);
router.post('/admin/reveal-password', requireAdmin, adminController.revealUserPassword);
router.post('/admin/run-streak-rescue', requireAdmin, adminController.triggerStreakRescue);
router.post('/admin/generate-atomic-structures', requireAdmin, adminController.generateAtomicStructuresBatch);

// ==========================================
// 5. Wallet & Economy (EduCoin) 🪙
// ==========================================
router.get('/wallet/balance', requireAuth, walletController.getBalance);
router.post('/wallet/spend', requireAuth, walletController.spendCoins);
// ==========================================
// 6. Streak & Daily Rewards 🔥
// ==========================================
// يتطلب requireAuth لأننا نحتاج معرف المستخدم
router.post('/streak/check-in', requireAuth, streakController.dailyCheckIn);
router.get('/streak/status', requireAuth, streakController.getStreakStatus);
// Cron Job
router.post('/run-nightly-analysis', adminController.runNightlyAnalysis);

// ==========================================
// 7. Quick look (البحث السريع) 🔍
// ==========================================
// يتطلب مصادقة (requireAuth)
router.post('/search/quick', requireAuth, searchController.quickSearch);


// ==========================================
// 8. Lesson Sources (Multi-upload System) 📂
// ==========================================
// رفع ملف جديد (يقبل حقل اسمه 'file')
router.post(
    '/sources/upload', 
    requireAuth, 
    smartQueueMiddleware, // 1. الشرطي يحسب الحجم ويشوف لا يفوت ولا يستنى
    uploadMiddleware.single('file'), // 2. إذا فات، Multer يرفعو
    sourceController.uploadFile // 3. الكونترولر يبعثو لـ Cloudinary
);

// نقل ملف (Move)
router.patch('/sources/:sourceId/move', requireAuth, sourceController.moveFile);

//   تعديل اسم الملف
router.patch('/sources/:sourceId/rename', requireAuth, sourceController.renameFile);

// ربط ملف بمادة أو درس (يقبل arrays في الـ body)
router.post('/sources/link', requireAuth, sourceController.linkSourceToContext);

// جلب كل ملفات المستخدم (تم تحديث المسار)
router.get('/sources/my-library', requireAuth, sourceController.getAllUserSources);
// جلب الملفات الخاصة بدرس معين
router.get('/sources/lesson/:lessonId', requireAuth, sourceController.getLessonFiles);

// حذف ملف
router.delete('/sources/:sourceId', requireAuth, sourceController.deleteFile);

//   جلب مكتبة ملفات المستخدم كاملة
router.get('/sources/all', requireAuth, sourceController.getAllUserSources); 
// المسار الجديد لجلب التاريخ (للـ MiniChatPanel)
router.get('/chat/history', chatBrainController.getChatHistory);

//  المسار الجديد (الأقوى والأشمل)
// يدعم: Web Search, Files, Context Awareness
// مسار الشات الرئيسي 

router.post('/chat/process', chatBrainController.processChat);

// إحصائيات المكتبة (عدد وحجم الملفات المرفوعة والمشتراة)
router.get('/library/stats', requireAuth, sourceController.getLibraryStats);

// ==========================================
// 9. Arena (Exam System) ⚔️
// ==========================================
// توليد امتحان لدرس معين
router.get('/arena/generate/:lessonId', requireAuth, arenaController.generateExam);

// تقديم الإجابات وتصحيحها
router.post('/arena/submit', requireAuth, arenaController.submitExam);

// 🏦 Question Bank Generator (System Lockdown Trigger)

// 1. Start Generator
router.post('/admin/generate-bank', requireAdmin, bankController.triggerBankGeneration);

// 2. Stop Generator (Emergency)
router.post('/admin/stop-bank', requireAdmin, bankController.stopBankGeneration);



// ==========================================
// 🛒 EduStore Routes
// ==========================================

// 1. تصفح المتجر (للجميع - يحتاج Auth لمعرفة ماذا تملك)
router.get('/store/items', requireAuth, storeController.getStoreItems);

// 2. شراء عنصر
router.post('/store/purchase', requireAuth, storeController.purchaseItem);

// 3. مكتبتي (Inventory)
router.get('/store/inventory', requireAuth, storeController.getMyInventory);

// 4. (Admin) إضافة منتج جديد
// نستخدم نفس uploadMiddleware المستخدم سابقاً
router.post(
    '/admin/store/add', 
    requireAdmin, 
    uploadMiddleware.single('file'), 
    storeController.addStoreItem
);

// 5. قراءة محتوى الملف (Secure Access)
// هذا المسار يستخدم getItemContent للتحقق من الملكية قبل إرجاع النص والرابط
router.get('/store/item/:itemId/content', requireAuth, storeController.getItemContent);

// جلب المنتجات المتوفرة فقط (التي لم يشتريها بعد)
router.get('/store/available', requireAuth, storeController.getAvailableItems);

// حذف عنصر من المكتبة (Inventory)
router.delete('/store/inventory/:itemId', requireAuth, storeController.removeFromInventory);

// ==========================================
// 📂 Folder Management (EduDrive) - NEW
// ==========================================
router.get('/folders', requireAuth, folderController.getUserFolders);
router.post('/folders', requireAuth, folderController.createFolder);
router.put('/folders/reorder', requireAuth, folderController.reorderFolders); // إعادة الترتيب
router.patch('/folders/:folderId', requireAuth, folderController.updateFolder); // تغيير الاسم/اللون
router.delete('/folders/:folderId', requireAuth, folderController.deleteFolder);



// ✅ المسار الجديد لجلب المواد
router.get('/subjects/mine', requireAuth, subjectController.getMySubjects);

// ✅✅✅ أضف هذا السطر الجديد لحل المشكلة ✅✅✅
router.get('/educational/lessons', requireAuth, subjectController.getLessonsBySubject);
router.post('/admin/fix-file-sizes', requireAdmin, adminController.fixRealFileSizes);

module.exports = router;
