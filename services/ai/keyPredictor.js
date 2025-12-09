// services/ai/keyPredictor.js
'use strict';

const supabase = require('../data/supabase');
const keyManager = require('./keyManager');

const CONFIG = {
  // عتبة الخطر (مثلاً إذا وصلنا 80% من قدرة المفاتيح)
  DANGER_THRESHOLD: 0.8, 
  // سعر جوجل الرسمي (للحساب اللحظي)
  PRICING: { input: 0.30, output: 2.50 } 
};

async function predictSystemHealth() {
  // 1. جلب حالة المفاتيح الحالية
  const keys = keyManager.getAllKeysStatus(); // من الذاكرة (سريع جداً)
  const activeKeys = keys.filter(k => k.status !== 'dead');
  
  // 2. حساب السعة القصوى للنظام (Total Capacity)
  // نفترض أن كل مفتاح يتحمل 15 طلب في الدقيقة
  const totalCapacityRPM = activeKeys.length * 15; 
  
  // 3. حساب الضغط الحالي (Current Load) - آخر 5 دقائق
  const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count: recentRequests } = await supabase
    .from('ai_usage_logs')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', fiveMinsAgo);

  const currentRPM = recentRequests / 5; // المعدل في الدقيقة الواحدة

  // 4. حساب نسبة الاستهلاك (Utilization Rate)
  const utilization = currentRPM / totalCapacityRPM;

  // 5. التنبؤ والتحليل
  let status = 'healthy';
  let alerts = [];

  // سيناريو A: المفاتيح تموت
  const deadKeys = keys.filter(k => k.status === 'dead').length;
  if (deadKeys > 0) {
      status = 'warning';
      alerts.push(`⚠️ يوجد ${deadKeys} مفاتيح ميتة! استبدلها فوراً.`);
  }

  // سيناريو B: ضغط عالي جداً (Traffic Spike)
  if (utilization > CONFIG.DANGER_THRESHOLD) {
      status = 'critical';
      const neededKeys = Math.ceil((currentRPM - totalCapacityRPM) / 15) + 2;
      alerts.push(`🚨 خطر توقف الخدمة! الضغط الحالي (${currentRPM.toFixed(1)} RPM) يوشك أن يتجاوز السعة (${totalCapacityRPM}). أضف ${neededKeys} مفاتيح جديدة فوراً.`);
  }

  // سيناريو C: التنبؤ بنفاد الحصة اليومية (Daily Cap Prediction)
  // (هذا يتطلب حساباً معقداً قليلاً يعتمد على وقت اليوم، سنبسطه)
  // إذا كنا في منتصف النهار واستهلكنا 90% من الحصة اليومية
  
  return {
    status, // healthy, warning, critical
    metrics: {
        activeKeys: activeKeys.length,
        deadKeys,
        currentRPM: currentRPM.toFixed(2),
        systemCapacityRPM: totalCapacityRPM,
        utilization: (utilization * 100).toFixed(1) + '%'
    },
    alerts,
    recommendation: alerts.length > 0 ? alerts[0] : "النظام مستقر. استمر في العمل."
  };
}

module.exports = { predictSystemHealth };
