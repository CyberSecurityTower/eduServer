// services/engines/chronoV2.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

const CONFIG = {
  WEIGHTS: {
    // العوامل القديمة (السلوكية)
    ORGANIC: 1.0,           // دخول طبيعي
    NOTIF_CLICK_SHORT: 1.5, // استجابة سريعة للإشعار
    NOTIF_CLICK_LONG: 5.0,  // استجابة قوية (Golden Time)
    NOTIF_IGNORE: -0.5,     // تجاهل الإشعار
    RECENT_EXAM_BOOST: 2.0, // وضع الطوارئ (الامتحانات)

    // 🔥 العوامل الجديدة (التقنية - Telemetry)
    WIFI_BONUS: 0.3,        // مكافأة الراحة (WiFi = استقرار)
    BATTERY_BONUS: 0.2,     // مكافأة الطاقة (بطارية جيدة)
    CHARGING_BONUS: 0.5,    // مكافأة ذهبية (يشحن = جالس في مكان واحد)
    SHORT_SESSION_PENALTY: -0.5 // عقاب الجلسات القصيرة جداً (تصفح سريع)
  },
  DECAY_DAYS: 30,           // ننسى العادات القديمة بعد شهر
  EPSILON: 0.2,             // نسبة الاستكشاف (20%)
  MIN_SESSION_GOLDEN: 300   // 5 دقائق لتعتبر جلسة ذهبية
};

async function calculateSmartPrimeTime(userId) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - CONFIG.DECAY_DAYS);

    // 1. جلب البيانات (Logs + Notifications + Exams)
    // لاحظ: جلبنا client_telemetry من السجلات
    const [logsRes, notifsRes, userRes] = await Promise.all([
      supabase.from('login_history')
        .select('login_at, session_duration_sec, client_telemetry') 
        .eq('user_id', userId)
        .gte('login_at', thirtyDaysAgo.toISOString()),
      
      supabase.from('user_notifications')
        .select('created_at, read') 
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString()),
        
      supabase.from('users').select('group_id').eq('id', userId).single()
    ]);

    let exams = [];
    if (userRes.data?.group_id) {
        const { data } = await supabase.from('exams')
            .select('exam_date')
            .eq('group_id', userRes.data.group_id)
            .gte('exam_date', now.toISOString());
        exams = data || [];
    }

    const logs = logsRes.data || [];
    const notifs = notifsRes.data || [];

    // مصفوفة الـ 168 ساعة (7 أيام × 24 ساعة) لتغطية أسبوع كامل
    let scoreMatrix = new Array(168).fill(0);

    // =========================================================
    // A. تحليل السجلات (Organic + Telemetry + Session Quality)
    // =========================================================
    logs.forEach(log => {
      const date = new Date(log.login_at);
      const slot = getSlotIndex(date);
      const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
      
      // Decay Factor: البيانات القديمة تفقد قيمتها تدريجياً
      const recencyWeight = Math.max(0.1, 1 - (daysAgo / CONFIG.DECAY_DAYS));
      
      // Exam Pattern Detector: هل نحن في فترة امتحانات؟
      let examBoost = 1.0;
      const hour = (date.getUTCHours() + 1) % 24; // توقيت الجزائر
      if (daysAgo <= 3 && (hour >= 23 || hour <= 2)) {
          if (exams.length > 0) examBoost = CONFIG.WEIGHTS.RECENT_EXAM_BOOST;
      }

      // حساب النقاط الأساسية
      let score = CONFIG.WEIGHTS.ORGANIC;

      // 🔥 دمج بيانات التيليميتري (الجديد)
      const telemetry = log.client_telemetry || {};
      
      // 1. الشبكة: WiFi يعني استقراراً وراحة بال
      if (telemetry.networkType === 'WIFI') {
          score += CONFIG.WEIGHTS.WIFI_BONUS;
      }

      // 2. الطاقة: الشحن يعني أن المستخدم جالس بجوار مقبس (احتمال دراسة أكبر)
      if (telemetry.isCharging) {
          score += CONFIG.WEIGHTS.CHARGING_BONUS;
      } else if (telemetry.batteryLevel > 0.5) {
          score += CONFIG.WEIGHTS.BATTERY_BONUS;
      }

      // 3. جودة الجلسة: هل كانت طويلة ومفيدة؟
      if (log.session_duration_sec > CONFIG.MIN_SESSION_GOLDEN) {
          score *= 1.5; // مكافأة ضخمة للجلسات الطويلة
      } else if (log.session_duration_sec && log.session_duration_sec < 60) {
          score += CONFIG.WEIGHTS.SHORT_SESSION_PENALTY; // عقاب للتصفح السريع
      }

      // تطبيق الوزن الزمني (Recency) ومضاعف الامتحانات
      score = score * recencyWeight * examBoost;

      // توزيع النقاط على الساعات المجاورة (Smoothing)
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
        // هل فتح الإشعار وأدى لجلسة دراسة؟
        const relatedLog = logs.find(l => {
            const lDate = new Date(l.login_at);
            const diff = Math.abs(lDate - notifDate) / 1000;
            return diff < 600; // خلال 10 دقائق
        });

        const isGolden = relatedLog && relatedLog.session_duration_sec > CONFIG.MIN_SESSION_GOLDEN;
        const reward = isGolden ? CONFIG.WEIGHTS.NOTIF_CLICK_LONG : CONFIG.WEIGHTS.NOTIF_CLICK_SHORT;
        
        applyGaussianSmoothing(scoreMatrix, slot, reward * recencyWeight);
      } else {
        // تجاهل الإشعار = وقت سيء
        scoreMatrix[slot] += (CONFIG.WEIGHTS.NOTIF_IGNORE * recencyWeight);
      }
    });

    // =========================================================
    // C. اتخاذ القرار (Exploitation vs Exploration)
    // =========================================================
      const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDayIndex = tomorrow.getDay(); 
    
    const startSlice = targetDayIndex * 24;
    const dayScores = scoreMatrix.slice(startSlice, startSlice + 24);

    // ✅ التعديل هنا: نضع عتبة (Threshold)
    let bestHour = 20; // الافتراضي: 8 مساءً
    let maxScore = 0.5; // يجب أن يكون السكور أعلى من 0.5 لتغيير الوقت الافتراضي

    dayScores.forEach((score, h) => {
        // تجنب الفجر (1-5) إلا إذا كان Score عالي جداً
        if (h >= 1 && h <= 5 && score < 5) return;
        
        if (score > maxScore) {
            maxScore = score;
            bestHour = h;
        }
    });

    // Epsilon-Greedy: نجرب أوقاتاً جديدة بنسبة 20%
    let finalHour = bestHour;
    let strategy = 'exploit'; // استغلال أفضل وقت معروف
    let minuteOffset = 0;

    if (Math.random() < CONFIG.EPSILON) {
        strategy = 'explore'; // تجربة وقت جديد
        const coinFlip = Math.random();
        // نجرب ساعة قبل أو بعد، أو نغير الدقائق قليلاً
        if (coinFlip < 0.33) finalHour = (bestHour - 1 + 24) % 24;
        else if (coinFlip < 0.66) finalHour = (bestHour + 1) % 24;
        else minuteOffset = Math.random() > 0.5 ? 15 : -15; 
    }

    return {
        bestHour: finalHour,
        minuteOffset: minuteOffset,
        strategy: strategy,
        confidence: maxScore > 10 ? 'high' : 'medium'
    };

  } catch (err) {
    logger.error('Chrono V2 Error:', err.message);
    // Fallback آمن
    return { bestHour: 20, minuteOffset: 0, strategy: 'error_fallback' };
  }
}

// --- Helpers (دوال مساعدة للرياضيات) ---

// تحويل التاريخ إلى رقم الخانة (من 0 إلى 167)
function getSlotIndex(date) {
   const hour = (date.getUTCHours() + 1) % 24; // +1 Algeria TimeZone
   const day = date.getDay(); // 0-6
   return (day * 24) + hour;
}

// توزيع النقاط على الجيران (Gaussian Smoothing)
// الفائدة: إذا دخل الطالب الساعة 8، فهذا يعني أن 7 و 9 أوقات جيدة أيضاً
function applyGaussianSmoothing(matrix, centerIndex, value) {
  matrix[centerIndex] += value;
  
  // الجار السابق (مع مراعاة دوران الأسبوع)
  const prev = centerIndex === 0 ? 167 : centerIndex - 1;
  // الجار اللاحق
  const next = centerIndex === 167 ? 0 : centerIndex + 1;
  
  if (value > 0) {
      matrix[prev] += value * 0.4; // الجيران يأخذون 40% من القيمة
      matrix[next] += value * 0.4;
  }
}

module.exports = { calculateSmartPrimeTime };
