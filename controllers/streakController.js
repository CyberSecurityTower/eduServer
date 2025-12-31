
// controllers/streakController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

// إعدادات المكافآت الجديدة
const REWARDS = {
  DAILY_BASE: 10,      // القيمة الأساسية (10 كوينز)
  MULTIPLIER: 1.2,     // نسبة المضاعفة (20% زيادة)
  STEP_DAYS: 3,        // كل كم يوم تتضاعف القيمة
  MAX_DAILY_CAP: 200   // سقف أمان: أقصى ربح يومي لمنع تضخم الاقتصاد (اختياري)
};

/**
 * 📅 تسجيل الدخول اليومي (Daily Check-in)
 * المنطق الجديد:
 * 1. حساب الستريك الحالي.
 * 2. تطبيق معادلة المضاعفة الأسية (Exponential Growth).
 * 3. إعادة التعيين للأساس عند الانقطاع.
 */
async function dailyCheckIn(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. تحديد الوقت الحالي (توقيت الجزائر للأمان)
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
    // 🚀 حساب الستريك الجديد
    // =========================================================
    let newStreak = 1;
    let isReset = false;
    let lostStreakCount = 0;

    // الحالة B: استمرار الستريك (جاء أمس)
    if (lastStreakStr === yesterdayStr) {
      newStreak = (user.streak_count || 0) + 1;
    } 
    // الحالة C: انقطاع الستريك (Reset) - أو أول مرة
    else if (lastStreakStr && lastStreakStr < yesterdayStr) {
      isReset = true;
      lostStreakCount = user.streak_count;
      newStreak = 1; // ⚠️ العودة للصفر (واحد) تعني العودة للمضاعف 1x
    }
    // الحالة D: مستخدم جديد تماماً (يبقى newStreak = 1)

    // =========================================================
    // 💰 حساب المكافأة (المنطق الجديد)
    // =========================================================
    
    // 1. حساب عدد مرات التضاعف (كل 3 أيام)
    // Math.floor(1 / 3) = 0 -> Multiplier 1 (اليوم الأول)
    // Math.floor(3 / 3) = 1 -> Multiplier 1.2
    // Math.floor(6 / 3) = 2 -> Multiplier 1.44
    const multiplierPower = Math.floor(newStreak / REWARDS.STEP_DAYS);
    
    // 2. حساب قيمة المضاعف (1.2 أس عدد الثلاثيات)
    const currentMultiplier = Math.pow(REWARDS.MULTIPLIER, multiplierPower);
    
    // 3. حساب الكوينز النهائية
    let rawCoins = REWARDS.DAILY_BASE * currentMultiplier;
    
    // 4. تطبيق سقف الأمان (Cap) وتقريب الرقم
    let coinsToAdd = Math.floor(Math.min(rawCoins, REWARDS.MAX_DAILY_CAP));

    // رسالة المكافأة
    let rewardMessage = `+${coinsToAdd} كوين`;
    if (newStreak % REWARDS.STEP_DAYS === 0) {
        rewardMessage += ` 🔥 (X${currentMultiplier.toFixed(1)} Bonus!)`;
    }

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
        last_streak_date: new Date().toISOString(),
        best_streak: newBestStreak,
        last_active_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    // 2. إضافة الكوينز
    if (coinsToAdd > 0) {
      await supabase.rpc('process_coin_transaction', {
        p_user_id: userId,
        p_amount: coinsToAdd,
        p_reason: 'daily_streak_reward',
        p_meta: { 
            day: todayStr, 
            streak: newStreak, 
            multiplier: currentMultiplier.toFixed(2) 
        }
      });
    }

    // 3. تنظيف المهام المعلقة
    await supabase.from('scheduled_actions')
        .delete()
        .eq('user_id', userId)
        .eq('type', 'streak_rescue');

    logger.success(`🔥 Streak: User ${userId} -> Day ${newStreak} | Coins: ${coinsToAdd} (x${currentMultiplier.toFixed(2)})`);

    // =========================================================
    // ✅ الرد للفرونت أند
    // =========================================================
    return res.status(200).json({
      success: true,
      status: 'claimed',
      wasReset: isReset,
      message: isReset ? 'للأسف راح الستريك.. ابدأ من جديد!' : 'كفو! الستريك راهو يطلع والمكافأة تزيد!',
      reward: {
        coins_added: coinsToAdd,
        label: rewardMessage,
        multiplier: currentMultiplier.toFixed(1)
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

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const lastStreakStr = user.last_streak_date ? new Date(user.last_streak_date).toISOString().split('T')[0] : null;
    
    const isCompletedToday = lastStreakStr === todayStr;

    // حساب المكافأة المتوقعة لليوم (لتحفيز المستخدم)
    const currentStreak = user.streak_count || 0;
    // إذا أكمل اليوم، نحسب لغد، وإلا نحسب لليوم
    const nextVirtualStreak = isCompletedToday ? currentStreak + 1 : (lastStreakStr ? currentStreak + 1 : 1);
    
    const multiplierPower = Math.floor(nextVirtualStreak / REWARDS.STEP_DAYS);
    const nextMultiplier = Math.pow(REWARDS.MULTIPLIER, multiplierPower);
    const nextReward = Math.floor(Math.min(REWARDS.DAILY_BASE * nextMultiplier, REWARDS.MAX_DAILY_CAP));

    return res.json({
      streak: currentStreak,
      bestStreak: user.best_streak || 0,
      isCompletedToday: isCompletedToday,
      lastStreakDate: user.last_streak_date,
      nextRewardPrediction: nextReward, // لعرض: "سجل دخولك لتربح X"
      currentMultiplier: nextMultiplier.toFixed(1)
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { dailyCheckIn, getStreakStatus };
