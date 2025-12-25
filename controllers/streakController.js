
// controllers/streakController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

async function dailyCheckIn(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // استدعاء الدالة الذكية من قاعدة البيانات
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

    // 2. حالة الخصم (Reset) - فقط إذا كان هناك خصم فعلي
    if (data.status === 'reset') {
      logger.warn(`💔 User ${userId} lost streak. Penalty: -${data.penalty_deducted}`);
      
      // حذف رسائل الإنقاذ القديمة
      await supabase.from('scheduled_actions').delete().eq('user_id', userId).eq('type', 'streak_rescue');

     return res.status(200).json({
    success: true,
    wasReset: true,
    message: `للأسف ضيعت الستريك..`,
    penaltyReport: {
      lostStreak: data.lost_streak,
      deductedCoins: data.penalty_deducted,
      newStreak: 1
    },
    data: data
  });
}

    // 3. حالة النجاح (زيادة الستريك أو بداية جديدة بدون عقوبة)
    logger.success(`🔥 Streak updated for ${userId}: ${data.new_streak} days`);
    
    // حذف رسائل الإنقاذ لأن المستخدم سجل دخوله
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

async function getStreakStatus(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('users')
      .select('streak_count, last_streak_date, best_streak')
      .eq('id', userId)
      .single();

    if (error) {
       logger.error(`Get Streak Error: ${error.message}`);
       // في حال الخطأ نرجع أصفار بدلاً من كراش
       return res.status(200).json({
         success: true,
         streak: 0,
         last_active: null,
         best_streak: 0
       });
    }

    return res.status(200).json({
      success: true,
      streak: data?.streak_count || 0,
      last_active: data?.last_streak_date || null,
      best_streak: data?.best_streak || 0
    });

  } catch (err) {
    logger.error('Get Streak Status Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
module.exports = { 
  dailyCheckIn, 
  getStreakStatus 
};
