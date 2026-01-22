// middleware/rateLimiter.js
'use strict';

const logger = require('../utils/logger');

// تخزين الطلبات: Key = userId (or IP), Value = { count, startTime }
const requestCounts = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // دقيقة واحدة
// ✅ تم التعديل: رفع الحد من 20 إلى 100 طلب في الدقيقة
const MAX_REQUESTS_PER_WINDOW = 100; 

function rateLimiter(req, res, next) {
  // نحاول الحصول على معرف المستخدم من البودي، وإلا نستخدم الـ IP
  // ملاحظة: يفضل الاعتماد على req.user.id إذا كان المستخدم مسجلاً للدخول (يتم تعيينه في authMiddleware)
  // ولكن للكود الحالي سنبقي عليه كما هو ليعمل مع الطلبات غير المصادقة أيضاً
  const key = (req.user && req.user.id) || req.body.userId || req.ip;

  if (!key) return next();

  const currentTime = Date.now();
  const record = requestCounts.get(key);

  if (!record) {
    // أول طلب
    requestCounts.set(key, { count: 1, startTime: currentTime });
    return next();
  }

  if (currentTime - record.startTime > RATE_LIMIT_WINDOW_MS) {
    // انتهت الدقيقة، تصفير العداد
    record.count = 1;
    record.startTime = currentTime;
    return next();
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    // تجاوز الحد
    logger.warn(`Rate limit exceeded for user: ${key}`);
    return res.status(429).json({ 
      error: 'Too many requests. Please slow down.',
      retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (currentTime - record.startTime)) / 1000)
    });
  }

  // زيادة العداد
  record.count++;
  next();
}

// تنظيف الذاكرة كل 5 دقائق لمنع الامتلاء
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of requestCounts.entries()) {
    if (now - record.startTime > RATE_LIMIT_WINDOW_MS) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = rateLimiter;
