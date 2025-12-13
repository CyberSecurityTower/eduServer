// middleware/activityTracker.js
'use strict';

const liveMonitor = require('../services/monitoring/liveStats');
const supabase = require('../services/data/supabase');

async function activityTracker(req, res, next) {
  // نحاول استخراج معرف المستخدم من التوكن (إن وجد)
  let userId = null;
  let userInfo = {};

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    // فك تشفير سريع (بدون التحقق الكامل لتسريع العملية، التحقق يتم في requireAuth)
    // أو نعتمد على أن requireAuth قد وضع req.user مسبقاً إذا كان الترتيب صحيحاً
    
    // الأفضل: إذا كان req.user موجوداً (تم التحقق منه)
    if (req.user) {
        userId = req.user.id;
        userInfo = { email: req.user.email };
    }
  }

  // تسجيل الطلب في الرادار
  liveMonitor.trackRequest(userId, userInfo);

  next();
}

module.exports = activityTracker;
