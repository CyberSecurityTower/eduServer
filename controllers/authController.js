
// controllers/authController.js
'use strict';

const supabase = require('../services/data/supabase');
const { encryptForAdmin } = require('../utils/crypto');
const logger = require('../utils/logger');

// دالة مساعدة لتسجيل الأحداث الأمنية
async function logSecurityEvent(email, type, telemetry, ip) {
  try {
    await supabase.from('security_logs').insert({
      user_email: email,
      event_type: type,
      client_telemetry: telemetry || {},
      ip_address: ip || 'unknown'
    });
  } catch (e) {
    logger.error('Failed to log security event:', e);
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

/**
 * 1. طلب استعادة كلمة المرور (إرسال OTP)
 */
async function forgotPassword(req, res) {
  const { email, client_telemetry } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // تسجيل المحاولة
    logSecurityEvent(email, 'reset_request', client_telemetry, ip);

    // إرسال OTP عبر Supabase
    const { error } = await supabase.auth.resetPasswordForEmail(email);

    if (error) {
      // ملاحظة: لأسباب أمنية، بعض الأنظمة لا تخبرك إذا كان الإيميل غير موجود
      // لكن للتبسيط سنرجع الخطأ الآن
      logger.warn(`Reset Password Request Failed for ${email}: ${error.message}`);
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ message: 'OTP sent successfully.' });

  } catch (err) {
    logger.error('Forgot Password Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * 2. التحقق من الرمز (Verify OTP)
 */
async function verifyOtp(req, res) {
  const { email, token, client_telemetry } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !token) return res.status(400).json({ error: 'Email and Token are required.' });

  try {
    // التحقق من الرمز
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'recovery'
    });

    if (error) {
      logSecurityEvent(email, 'otp_verify_fail', client_telemetry, ip);
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    // نجاح التحقق
    logSecurityEvent(email, 'otp_verify_success', client_telemetry, ip);

    // نرجع الجلسة (Session) التي تحتوي على access_token
    // سيحتاجه الفرونت أند للخطوة التالية
    return res.status(200).json({ 
      session: data.session,
      message: 'OTP verified successfully.' 
    });

  } catch (err) {
    logger.error('Verify OTP Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * 3. تعيين كلمة المرور الجديدة (Reset Password)
 */
async function resetPassword(req, res) {
  const { accessToken, newPassword, client_telemetry } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!accessToken || !newPassword) {
    return res.status(400).json({ error: 'Access Token and New Password are required.' });
  }

  try {
    // أ. التحقق من التوكن والحصول على المستخدم
    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken);
    
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    // ب. تحديث كلمة المرور في Auth
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    // ج. تشفير الباسورد الجديد وتحديث سجلاتنا (Audit Log)
    const encryptedPassword = encryptForAdmin(newPassword);
    const appVersion = client_telemetry?.appVersion || 'Unknown';

    // تحديث جدول users
    await supabase.from('users').update({
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false,
            updated_at: new Date().toISOString(),
            update_reason: 'password_reset_flow'
        },
        client_telemetry: client_telemetry || {},
        app_version: appVersion,
        last_active_at: new Date().toISOString()
    }).eq('id', user.id);

    // د. تسجيل الحدث الأمني النهائي
    logSecurityEvent(user.email, 'password_reset_complete', client_telemetry, ip);

    return res.status(200).json({ message: 'Password reset successfully.' });

  } catch (err) {
    logger.error('Reset Password Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * حذف الحساب نهائياً
 */
async function deleteAccount(req, res) {
  try {
    // 1. الحصول على معرف المستخدم من التوكن (عبر requireAuth middleware)
    // هذا آمن لأنه يضمن أن المستخدم مسجل دخول
    const userId = req.user?.id; 

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. حذف المستخدم من Supabase Auth
    // ملاحظة: supabase المستورد هنا يستخدم Service Role Key (كما في ملف services/data/supabase.js)
    // لذلك لديه صلاحية الحذف (Admin Privileges)
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);

    if (authError) {
      logger.error(`Failed to delete auth user ${userId}:`, authError.message);
      return res.status(400).json({ error: authError.message });
    }

    // 3. (اختياري) تنظيف البيانات الإضافية
    // إذا كنت قد ضبطت إعدادات قاعدة البيانات (Foreign Keys) على "ON DELETE CASCADE"
    // فسيتم حذف بياناته من جدول users و chat_sessions تلقائياً.
    // إذا لم تكن كذلك، يمكنك حذفها يدوياً هنا:
    /*
    await supabase.from('users').delete().eq('id', userId);
    */

    logger.success(`User account deleted permanently: ${userId}`);
    return res.status(200).json({ success: true, message: 'Account deleted successfully.' });

  } catch (err) {
    logger.error('Delete Account Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * ✅ التحقق من كود التفعيل (Signup OTP)
 */
async function verifyEmailOtp(req, res) {
  const { email, token, client_telemetry } = req.body;

  if (!email || !token) {
    return res.status(400).json({ error: 'Email and OTP token are required.' });
  }

  try {
    // 1. التحقق عبر Supabase
    // type: 'signup' ضروري هنا لتفعيل الحساب الجديد
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup'
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // 2. الحصول على الجلسة (الآن أصبح لدينا Session لأن الحساب تفعل)
    const session = data.session;
    const userId = data.user?.id;

    // 3. تحديث وقت آخر ظهور وتيليمتري الجهاز
    if (userId) {
        await supabase.from('users').update({
            last_active_at: new Date().toISOString(),
            client_telemetry: client_telemetry || {}
        }).eq('id', userId);
        
        // تسجيل دخول ناجح في السجل
        await supabase.from('login_history').insert({
            user_id: userId,
            login_at: new Date().toISOString(),
            event_type: 'signup_verification_success'
        });
    }

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully!',
      session: session, // 👈 الفرونت أند سيحفظ هذا التوكن
      user: data.user
    });

  } catch (err) {
    logger.error('Verify Signup OTP Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * ✅ إعادة إرسال كود التفعيل (Resend OTP)
 */
async function resendSignupOtp(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email
    });

    if (error) {
      // أحياناً Supabase يرفض الإرسال إذا كان الوقت قصيراً جداً بين المحاولات
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ 
        success: true, 
        message: "OTP has been resent to your email." 
    });

  } catch (err) {
    logger.error('Resend OTP Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * المرحلة 1: بدء التسجيل (Initiate Signup)
 * - ينشئ حساب Auth فقط (غير مفعل).
 * - يرسل كود OTP.
 * - لا يكتب أي شيء في جدول users العام.
 */
async function initiateSignup(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and Password are required.' });
  }

  try {
    // 1. محاولة إنشاء المستخدم في Auth
    // نستخدم signUp لأنها تتعامل بذكاء مع إرسال الإيميلات
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // خيارات إضافية لمنع الدخول المباشر (رغم أن Confirm Email مفعل)
    });

    // 2. معالجة حالة "المستخدم موجود مسبقاً"
    if (error) {
      // إذا كان المستخدم موجوداً ولكنه غير مفعل، نعيد إرسال الرمز
      if (error.message.includes('already registered')) {
         const { error: resendError } = await supabase.auth.resend({
             type: 'signup',
             email: email
         });
         
         if (resendError) return res.status(400).json({ error: 'Account exists and verified. Please login.' });
         
         return res.status(200).json({ 
             success: true, 
             message: "Account exists but unverified. OTP resent." 
         });
      }
      return res.status(400).json({ error: error.message });
    }

    // 3. نجاح الإرسال
    return res.status(200).json({
      success: true,
      message: "OTP sent to email. Please verify to complete registration."
    });

  } catch (err) {
    logger.error('Initiate Signup Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * المرحلة 2: إكمال التسجيل (Complete Signup)
 * - يتحقق من الـ OTP.
 * - ينشئ السجل الكامل في جدول users.
 * - يرجع Session.
 */
async function completeSignup(req, res) {
  const { 
    email, 
    otp, // الكود من المستخدم
    password, // نحتاجه لتشفيره في audit_log
    firstName, lastName, gender, dateOfBirth, 
    selectedPathId, groupId, client_telemetry 
  } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  try {
    // 1. التحقق من الـ OTP وتفعيل حساب Auth
    const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'signup'
    });

    if (verifyError) {
      return res.status(400).json({ error: 'Invalid Code: ' + verifyError.message });
    }

    const userId = verifyData.user?.id;
    const session = verifyData.session;

    if (!userId) return res.status(500).json({ error: 'Verification failed unexpectedly.' });

    // 2. الآن ننشئ البروفايل في جدول users (لأول مرة)
    // نحدد الحالة بناءً على البيانات المدخلة
    let profileStatus = 'pending_setup';
    if (selectedPathId && groupId) profileStatus = 'completed';

    const encryptedPassword = password ? encryptForAdmin(password) : null;
    const appVersion = client_telemetry?.appVersion || '1.0.0';

    const { error: profileError } = await supabase
      .from('users')
      .upsert({
        id: userId,
        email: email,
        first_name: firstName || null,
        last_name: lastName || null,
        gender: gender || null,
        date_of_birth: dateOfBirth || null,
        
        selected_path_id: selectedPathId || null,
        group_id: groupId || null,
        profile_status: profileStatus,
        
        client_telemetry: client_telemetry || {}, 
        app_version: appVersion,
        
        admin_audit_log: {
            encrypted_pass: encryptedPassword, // حفظنا الباسورد المشفر الآن
            checked_by_admin: false,
            created_at: new Date().toISOString()
        },
        
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (profileError) {
      console.error(`Profile Creation Failed for ${userId}:`, profileError);
      // في حالة نادرة جداً: Auth نجح لكن DB فشل.
      // المستخدم سيتمكن من الدخول لكن بياناته ناقصة.
      // يمكننا إرجاع خطأ، أو تجاهله لأن upsert سيصلحه في المرة القادمة.
      return res.status(500).json({ error: 'Failed to create user profile.' });
    }

    // 3. تسجيل أول دخول
    await supabase.from('login_history').insert({
        user_id: userId,
        login_at: new Date().toISOString(),
        client_telemetry: client_telemetry || {},
        event_type: 'signup_completed'
    });

    // 4. إرجاع الجلسة للدخول المباشر
    return res.status(200).json({
      success: true,
      message: 'Account created and verified successfully!',
      session: session,
      user: {
          id: userId,
          email,
          firstName,
          status: profileStatus
      }
    });

  } catch (err) {
    logger.error('Complete Signup Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
module.exports = {
  initiateSignup,
  updatePassword, // (تغيير الباسورد من داخل التطبيق)
  forgotPassword, // (نسيت كلمة المرور - الخطوة 1)
  verifyOtp,      // (نسيت كلمة المرور - الخطوة 2)
  resetPassword ,  // (نسيت كلمة المرور - الخطوة 3)
  deleteAccount ,
  verifyEmailOtp,
  resendSignupOtp,
  completeSignup
};
