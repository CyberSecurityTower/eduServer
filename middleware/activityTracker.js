// middleware/activityTracker.js
'use strict';

const liveMonitor = require('../services/monitoring/liveStats');

const IGNORED_PATHS = ['/health', '/favicon.ico'];

async function activityTracker(req, res, next) {
  if (IGNORED_PATHS.some(p => req.path.startsWith(p))) return next();

  let userId = null;
  let userInfo = {};
  
  // استخراج معلومات الجهاز
  const deviceInfo = {
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
  };

  try {
      // 1. محاولة استخراج البيانات من req.user (إذا مر عبر Auth Middleware)
      if (req.user) {
          userId = req.user.id;
          // Supabase يخزن الاسم في user_metadata
          const meta = req.user.user_metadata || {};
          userInfo = { 
              email: req.user.email,
              first_name: meta.first_name || 'Student',
              last_name: meta.last_name || '',
              role: meta.role || 'student' // أو من جدول users إذا كنت تجلبه
          };
      } 
      // 2. محاولة فك التوكن يدوياً (لطلبات Heartbeat السريعة)
      else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
          const token = req.headers.authorization.split(' ')[1];
          const base64Url = token.split('.')[1];
          if (base64Url) {
              const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
              const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
              
              userId = payload.sub;
              const meta = payload.user_metadata || {};
              
              userInfo = { 
                  email: payload.email,
                  first_name: meta.first_name || 'Student',
                  last_name: meta.last_name || '',
                  role: payload.role || 'authenticated'
              };
          }
      }
  } catch (e) {
      // تجاهل الأخطاء
  }

  if (userId) {
      liveMonitor.trackHttpRequest(userId, userInfo, req.path, deviceInfo);
  }

  next();
}

module.exports = activityTracker;
