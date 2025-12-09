// services/engines/chronoV2.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

const WEIGHTS = {
  ORGANIC_LOGIN: 1.0,        // دخول عادي
  NOTIFICATION_CLICK: 3.5,   // استجابة لإشعار (مكافأة كبيرة)
  NOTIFICATION_IGNORE: -1.5, // تجاهل إشعار (عقاب)
  LONG_SESSION_BONUS: 1.5,   // جلسة طويلة (> 10 دقائق)
  DECAY: 0.15                // معامل النسيان
};

async function calculateSmartPrimeTime(userId) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const now = new Date();

    // 1. جلب البيانات (Logs + Notifications + Exams) بالتوازي
    const [logsRes, notifsRes, examsRes] = await Promise.all([
      // سجلات الدخول
      supabase.from('login_history')
        .select('login_at, session_duration_sec')
        .eq('user_id', userId)
        .gte('login_at', thirtyDaysAgo.toISOString()),
      
      // الإشعارات المرسلة (لمعرفة ما تم تجاهله وما تم نقره)
      supabase.from('user_notifications')
        .select('created_at, read, type') // نفترض أن read = clicked هنا للتبسيط
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString()),

      // الامتحانات القادمة (لضبط الـ Academic Pressure)
      supabase.from('exams') // أو الجدول المناسب حسب هيكلتك
        .select('exam_date')
        .eq('group_id', 'GET_FROM_USER_PROFILE') // ستحتاج لجلب الـ group_id أولاً
        .gte('exam_date', now.toISOString())
        .limit(1)
    ]);

    const logs = logsRes.data || [];
    const notifs = notifsRes.data || [];
    const exams = examsRes.data || [];

    // مصفوفة الـ 168 ساعة (7 أيام * 24 ساعة)
    let scoreMatrix = new Array(168).fill(0);

    // =========================================================
    // المرحلة 1: تحليل الدخول العضوي (Organic Logic)
    // =========================================================
    logs.forEach(log => {
      const date = new Date(log.login_at);
      const slot = getSlotIndex(date); // دالة مساعدة بالأسفل
      const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
      const recencyWeight = 1 / (1 + (WEIGHTS.DECAY * daysAgo));
      
      let score = WEIGHTS.ORGANIC_LOGIN * recencyWeight;

      // 🌟 Level Max: مكافأة الجلسات الطويلة
      if (log.session_duration_sec > 600) { // أكثر من 10 دقائق
        score *= WEIGHTS.LONG_SESSION_BONUS;
      }

      applyGaussianSmoothing(scoreMatrix, slot, score);
    });

    // =========================================================
    // المرحلة 2: التعلم التعزيزي (Reinforcement Learning)
    // =========================================================
    notifs.forEach(notif => {
      const date = new Date(notif.created_at);
      const slot = getSlotIndex(date);
      const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
      const recencyWeight = 1 / (1 + (WEIGHTS.DECAY * daysAgo));

      if (notif.read) {
        // 🎯 إصابة! (Positive Reward)
        // المستخدم يحب الإشعارات في هذا الوقت
        applyGaussianSmoothing(scoreMatrix, slot, WEIGHTS.NOTIFICATION_CLICK * recencyWeight);
      } else {
        // ❌ خطأ! (Negative Reward)
        // أزعجنا المستخدم أو لم ينتبه، نقلل الاحتمالية في هذا الوقت
        // نطبق العقاب فقط على الساعة المحددة بدقة (بدون Smoothing واسع)
        scoreMatrix[slot] += (WEIGHTS.NOTIFICATION_IGNORE * recencyWeight);
      }
    });

    // =========================================================
    // المرحلة 3: سياق الامتحان (Context Awareness)
    // =========================================================
    // إذا كان هناك امتحان في الـ 3 أيام القادمة، نغير القواعد
    let examMode = false;
    if (exams.length > 0) {
        const diffDays = (new Date(exams[0].exam_date) - now) / (1000 * 3600 * 24);
        if (diffDays <= 3) examMode = true;
    }

    if (examMode) {
        // في وقت الامتحانات:
        // 1. نزيد احتمالية ساعات الليل المتأخرة (السهر)
        // 2. نتجاهل العقوبات السابقة (ربما يدرس في أوقات غير معتادة)
        for (let i = 0; i < 168; i++) {
            const hour = i % 24;
            if (hour >= 22 || hour <= 2) {
                scoreMatrix[i] *= 1.5; // Boost Night Owls
            }
        }
    }

    // =========================================================
    // المرحلة 4: استخراج النتائج
    // =========================================================
    // نحدد اليوم المستهدف (غداً)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDayIndex = tomorrow.getDay();
    
    const startSlice = targetDayIndex * 24;
    const dayScores = scoreMatrix.slice(startSlice, startSlice + 24);

    // البحث عن القمة (Peak)
    let bestHour = 20; // Default
    let maxScore = -9999;

    // نبحث أيضاً عن "أفضل ثاني وقت" (Backup)
    dayScores.forEach((score, hour) => {
      // فلتر: لا ترسل إشعارات في الفجر إلا إذا كان examMode نشط والسكور عالي جداً
      if (!examMode && hour >= 1 && hour <= 6) return; 

      if (score > maxScore) {
        maxScore = score;
        bestHour = hour;
      }
    });

    return {
      bestHour,
      score: maxScore,
      isExamMode: examMode,
      confidence: maxScore > 3 ? 'High' : 'Low'
    };

  } catch (err) {
    logger.error('Chrono V2 Error:', err.message);
    return { bestHour: 20, error: true };
  }
}

// --- دوال مساعدة ---

function getSlotIndex(date) {
   // +1 for Algeria Timezone correction (if UTC)
   const hour = (date.getUTCHours() + 1) % 24; 
   const day = date.getDay();
   return (day * 24) + hour;
}

function applyGaussianSmoothing(matrix, centerIndex, value) {
  // المركز
  matrix[centerIndex] += value;
  
  // الجيران (يمين ويسار) بتأثير أقل (50%)
  const prev = centerIndex === 0 ? 167 : centerIndex - 1;
  const next = centerIndex === 167 ? 0 : centerIndex + 1;
  
  // لا نطبق العقاب السالب على الجيران بقوة، فقط المكافآت الموجبة لتوسيع النطاق
  if (value > 0) {
      matrix[prev] += value * 0.5;
      matrix[next] += value * 0.5;
  }
}

module.exports = { calculateSmartPrimeTime };
