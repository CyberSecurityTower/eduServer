// services/monitoring/liveStats.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

class LiveMonitor {
  constructor() {
    // 1. عدادات الأداء (في الذاكرة)
    this.aiRequestsCurrentMinute = 0;
    this.aiRequestsLastMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
    this.rpmHistory = [0, 0, 0, 0, 0, 0]; 

    // 2. قائمة المستخدمين النشطين (سنملؤها من الداتابايز)
    this.onlineUsersList = [];

    this.startTime = Date.now();

    // دورة تدوير العدادات (كل دقيقة)
    setInterval(() => this.rotateMetrics(), 60 * 1000);

    // 🔥 دورة المزامنة مع الداتابايز (كل 5 ثواني)
    // هذا هو التغيير الجذري: نجلب المستخدمين من جدول users الحقيقي
    this.syncWithDatabase(); 
    setInterval(() => this.syncWithDatabase(), 5000);
  }

  rotateMetrics() {
    this.rpmHistory.shift();
    this.rpmHistory.push(this.aiRequestsCurrentMinute);
    this.aiRequestsLastMinute = this.aiRequestsCurrentMinute;
    this.aiRequestsCurrentMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
  }

  trackAiGeneration(tokens = 0) {
    this.aiRequestsCurrentMinute++;
    this.aiTokenUsageCurrentMinute += tokens;
  }

  // هذه الدالة تستدعى من activityTracker لتسجيل الحركة فقط
  trackHttpRequest() {
    // لا نحتاج لتخزين المستخدمين هنا يدوياً، سنعتمد على last_active_at في الداتابايز
  }

  // ✅ الدالة الجديدة: جلب البيانات من هيكلة الداتابايز الصحيحة
  async syncWithDatabase() {
    try {
      // نعتبر المستخدم "أونلاين" إذا كان last_active_at في آخر دقيقتين
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

      const { data: activeUsers, error } = await supabase
        .from('users')
        .select(`
          id, 
          email, 
          first_name, 
          last_name, 
          role, 
          last_active_at, 
          client_telemetry,
          group_id
        `)
        .gt('last_active_at', twoMinutesAgo)
        .order('last_active_at', { ascending: false });

      if (error) {
        console.error('LiveStats DB Error:', error.message);
        return;
      }

      // تنسيق البيانات للوحة التحكم
      this.onlineUsersList = activeUsers.map(user => {
        const telemetry = user.client_telemetry || {};
        const deviceName = telemetry.model || telemetry.osVersion || 'Unknown Device';
        const lastActive = new Date(user.last_active_at).getTime();
        const secondsAgo = Math.floor((Date.now() - lastActive) / 1000);

        // تحديد الحالة بناءً على آخر ظهور
        let status = 'idle';
        if (secondsAgo < 30) status = 'active 🟢';
        else if (secondsAgo < 60) status = 'thinking 🤔';
        else status = 'idle ☕';

        return {
          id: user.id,
          first_name: user.first_name || 'Student',
          last_name: user.last_name || '',
          email: user.email,
          role: user.role || 'student',
          group: user.group_id,
          action: 'Online', // يمكن تحسينها لاحقاً لتكون أكثر دقة
          status: status,
          secondsAgo: secondsAgo,
          device: deviceName,
          location: 'Algiers' // افتراضي حالياً
        };
      });

    } catch (err) {
      console.error('Sync Error:', err);
    }
  }

  getStats() {
    // دمج العداد اللحظي في الرسم البياني
    const currentRpmForChart = [...this.rpmHistory];
    currentRpmForChart[5] = this.aiRequestsCurrentMinute;

    return {
      status: "online",
      ai_requests_per_minute: this.aiRequestsCurrentMinute,
      total_tokens_processed: this.aiTokenUsageCurrentMinute,
      active_users: this.onlineUsersList.length,
      rpm_history: currentRpmForChart,
      users_details: this.onlineUsersList //  القائمة  من الداتابايز
    };
  }
}

const instance = new LiveMonitor();
module.exports = instance;
