// services/monitoring/liveStats.js
'use strict';

const supabase = require('../data/supabase');

class LiveMonitor {
  constructor() {
    // 1. عدادات الذكاء الاصطناعي (الدماغ)
    this.aiRequestsCurrentMinute = 0;
    this.aiRequestsLastMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
    
    // 2. عدادات السيرفر العامة (للمراقبة التقنية)
    this.httpRequestsCurrentMinute = 0;

    // 3. تتبع المستخدمين (الرادار)
    // Map<UserId, { lastSeen: Date, email: String, action: String, isGenerating: Boolean }>
    this.activeUsersMap = new Map();
    
    this.startTime = Date.now();

    // تدوير العدادات كل 60 ثانية
    setInterval(() => {
      this.rotateMetrics();
    }, 60 * 1000);

    // تنظيف المستخدمين الخاملين كل 10 ثواني (دقة عالية)
    setInterval(() => {
        this.cleanupStaleUsers();
    }, 10 * 1000);
  }

  rotateMetrics() {
    this.aiRequestsLastMinute = this.aiRequestsCurrentMinute;
    this.aiRequestsCurrentMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
    this.httpRequestsCurrentMinute = 0;
  }

  // ✅ دالة جديدة: تسجل فقط عندما يعمل الذكاء الاصطناعي
  trackAiGeneration(tokens = 0) {
    this.aiRequestsCurrentMinute++;
    this.aiTokenUsageCurrentMinute += tokens;
  }

  // ✅ دالة تسجل أي طلب للسيرفر (للرادار)
  trackHttpRequest(userId, userInfo = {}, path = '/') {
    this.httpRequestsCurrentMinute++;

    if (userId) {
      const now = new Date();
      
      // تحديد نوع النشاط بناءً على الرابط
      let action = 'Browsing';
      let isGenerating = false;

      if (path.includes('chat')) { action = 'Chatting 💬'; isGenerating = true; }
      else if (path.includes('quiz')) { action = 'Taking Quiz 📝'; isGenerating = true; }
      else if (path.includes('tasks')) { action = 'Planning 📅'; }
      else if (path.includes('heartbeat')) { action = 'Online 🟢'; } // نبض فقط

      this.activeUsersMap.set(userId, {
        lastSeen: now,
        email: userInfo.email || 'Hidden',
        action: action,
        isGenerating: isGenerating // هل يستهلك موارد الآن؟
      });
    }
  }

  cleanupStaleUsers() {
    const now = new Date();
    for (const [id, data] of this.activeUsersMap.entries()) {
      // إذا لم يرسل أي شيء (حتى heartbeat) لمدة 45 ثانية، نعتبره خرج
      if (now - data.lastSeen > 45 * 1000) { 
        this.activeUsersMap.delete(id);
      }
      // إذا مر 5 ثواني على آخر طلب AI، نلغي حالة "يولد الآن"
      if (data.isGenerating && (now - data.lastSeen > 5000)) {
          data.isGenerating = false;
          data.action = 'Reading/Idle';
      }
    }
  }

  getStats() {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    
    const onlineUsers = Array.from(this.activeUsersMap.entries())
      .map(([id, data]) => ({
        id,
        email: data.email,
        action: data.action,
        status: data.isGenerating ? 'thinking' : 'idle', // للفرونت أند
        secondsAgo: Math.floor((new Date() - data.lastSeen) / 1000)
      }))
      .sort((a, b) => a.secondsAgo - b.secondsAgo);

    return {
      ai_rpm_live: this.aiRequestsCurrentMinute, // العداد اللحظي للذكاء الاصطناعي
      ai_rpm_last_min: this.aiRequestsLastMinute, // العداد الثابت للدقيقة الماضية
      total_tokens_min: this.aiTokenUsageCurrentMinute,
      online_count: onlineUsers.length,
      users_list: onlineUsers,
      uptime: `${Math.floor(uptimeSeconds / 60)}m`
    };
  }
}

const instance = new LiveMonitor();
module.exports = instance;
