// controllers/streakController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

// إعدادات المكافآت
const REWARDS = {
  DAILY_BASE: 10,      // 10 كوينز يومياً
  MILESTONE_7: 50,     // 50 كوينز كل 7 أيام
  STREAK_FREEZE_COST: 100 // تكلفة تجميد الستريك (للمستقبل)
};

/**
 * 📅 تسجيل الدخول اليومي (Daily Check-in)
 * المنطق:
 * 1. جلب تاريخ آخر ستريك للمستخدم.
 * 2. مقارنته بتاريخ اليوم (بتوقيت الجزائر).
 * 3. تحديد الحالة: (مطالبة مسبقة، استمرار، أو انقطاع).
 */
async function dailyCheckIn(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. تحديد الوقت الحالي (توقيت الجزائر للأمان)
    // نستخدم toISOString ونقص الجزء الأول للحصول على YYYY-MM-DD
    // ملاحظة: لضمان الدقة، نعتمد على توقيت السيرفر + ساعة (أو مكتبة توقيت)
    // هنا سنستخدم التاريخ الخام للمقارنة البسيطة
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; 

    // حساب "الأمس"
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // 2. جلب بيانات المستخدم الحالية
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('streak_count, last_streak_date, best_streak, coins')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    // تنظيف التاريخ القادم من الداتابايز (قد يكون null أو timestamp)
    let lastStreakStr = null;
    if (user.last_streak_date) {
        lastStreakStr = new Date(user.last_streak_date).toISOString().split('T')[0];
    }

    // =========================================================
    // 🛑 الحالة A: المستخدم سجل دخوله اليوم بالفعل
    // =========================================================
    if (lastStreakStr === todayStr) {
      return res.status(200).json({
        success: true,
        status: 'already_claimed',
        message: 'راك ديت الستريك تاع اليوم ديجا! 😉',
        data: {
          streak: user.streak_count,
          coins: user.coins,
          best_streak: user.best_streak
        }
      });
    }

    // =========================================================
    // 🚀 التحضير للتحديث
    // =========================================================
    let newStreak = 1;
    let coinsToAdd = REWARDS.DAILY_BASE;
    let isReset = false;
    let lostStreakCount = 0;
    let rewardMessage = `+${REWARDS.DAILY_BASE} عملة`;

    // الحالة B: استمرار الستريك (جاء أمس)
    if (lastStreakStr === yesterdayStr) {
      newStreak = (user.streak_count || 0) + 1;
      
      // بونوس الأسبوع (كل 7 أيام)
      if (newStreak % 7 === 0) {
        coinsToAdd += REWARDS.MILESTONE_7;
        rewardMessage = `🔥 أسبوع كامل! +${coinsToAdd} عملة!`;
      }
    } 
    // الحالة C: انقطاع الستريك (Reset)
    else if (lastStreakStr && lastStreakStr < yesterdayStr) {
      isReset = true;
      lostStreakCount = user.streak_count;
      newStreak = 1; // العودة للصفر (واحد)
    }
    // الحالة D: أول مرة (newStreak = 1 افتراضياً)

    // حساب أفضل ستريك
    const newBestStreak = Math.max(user.best_streak || 0, newStreak);

    // =========================================================
    // 💾 التحديث في قاعدة البيانات
    // =========================================================
    
    // 1. تحديث جدول users
    const { error: updateError } = await supabase
      .from('users')
      .update({
        streak_count: newStreak,
        last_streak_date: new Date().toISOString(), // نحفظ التوقيت الكامل
        best_streak: newBestStreak,
        last_active_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    // 2. إضافة الكوينز (RPC لضمان الأمان المالي)
    if (coinsToAdd > 0) {
      await supabase.rpc('process_coin_transaction', {
        p_user_id: userId,
        p_amount: coinsToAdd,
        p_reason: 'daily_streak_reward',
        p_meta: { day: todayStr, streak: newStreak }
      });
    }

    // 3. (اختياري) حذف أي مهام "إنقاذ ستريك" معلقة لأن المستخدم دخل
    await supabase.from('scheduled_actions')
        .delete()
        .eq('user_id', userId)
        .eq('type', 'streak_rescue');

    logger.success(`🔥 Streak Update: User ${userId} -> ${newStreak} (Reset: ${isReset})`);

    // =========================================================
    // ✅ الرد للفرونت أند
    // =========================================================
    return res.status(200).json({
      success: true,
      status: 'claimed',
      wasReset: isReset,
      message: isReset ? 'للأسف راح الستريك.. ابدأ من جديد!' : 'كفو! الستريك راهو يطلع!',
      reward: {
        coins_added: coinsToAdd,
        label: rewardMessage
      },
      data: {
        streak: newStreak,
        best_streak: newBestStreak,
        previous_streak: isReset ? lostStreakCount : null
      }
    });

  } catch (err) {
    logger.error('Daily Check-in Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * 📊 جلب حالة الستريك فقط (للعرض في الواجهة)
 */
async function getStreakStatus(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data: user } = await supabase
      .from('users')
      .select('streak_count, last_streak_date, best_streak')
      .eq('id', userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // حساب هل الستريك مهدد بالخطر؟ (لم يسجل اليوم)
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const lastStreakStr = user.last_streak_date ? new Date(user.last_streak_date).toISOString().split('T')[0] : null;
    
    const isCompletedToday = lastStreakStr === todayStr;

    return res.json({
      streak: user.streak_count || 0,
      bestStreak: user.best_streak || 0,
      isCompletedToday: isCompletedToday,
      lastStreakDate: user.last_streak_date
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { dailyCheckIn, getStreakStatus };
