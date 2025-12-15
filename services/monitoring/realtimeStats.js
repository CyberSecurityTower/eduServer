// services/monitoring/realtimeStats.js
'use strict';

const supabase = require('../data/supabase');

class LiveMonitor {
  constructor() {
    // 1. الذاكرة (للسرعة اللحظية)
    this.aiRequestsCurrentMinute = 0;
    this.aiRequestsLastMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
    this.rpmHistory = [0, 0, 0, 0, 0, 0]; 

    // 2. القائمة (من الداتابايز)
    this.onlineUsersList = [];

    this.startTime = Date.now();

    // تدوير العدادات (كل دقيقة)
    setInterval(() => this.rotateMetrics(), 60 * 1000);

    // مزامنة المستخدمين من الداتابايز (كل 5 ثواني)
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

  // فارغة لأننا نعتمد على DB
  trackHttpRequest() {}

  // ✅ جلب البيانات من public.users
  async syncWithDatabase() {
    try {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

      const { data: activeUsers, error } = await supabase
        .from('users')
        .select(`
          id, email, first_name, last_name, role, 
          last_active_at, client_telemetry, group_id
        `)
        .gt('last_active_at', twoMinutesAgo)
        .order('last_active_at', { ascending: false });

      if (error) {
        console.error('LiveStats DB Error:', error.message);
        return;
      }

      this.onlineUsersList = activeUsers.map(user => {
        const telemetry = user.client_telemetry || {};
        let deviceName = 'Unknown Device';
        
        // استخراج اسم الجهاز
        if (telemetry.model) deviceName = telemetry.model;
        else if (telemetry.osVersion) deviceName = telemetry.osVersion;
        else if (telemetry.userAgent) {
            if (telemetry.userAgent.includes('Android')) deviceName = 'Android';
            else if (telemetry.userAgent.includes('iPhone')) deviceName = 'iPhone';
            else deviceName = 'Web Browser';
        }

        const lastActive = new Date(user.last_active_at).getTime();
        const secondsAgo = Math.floor((Date.now() - lastActive) / 1000);

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
          action: 'Online',
          status: status,
          secondsAgo: secondsAgo,
          device: deviceName,
          location: 'Algeria'
        };
      });

    } catch (err) {
      console.error('Sync Error:', err);
    }
  }

  getStats() {
    const currentRpmForChart = [...this.rpmHistory];
    currentRpmForChart[5] = this.aiRequestsCurrentMinute;

    return {
      status: "online",
      ai_requests_per_minute: this.aiRequestsCurrentMinute,
      total_tokens_processed: this.aiTokenUsageCurrentMinute,
      active_users: this.onlineUsersList.length,
      rpm_history: currentRpmForChart,
      users_details: this.onlineUsersList
    };
  }
}

const instance = new LiveMonitor();
module.exports = instance;
