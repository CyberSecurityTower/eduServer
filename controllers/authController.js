
// controllers/authController.js
'use strict';

const supabase = require('../services/data/supabase');
const { encryptForAdmin } = require('../utils/crypto');
const logger = require('../utils/logger');

async function signup(req, res) {
  const { email, password, firstName, lastName, client_telemetry } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and Password are required.' });
  }

  try {
    // 1. إنشاء الحساب في Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user?.id;
    if (!userId) return res.status(500).json({ error: 'User ID missing.' });

    // 2. تشفير الباسورد للمراجعة
    const encryptedPassword = encryptForAdmin(password);
    const appVersion = client_telemetry?.appVersion || '1.0.0';

    // 3. إدخال البيانات في جدول users
    const { error: profileError } = await supabase
      .from('users')
      .insert({
        id: userId,
        email: email,
        first_name: firstName,
        last_name: lastName,
        
        // ✅ البيانات التقنية الجديدة
        client_telemetry: client_telemetry || {}, 
        app_version: appVersion,
        
        // ✅ الصندوق الأسود (الباسورد المشفر)
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false,
            created_at: new Date().toISOString()
        },
        
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      });

    if (profileError) {
      logger.error(`Profile Creation Failed for ${userId}:`, profileError);
      // ملاحظة: هنا الحساب أُنشئ في Auth لكن ليس في users. 
      // في التطبيق الحقيقي قد تحتاج لحذف Auth user للتراجع (Rollback).
      return res.status(500).json({ error: 'Profile creation failed.' });
    }

    // 4. (إضافة ممتازة) تسجيل أول دخول في login_history أيضاً!
    // لكي يكون لدينا سجل كامل من اللحظة الأولى
    await supabase.from('login_history').insert({
        user_id: userId,
        login_at: new Date().toISOString(),
        client_telemetry: client_telemetry || {},
        app_version: appVersion
    });

    logger.success(`New User Registered & Logged: ${email}`);
    
    return res.status(201).json({ 
      success: true, 
      user: { id: userId, email, firstName }
    });

  } catch (err) {
    logger.error('Signup Critical Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = { signup };
