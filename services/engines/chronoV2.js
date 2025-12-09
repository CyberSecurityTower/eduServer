// services/engines/chronoV2.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

const CONFIG = {
  WEIGHTS: {
    ORGANIC: 1.0,           // دخول طبيعي
    NOTIF_CLICK_SHORT: 1.5, // فتح إشعار وخرج بسرعة
    NOTIF_CLICK_LONG: 5.0,  // فتح إشعار وجلس (Golden Time)
    NOTIF_IGNORE: -0.5,     // تجاهل (عقاب خفيف مع Decay)
    RECENT_EXAM_BOOST: 2.0  // مضاعف السهر وقت الامتحانات
  },
  DECAY_DAYS: 30,           // الأيام المعتبرة
  EPSILON: 0.2,             // نسبة الاستكشاف (20%)
  MIN_SESSION_GOLDEN: 300   // 5 دقائق لتعتبر جلسة ذهبية
};

async function calculateSmartPrimeTime(userId) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - CONFIG.DECAY_DAYS);

    // 1. جلب البيانات (Logs + Notifications + Exams)
    const [logsRes, notifsRes, examsRes] = await Promise.all([
      supabase.from('login_history')
        .select('login_at, session_duration_sec')
        .eq('user_id', userId)
        .gte('login_at', thirtyDaysAgo.toISOString()),
      
      supabase.from('user_notifications')
        .select('created_at, read, type') 
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString()),
        
      // نفترض أننا نعرف مجموعة الطالب
       supabase.from('users').select('group_id').eq('id', userId).single()
        .then(({ data }) => {
            if(!data?.group_id) return { data: [] };
            return supabase.from('exams').select('exam_date').eq('group_id', data.group_id).gte('exam_date', now.toISOString());
        })
    ]);

    const logs = logsRes.data || [];
    const notifs = notifsRes.data || [];
    const exams = (examsRes.data || []);

    // مصفوفة الـ 168 ساعة (7 أيام × 24 ساعة)
    let scoreMatrix = new Array(168).fill(0);

    // =========================================================
    // A. تحليل السجلات (Organic + Session Quality)
    // =========================================================
    logs.forEach(log => {
      const date = new Date(log.login_at);
      const slot = getSlotIndex(date);
      const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
      
      // Decay Factor: البيانات القديمة تفقد قيمتها تدريجياً
      const recencyWeight = Math.max(0.1, 1 - (daysAgo / CONFIG.DECAY_DAYS));
      
      // هل هي جلسة حديثة جداً (آخر 3 أيام) وفي الليل؟ (Exam Pattern Detector)
      let examBoost = 1.0;
      const hour = (date.getUTCHours() + 1) % 24; // توقيت الجزائر
      if (daysAgo <= 3 && (hour >= 23 || hour <= 2)) {
          // إذا كان لدينا امتحان قريب، نضاعف وزن السهر
          if (exams.length > 0) examBoost = CONFIG.WEIGHTS.RECENT_EXAM_BOOST;
      }

      const score = CONFIG.WEIGHTS.ORGANIC * recencyWeight * examBoost;
      applyGaussianSmoothing(scoreMatrix, slot, score);
    });

    // =========================================================
    // B. تحليل الإشعارات (Reinforcement Learning)
    // =========================================================
    notifs.forEach(notif => {
      const notifDate = new Date(notif.created_at);
      const slot = getSlotIndex(notifDate);
      const daysAgo = (now - notifDate) / (1000 * 60 * 60 * 24);
      const recencyWeight = Math.max(0.1, 1 - (daysAgo / CONFIG.DECAY_DAYS));

      if (notif.read) {
        // نتحقق من "جودة الجلسة" المرتبطة بهذا الإشعار
        // نبحث عن log تم إنشاؤه في غضون 5 دقائق من الإشعار
        const relatedLog = logs.find(l => {
            const lDate = new Date(l.login_at);
            const diff = Math.abs(lDate - notifDate) / 1000;
            return diff < 300; // 5 دقائق
        });

        const isGolden = relatedLog && relatedLog.session_duration_sec > CONFIG.MIN_SESSION_GOLDEN;
        const reward = isGolden ? CONFIG.WEIGHTS.NOTIF_CLICK_LONG : CONFIG.WEIGHTS.NOTIF_CLICK_SHORT;
        
        applyGaussianSmoothing(scoreMatrix, slot, reward * recencyWeight);
      } else {
        // العقاب (مع Decay - ننسى العقاب القديم)
        // لا نطبق Smoothing هنا لنكون دقيقين في تجنب الوقت السيء فقط
        scoreMatrix[slot] += (CONFIG.WEIGHTS.NOTIF_IGNORE * recencyWeight);
      }
    });

    // =========================================================
    // C. اتخاذ القرار (Exploitation vs Exploration)
    // =========================================================
    
    // 1. Exploitation: نجد أفضل ساعة لليوم التالي (غداً)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDayIndex = tomorrow.getDay();
    const startSlice = targetDayIndex * 24;
    const dayScores = scoreMatrix.slice(startSlice, startSlice + 24);

    let bestHour = 20; // Default fallback
    let maxScore = -Infinity;

    dayScores.forEach((score, h) => {
        // فلتر: نتجنب الفجر إلا في حالة "Exam Mode" قوي
        if (h >= 1 && h <= 5 && score < 5) return;
        
        if (score > maxScore) {
            maxScore = score;
            bestHour = h;
        }
    });

    // 2. Exploration (Epsilon-Greedy): 20% فرصة لتجربة وقت مجاور
    let finalHour = bestHour;
    let strategy = 'exploit';
    let minuteOffset = 0;

    if (Math.random() < CONFIG.EPSILON) {
        strategy = 'explore';
        // نجرب ساعة قبل أو بعد، أو نغير الدقائق (-15 أو +15)
        const coinFlip = Math.random();
        if (coinFlip < 0.33) finalHour = (bestHour - 1 + 24) % 24;
        else if (coinFlip < 0.66) finalHour = (bestHour + 1) % 24;
        else minuteOffset = Math.random() > 0.5 ? 15 : -15; // نغير الدقائق
    }

    return {
        bestHour: finalHour,
        minuteOffset: minuteOffset,
        strategy: strategy,
        confidence: maxScore
    };

  } catch (err) {
    logger.error('Chrono V2 Error:', err);
    return { bestHour: 20, minuteOffset: 0, strategy: 'error' };
  }
}

// --- Helpers ---
function getSlotIndex(date) {
   const hour = (date.getUTCHours() + 1) % 24; // +1 Algeria
   const day = date.getDay();
   return (day * 24) + hour;
}

function applyGaussianSmoothing(matrix, centerIndex, value) {
  matrix[centerIndex] += value;
  // توزيع التأثير على الجيران (توسيع النطاق)
  const prev = centerIndex === 0 ? 167 : centerIndex - 1;
  const next = centerIndex === 167 ? 0 : centerIndex + 1;
  // المكافآت تنتشر، العقاب يبقى مركزاً أكثر (أو ينتشر بضعف)
  if (value > 0) {
      matrix[prev] += value * 0.4;
      matrix[next] += value * 0.4;
  }
}

module.exports = { calculateSmartPrimeTime };
