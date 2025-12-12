// middleware/requireAdmin.js
'use strict';

const supabase = require('../services/data/supabase');
const CONFIG = require('../config');
const logger = require('../utils/logger');

async function requireAdmin(req, res, next) {
  try {
    // 1. التحقق من المفتاح السري (للـ Cron Jobs والسكربتات)
    const secretHeader = req.headers['x-admin-secret'] || req.headers['x-job-secret'];
    if (secretHeader === process.env.NIGHTLY_JOB_SECRET) {
      req.isAdmin = true; // نضع علامة أن الطلب موثوق
      return next();
    }

    // 2. التحقق من التوكن (للتطبيق - Dashboard App)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      
      // فحص التوكن مع Supabase
      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (!error && user) {
        // التحقق من أن المستخدم هو Admin فعلاً
        // ملاحظة: يجب أن يكون لديك عمود role في جدول users أو metadata
        // هنا سنفترض أنك تجلب الرتبة من جدول users
        const { data: userData } = await supabase
          .from('users')
          .select('role')
          .eq('id', user.id)
          .single();

        if (userData && userData.role === 'admin') {
          req.user = user; // نحفظ المستخدم
          req.isAdmin = true;
          return next();
        }
      }
    }

    // 3. إذا فشل الاثنين
    logger.warn(`Unauthorized Admin Access Attempt from IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Admin access required.' });

  } catch (err) {
    logger.error('Admin Middleware Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = requireAdmin;
