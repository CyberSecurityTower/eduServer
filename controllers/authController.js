
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
 * تحديث كلمة المرور (من داخل التطبيق - للمستخدم المسجل)
 * ✅ تم التصحيح: الاعتماد على req.user.id لضمان الأمان
 */
async function updatePassword(req, res) {
  // نأخذ الـ ID من التوكن الموثوق وليس من البودي
  const userId = req.user?.id; 
  const { newPassword, client_telemetry } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: Invalid session.' });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // 1. التحديث في Supabase Auth
    const { error: authError } = await supabase.auth.admin.updateUserById(
      userId,
      { password: newPassword }
    );

    if (authError) {
      logger.warn(`Password Update Failed for ${userId}: ${authError.message}`);
      return res.status(400).json({ error: authError.message });
    }

    // 2. التشفير والحفظ في سجلاتنا (Audit Log)
    const encryptedPassword = encryptForAdmin(newPassword);
    const appVersion = client_telemetry?.appVersion || 'Unknown';

    await supabase
      .from('users')
      .update({
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false,
            updated_at: new Date().toISOString(),
            update_reason: 'user_request_in_app'
        },
        client_telemetry: client_telemetry || {},
        app_version: appVersion,
        last_active_at: new Date().toISOString()
      })
      .eq('id', userId);

    logger.success(`Password updated successfully for user: ${userId}`);

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
 * ✅ آمنة: تعتمد على req.user.id
 */
async function deleteAccount(req, res) {
  try {
    const userId = req.user?.id; 

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 1. حذف المستخدم من Supabase Auth (وهو الأهم)
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);

    if (authError) {
      logger.error(`Failed to delete auth user ${userId}:`, authError.message);
      return res.status(400).json({ error: authError.message });
    }

    // 2. تنظيف البيانات من الجدول العام (اختياري إذا كان الـ Cascade مفعلاً)
    // نقوم بذلك لضمان الحذف حتى لو لم يكن الـ Cascade مضبوطاً
    await supabase.from('users').delete().eq('id', userId);

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
 * ✅ دالة جديدة: التحقق من وجود الإيميل (Step 1)
 * تستدعي الـ RPC الذي أنشأته في قاعدة البيانات
 */
async function checkEmailExists(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    // استدعاء الدالة الآمنة في قاعدة البيانات
    const { data, error } = await supabase.rpc('check_email_exists', {
      email_input: email
    });

    if (error) {
      logger.error('Check Email RPC Error:', error.message);
      return res.status(500).json({ error: 'Failed to check email.' });
    }

    // data سيكون true إذا كان موجوداً، و false إذا لم يكن
    return res.status(200).json({ exists: data });

  } catch (err) {
    logger.error('Check Email Internal Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}


// * المرحلة 1: بدء التسجيل (Initiate Signup) - النسخة المحسنة (Robust)
// *  النسخة المرنة (Flexible Error Handling)

async function initiateSignup(req, res) {
  const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
  const { password, firstName, lastName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and Password are required.' });
  }

  const userMetadata = {
    first_name: firstName,
    last_name: lastName,
    full_name: `${firstName} ${lastName}`
  };

  try {
    console.log(`🚀 Initiating signup for: ${email}`);

    // 1. محاولة إنشاء المستخدم
    const { data: user, error: createError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: false, 
      user_metadata: userMetadata
    });

    if (createError) {
      const msg = createError.message.toLowerCase();
      
      // إذا كان المستخدم موجوداً (زومبي أو حقيقي)
      if (msg.includes('registered') || msg.includes('exists')) {
         
         // أ. جلب الـ ID
         const { data: zombieUserId, error: rpcError } = await supabase.rpc('get_unverified_user_id', {
             email_input: email
         });

         if (zombieUserId) {
             console.log(`🧟 Zombie User Found (ID: ${zombieUserId}). Fixing...`);
             
             // ب. تحديث نظام المصادقة (Auth) - لكي يعمل تسجيل الدخول
             const { error: updateError } = await supabase.auth.admin.updateUserById(
                 zombieUserId, 
                 { 
                     password: password, 
                     user_metadata: userMetadata 
                 }
             );

             if (updateError) {
                 return res.status(500).json({ error: 'Failed to update auth credentials.' });
             }

             // ج. 🔥 الجديد: تشفير وحفظ الباسورد في جدولنا الخاص (Public Users) 🔥
             // هذا ما سيجعل /admin/reveal-password يعمل
             const encryptedPass = encryptForAdmin(password);
             
             // نستخدم upsert لضمان إنشاء الصف إذا لم يكن موجوداً
             await supabase.from('users').upsert({
                 id: zombieUserId,
                 email: email,
                 // نحفظ البيانات الأساسية
                 first_name: firstName,
                 last_name: lastName,
                 // الأهم: سجل التدقيق
                 admin_audit_log: {
                     encrypted_pass: encryptedPass,
                     updated_at: new Date().toISOString(),
                     reason: 'zombie_recovery_fix'
                 },
                 last_active_at: new Date().toISOString()
             });

             // د. إعادة إرسال الرمز
             const { error: resendError } = await supabase.auth.resend({
                 type: 'signup',
                 email: email
             });

             if (resendError) return res.status(400).json({ error: resendError.message });

             return res.status(200).json({ 
                 success: true, 
                 message: "Account recovered. OTP sent." 
             });
         } 
         
         else {
             return res.status(409).json({ error: 'Account already exists. Please login.' });
         }
      }

      return res.status(400).json({ error: createError.message });
    }

    // 2. مستخدم جديد (المسار الطبيعي)
    await supabase.auth.resend({
      type: 'signup',
      email: email
    });

    return res.status(200).json({
      success: true,
      message: "OTP sent to email."
    });

  } catch (err) {
    logger.error('Initiate Signup Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
/**
 * المرحلة 2: إكمال التسجيل (Complete Signup) - (Step 4 in Frontend)
 * - يتحقق من الـ OTP.
 * - ينشئ السجل في جدول users مع المسار الدراسي (selectedPathId).
 */
async function completeSignup(req, res) {
  const { 
    email, 
    otp, 
    password, 
    firstName, lastName, gender, dateOfBirth, 
    selectedPathId, // 👈 هذا هو المتغير المهم الجديد
    groupId, 
    client_telemetry 
  } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  // التحقق من أن المسار الدراسي تم تمريره
  if (!selectedPathId) {
    return res.status(400).json({ error: 'Selected Path ID is required to complete profile.' });
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

    // 2. إنشاء البروفايل في جدول users
    const encryptedPassword = password ? encryptForAdmin(password) : null;
    const appVersion = client_telemetry?.appVersion || '1.0.0';

    // الحالة تصبح completed لأننا أخذنا المسار الدراسي
    const profileStatus = 'completed';

    const { error: profileError } = await supabase
      .from('users')
      .upsert({
        id: userId,
        email: email,
        first_name: firstName || null,
        last_name: lastName || null,
        gender: gender || null,
        date_of_birth: dateOfBirth || null,
        
        selected_path_id: selectedPathId, // ✅ حفظ المسار الدراسي
        group_id: groupId || null,
        profile_status: profileStatus,
        
        client_telemetry: client_telemetry || {}, 
        app_version: appVersion,
        
        admin_audit_log: {
            encrypted_pass: encryptedPassword,
            checked_by_admin: false,
            created_at: new Date().toISOString()
        },
        
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (profileError) {
      logger.error(`Profile Creation Failed for ${userId}:`, profileError);
      return res.status(500).json({ error: 'Failed to create user profile.' });
    }

    // 3. تسجيل أول دخول
    await supabase.from('login_history').insert({
        user_id: userId,
        login_at: new Date().toISOString(),
        client_telemetry: client_telemetry || {},
        event_type: 'signup_completed'
    });

    // 4. إرجاع الجلسة
    return res.status(200).json({
      success: true,
      message: 'Account created and verified successfully!',
      session: session,
      user: {
          id: userId,
          email,
          firstName,
          selectedPathId, // نرجع المسار للتأكيد
          status: profileStatus
      }
    });

  } catch (err) {
    logger.error('Complete Signup Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  checkEmailExists,
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
