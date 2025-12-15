// controllers/streakController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * دالة تسجيل الدخول اليومي (Daily Check-in)
 * تستدعي دالة SQL الآمنة لحساب الستريك والنقاط
 */
async function dailyCheckIn(req, res) {
  try {
    // 1. الحصول على معرف المستخدم من التوكن (لضمان الأمان)
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. استدعاء دالة SQL عبر RPC (Remote Procedure Call)
    // اسم الدالة في قاعدة البيانات هو 'update_streak_secure'
    const { data, error } = await supabase.rpc('update_streak_secure', {
      target_user_id: userId
    });

    if (error) {
      logger.error(`Streak RPC Error for ${userId}:`, error.message);
      return res.status(500).json({ error: 'Failed to update streak' });
    }

    // 3. تحليل النتيجة القادمة من قاعدة البيانات
    // الدالة ترجع JSON مثل: { status: 'success', new_streak: 5, coins_added: 15, ... }
    
    if (data.status === 'already_claimed') {
      return res.status(200).json({
        success: true,
        message: 'تم تسجيل الحضور اليوم مسبقاً.',
        data: data
      });
    }

    // حالة النجاح (تمت زيادة الستريك)
    logger.success(`🔥 Streak updated for ${userId}: ${data.new_streak} days (+${data.coins_added} coins)`);
    
    return res.status(200).json({
      success: true,
      message: `مبروك! حافظت على الستريك لـ ${data.new_streak} أيام.`,
      data: data
    });

  } catch (err) {
    logger.error('Daily Check-in Controller Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * جلب حالة الستريك الحالية (للعرض في الواجهة فقط)
 */
async function getStreakStatus(req, res) {
  try {
    const userId = req.user?.id;
    
    const { data, error } = await supabase
      .from('users')
      .select('streak_count, last_streak_date, coins')
      .eq('id', userId)
      .single();

    if (error) throw error;

    // حساب هل الستريك نشط أم انكسر (للعرض فقط)
    const lastDate = new Date(data.last_streak_date);
    const now = new Date();
    const diffHours = (now - lastDate) / (1000 * 60 * 60);
    
    // إذا مر أكثر من 48 ساعة (تقريباً)، يعتبر الستريك في خطر أو مكسور منطقياً
    // لكن الدالة SQL هي الحكم النهائي عند التحديث
    
    res.json({
      streak: data.streak_count,
      lastCheckIn: data.last_streak_date,
      coins: data.coins,
      isActive: diffHours < 36 // مجرد مؤشر للفرونت أند
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { dailyCheckIn, getStreakStatus };
