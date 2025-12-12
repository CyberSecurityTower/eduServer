// services/engines/chronoV2.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

const CONFIG = {
  WEIGHTS: {
    // --- العوامل العضوية (Organic) ---
    ORGANIC_LOGIN: 1.0,      // دخول تلقائي للتطبيق
    LONG_SESSION: 1.5,       // جلسة طويلة (> 5 دقائق)
    
    // --- عوامل الإشعارات (الجديدة والمطورة) ---
    REACTION_INSTANT: 5.0,   // استجابة فورية (< 5 دقائق) 🔥 ذهبي
    REACTION_FAST: 3.0,      // استجابة سريعة (< 30 دقيقة)
    REACTION_SLOW: 1.0,      // استجابة متأخرة (> ساعة)
    IGNORED: -1.0,           // تجاهل تام (وصل ولم يفتح)
    
    // --- عوامل تقنية ---
    WIFI_BONUS: 0.2,         // اتصال مستقر
    BATTERY_BONUS: 0.2       // بطارية جيدة
  },
  DECAY_DAYS: 30,            // ننسى العادات القديمة بعد شهر
  EPSILON: 0.15              // نسبة الاستكشاف (15%)
};

async function calculateSmartPrimeTime(userId) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - CONFIG.DECAY_DAYS);

    // 1. جلب البيانات (Logs القديمة + Analytics الجديدة)
    const [logsRes, analyticsRes] = await Promise.all([
      // أ. سجلات الدخول (Organic Behavior)
      supabase.from('login_history')
        .select('login_at, session_duration_sec, client_telemetry') 
        .eq('user_id', userId)
        .gte('login_at', thirtyDaysAgo.toISOString()),
      
      // ب. تحليلات الإشعارات الدقيقة (The New Brain 🧠)
      supabase.from('notification_analytics')
        .select('received_at, clicked_at, status, delivery_latency_ms') 
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString())
    ]);

    const logs = logsRes.data || [];
    const notifAnalytics = analyticsRes.data || [];

    // مصفوفة الـ 168 ساعة (7 أيام × 24 ساعة)
    let scoreMatrix = new Array(168).fill(0);

    // =========================================================
    // A. تحليل السلوك العضوي (Organic)
    // =========================================================
    logs.forEach(log => {
      const date = new Date(log.login_at);
      const slot = getSlotIndex(date);
      const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
      const recencyWeight = Math.max(0.1, 1 - (daysAgo / CONFIG.DECAY_DAYS));

      let score = CONFIG.WEIGHTS.ORGANIC_LOGIN;

      // مكافآت التيليميتري
      const telemetry = log.client_telemetry || {};
      if (telemetry.networkType === 'WIFI') score += CONFIG.WEIGHTS.WIFI_BONUS;
      if (telemetry.isCharging) score += CONFIG.WEIGHTS.BATTERY_BONUS;
      if (log.session_duration_sec > 300) score *= CONFIG.WEIGHTS.LONG_SESSION;

      applyGaussianSmoothing(scoreMatrix, slot, score * recencyWeight);
    });

    // =========================================================
    // B. تحليل الإشعارات الذكي (The Upgrade 🚀)
    // =========================================================
    notifAnalytics.forEach(record => {
      // نعتمد على وقت "الوصول" (received_at) وليس الإرسال، لأنه الوقت الفعلي عند المستخدم
      if (!record.received_at) return; 

      const receiveDate = new Date(record.received_at);
      const slot = getSlotIndex(receiveDate);
      const daysAgo = (now - receiveDate) / (1000 * 60 * 60 * 24);
      const recencyWeight = Math.max(0.1, 1 - (daysAgo / CONFIG.DECAY_DAYS));

      let score = 0;

      if (record.status === 'opened' && record.clicked_at) {
        // حساب سرعة الاستجابة (Reaction Time) بالدقائق
        const clickDate = new Date(record.clicked_at);
        const reactionMinutes = (clickDate - receiveDate) / (1000 * 60);

        if (reactionMinutes < 5) {
            score = CONFIG.WEIGHTS.REACTION_INSTANT; // 🔥 استجابة فورية
        } else if (reactionMinutes < 30) {
            score = CONFIG.WEIGHTS.REACTION_FAST;    // استجابة ممتازة
        } else {
            score = CONFIG.WEIGHTS.REACTION_SLOW;    // فتح متأخر (أفضل من لا شيء)
        }
      } else {
        // لم يفتح الإشعار
        // 💡 ذكاء إضافي: إذا كان Latency عالي جداً (مشكلة نت)، لا نعاقبه بشدة
        if (record.delivery_latency_ms && record.delivery_latency_ms > 10000) {
            score = 0; // تجاهل (مشكلة تقنية)
        } else {
            score = CONFIG.WEIGHTS.IGNORED; // عقاب (وقت غير مناسب)
        }
      }

      applyGaussianSmoothing(scoreMatrix, slot, score * recencyWeight);
    });

    // =========================================================
    // C. اتخاذ القرار (Decision Making)
    // =========================================================
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDayIndex = tomorrow.getDay(); // 0-6
    
    // استخراج الـ 24 ساعة الخاصة بـ "يوم غد"
    const startSlice = targetDayIndex * 24;
    const dayScores = scoreMatrix.slice(startSlice, startSlice + 24);

    let bestHour = 20; // Default fallback
    let maxScore = -Infinity;

    dayScores.forEach((score, h) => {
        // تجنب ساعات النوم (1-5 صباحاً) إلا إذا كان السكور خارقاً
        if (h >= 1 && h <= 5 && score < 8) return;

        if (score > maxScore) {
            maxScore = score;
            bestHour = h;
        }
    });

    // Epsilon-Greedy: استكشاف أوقات جديدة بنسبة بسيطة
    let finalHour = bestHour;
    let strategy = 'exploit_data'; 
    let minuteOffset = 0;

    if (Math.random() < CONFIG.EPSILON) {
        strategy = 'explore_new_time';
        // نجرب ساعة عشوائية "معقولة" (بين 10 صباحاً و 10 ليلاً)
        finalHour = Math.floor(Math.random() * (22 - 10 + 1)) + 10;
    }

    // إضافة عشوائية للدقائق لكي لا تبدو روبوتية (مثلاً 20:13 بدلاً من 20:00)
    minuteOffset = Math.floor(Math.random() * 30); 

    return {
        bestHour: finalHour,
        minuteOffset: minuteOffset,
        strategy: strategy,
        confidence: maxScore > 5 ? 'high' : 'low'
    };

  } catch (err) {
    logger.error('Chrono V2 Error:', err.message);
    return { bestHour: 20, minuteOffset: 0, strategy: 'error_fallback' };
  }
}

// --- Helpers ---

function getSlotIndex(date) {
   // تحويل التوقيت للجزائر (+1)
   const hour = (date.getUTCHours() + 1) % 24; 
   const day = date.getDay(); 
   return (day * 24) + hour;
}

function applyGaussianSmoothing(matrix, centerIndex, value) {
  matrix[centerIndex] += value;
  // توزيع التأثير على الساعة السابقة واللاحقة
  const prev = centerIndex === 0 ? 167 : centerIndex - 1;
  const next = centerIndex === 167 ? 0 : centerIndex + 1;
  
  if (value !== 0) {
      matrix[prev] += value * 0.5; 
      matrix[next] += value * 0.5;
  }
}

module.exports = { calculateSmartPrimeTime };
