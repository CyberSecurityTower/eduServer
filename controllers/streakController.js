// controllers/streakController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * دالة تسجيل الدخول اليومي (Daily Check-in)
 * تستدعي دالة SQL الآمنة لحساب الستريك والنقاط
 */async function dailyCheckIn(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // استدعاء الدالة الذكية
    const { data, error } = await supabase.rpc('update_streak_secure', {
      target_user_id: userId
    });

    if (error) {
      logger.error(`Streak RPC Error for ${userId}:`, error.message);
      return res.status(500).json({ error: 'Failed to update streak' });
    }

    // 1. حالة المطالبة المسبقة
    if (data.status === 'already_claimed') {
      return res.status(200).json({
        success: true,
        message: 'راك جيت اليوم ديجا، ولي غدوة!',
        data: data
      });
    }

    // 2. حالة الخصم (Reset) - هنا التقرير المصغر
    if (data.status === 'reset') {
      logger.warn(`💔 User ${userId} lost streak. Penalty: -${data.penalty_deducted}`);
      
      // تنفيذ الـ Kill Switch (حذف رسائل الإنقاذ)
      await supabase.from('scheduled_actions').delete().eq('user_id', userId).eq('type', 'streak_rescue');

      return res.status(200).json({
        success: true,
        wasReset: true,
        message: `للأسف ضيعت ستريك ${data.lost_streak} يوم.. وخصمنا ${data.penalty_deducted} كوينز (65%) من أرباحك السابقة.`,
        penaltyReport: {
          lostStreak: data.lost_streak,
          deductedCoins: data.penalty_deducted,
          newStreak: 1
        }
      });
    }

    // 3. حالة النجاح العادي
    logger.success(`🔥 Streak updated for ${userId}: ${data.new_streak} days`);
    
    // تنفيذ الـ Kill Switch
    await supabase.from('scheduled_actions').delete().eq('user_id', userId).eq('type', 'streak_rescue');

    return res.status(200).json({
      success: true,
      message: `مبروك! راك في ${data.new_streak} يوم ستريك.`,
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
