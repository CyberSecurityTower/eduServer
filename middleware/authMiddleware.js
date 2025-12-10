// middleware/authMiddleware.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

async function requireAuth(req, res, next) {
  try {
    // 1. جلب التوكن من الهيدر
    const authHeader = req.headers.authorization; // المتوقع: "Bearer <token>"
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }

    const token = authHeader.split(' ')[1];

    // 2. التحقق من التوكن عبر Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn(`Auth Middleware Failed: ${error?.message || 'Invalid Token'}`);
      return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
    }

    // 3. (اختياري ولكن مهم) التحقق من تطابق الهوية
    // إذا كان الطلب يحتوي على userId في البودي، يجب أن يطابق صاحب التوكن
    if (req.body.userId && req.body.userId !== user.id) {
      logger.warn(`Identity Mismatch! Token User: ${user.id}, Request Body User: ${req.body.userId}`);
      return res.status(403).json({ error: 'Forbidden: You can only modify your own data.' });
    }

    // 4. تمرير المستخدم للخطوة التالية (اختياري، للاستخدام لاحقاً)
    req.user = user;
    
    next(); // السماح بالمرور

  } catch (err) {
    logger.error('Auth Middleware Error:', err);
    return res.status(500).json({ error: 'Internal Server Error during auth check.' });
  }
}

module.exports = requireAuth;
