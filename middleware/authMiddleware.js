// middleware/authMiddleware.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const CONFIG = require('../config'); // تأكد من استيراد الكونفيج للوصول للسر

async function requireAuth(req, res, next) {
  try {
    // 🔥 1. DEV BACKDOOR (تجاوز للمطور فقط)
    // نتحقق من وجود "السر" (نفسه المستخدم في Cron Jobs) و "ID المستخدم" الذي تريد انتحال شخصيته
    const adminSecret = req.headers['x-admin-secret'];
    const devUserId = req.headers['x-dev-user-id'];

    // يجب أن يكون السر صحيحاً ومطابقاً لما في .env
    if (adminSecret === process.env.NIGHTLY_JOB_SECRET && devUserId) {
      
      console.log(`🔓 [DEV MODE] Bypassing Auth for User ID: ${devUserId}`);
      
      // نحقن كائن المستخدم يدوياً في الطلب
      req.user = { 
        id: devUserId,
        email: 'dev_bypass@test.com',
        role: 'authenticated' 
      };
      
      return next(); // 🚀 اسمح بالمرور فوراً
    }

    // ============================================================
    // 👇 الكود الطبيعي (التحقق من التوكن) يبقى كما هو للمستخدمين الحقيقيين
    // ============================================================
    
    const authHeader = req.headers.authorization; 
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn(`⛔ Auth Failed: ${error?.message || 'Invalid Token'}`);
      return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
    }

    req.user = user;
    next();

  } catch (err) {
    logger.error('Auth Middleware Critical Error:', err);
    return res.status(500).json({ error: 'Internal Server Error during auth check.' });
  }
}

module.exports = requireAuth;
