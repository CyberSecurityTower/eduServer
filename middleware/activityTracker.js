// middleware/activityTracker.js
'use strict';

const liveMonitor = require('../services/monitoring/liveStats');
const jwt = require('jsonwebtoken'); // نحتاج لفك التشفير يدوياً إذا لزم الأمر

// قائمة المسارات التي لا تعتبر "نشاط مستخدم"
const IGNORED_PATHS = ['/health', '/favicon.ico'];

async function activityTracker(req, res, next) {
  if (IGNORED_PATHS.some(p => req.path.startsWith(p))) return next();

  let userId = null;
  let userInfo = {};

  // محاولة استخراج الهوية بذكاء
  try {
      // 1. إذا كان المستخدم معرفاً مسبقاً
      if (req.user) {
          userId = req.user.id;
          userInfo = { email: req.user.email };
      } 
      // 2. إذا لم يكن معرفاً، نحاول فك التوكن يدوياً (لأن هذا الميدلوير قد يعمل قبل Auth)
      else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
          const token = req.headers.authorization.split(' ')[1];
          // فك تشفير بسيط (بدون تحقق من التوقيع للسرعة، التحقق يتم في Auth Middleware)
          const base64Url = token.split('.')[1];
          if (base64Url) {
              const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
              const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
              userId = payload.sub; // Supabase ID
              userInfo = { email: payload.email || 'User' };
          }
      }
  } catch (e) {
      // تجاهل الأخطاء، ربما المستخدم زائر
  }

  // إرسال البيانات للرادار
  if (userId) {
      liveMonitor.trackHttpRequest(userId, userInfo, req.path);
  }

  next();
}

module.exports = activityTracker;
