// middleware/authMiddleware.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');


async function requireAuth(req, res, next) {
  try {
    // 1. جلب التوكن من الهيدر
    const authHeader = req.headers.authorization; 
    
    // تتبع (Debug): ماذا وصلنا من الفرونت أند؟
    console.log(`🔍 [AuthMiddleware] Header received: ${authHeader ? 'YES' : 'NO'}`);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }

    const token = authHeader.split(' ')[1];

    // 2. التحقق من التوكن عبر Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      // طباعة سبب الرفض في التيرمينال لنعرف السبب
      logger.warn(`⛔ Auth Failed: ${error?.message || 'Invalid Token'}`);
      
      // ✅ تم تصحيح الإملاء هنا (Unauthorized)
      return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
    }

    // 3. تمرير المستخدم للخطوة التالية
    req.user = user;
    
    next(); // السماح بالمرور

  } catch (err) {
    logger.error('Auth Middleware Critical Error:', err);
    return res.status(500).json({ error: 'Internal Server Error during auth check.' });
  }
}
module.exports = requireAuth;
