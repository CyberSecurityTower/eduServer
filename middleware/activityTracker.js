// middleware/activityTracker.js
'use strict';

const liveMonitor = require('../services/monitoring/liveStats');

// قائمة المسارات التي لا تعتبر "نشاط مستخدم"
const IGNORED_PATHS = ['/health', '/admin', '/favicon.ico'];

async function activityTracker(req, res, next) {
  // 1. تجاهل مسارات النظام من قائمة "المستخدمين النشطين" (لكن تحسب في RPM)
  const isSystemPath = IGNORED_PATHS.some(p => req.path.startsWith(p));

  // 2. محاولة استخراج الهوية
  let userId = null;
  let userInfo = {};

  // أولوية 1: إذا كان المستخدم معرفاً مسبقاً (عبر requireAuth)
  if (req.user) {
      userId = req.user.id;
      userInfo = { email: req.user.email };
  } 
  // أولوية 2: فك تشفير سريع للتوكن إذا لم يمر عبر requireAuth بعد
  else if (req.headers.authorization) {
      try {
          const token = req.headers.authorization.split(' ')[1];
          const base64Url = token.split('.')[1];
          const payload = JSON.parse(Buffer.from(base64Url, 'base64').toString());
          userId = payload.sub; // sub هو الـ ID في Supabase
          userInfo = { email: payload.email || 'TokenUser' };
      } catch (e) { /* Token invalid or not present */ }
  }

  // 3. التسجيل في الرادار
  // إذا كان مسار نظام، نمرر userId = null لكي لا يظهر في قائمة المستخدمين
  liveMonitor.trackRequest(
      isSystemPath ? null : userId, 
      userInfo, 
      req.path
  );

  next();
}

module.exports = activityTracker;
