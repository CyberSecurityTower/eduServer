// services/monitoring/liveStats.js
'use strict';

const supabase = require('../data/supabase');

class LiveMonitor {
  constructor() {
    this.currentMinuteRequests = 0; // العداد الحالي
    this.lastMinuteRequests = 0;    // عداد الدقيقة السابقة (للعرض الثابت)
    this.peakRPM = 0;               // أعلى رقم وصلنا له منذ تشغيل السيرفر
    this.startTime = Date.now();    // وقت تشغيل السيرفر

    // Map<UserId, { lastSeen: Date, name: String, path: String }>
    this.activeUsersMap = new Map();
    this.dbUpdateTracker = new Map();

    // دورة الصيانة (كل 60 ثانية)
    setInterval(() => {
      this.rotateMetrics();
    }, 60 * 1000);

    // دورة تنظيف المستخدمين (كل 30 ثانية - سريعة)
    setInterval(() => {
        this.cleanupStaleUsers();
    }, 30 * 1000);
  }

  // 1. تدوير العدادات (لكي لا يظهر صفر فجأة)
  rotateMetrics() {
    if (this.currentMinuteRequests > this.peakRPM) {
        this.peakRPM = this.currentMinuteRequests;
    }
    this.lastMinuteRequests = this.currentMinuteRequests; // حفظ الرقم للعرض
    this.currentMinuteRequests = 0; // تصفير العداد الجديد
  }

  // 2. تسجيل طلب جديد
  trackRequest(userId = null, userInfo = {}, path = '/') {
    this.currentMinuteRequests++;

    if (userId) {
      const now = new Date();
      // تحديث الذاكرة
      this.activeUsersMap.set(userId, {
        lastSeen: now,
        email: userInfo.email || 'Hidden',
        lastPath: path // ✅ ميزة جديدة: نعرف آخر صفحة زارها
      });

      this.syncWithDbSmartly(userId);
    }
  }

  // 3. التحديث الذكي للداتابيز (كل 5 دقائق لتخفيف الضغط)
  async syncWithDbSmartly(userId) {
    const now = Date.now();
    const lastUpdate = this.dbUpdateTracker.get(userId) || 0;
    if (now - lastUpdate < 5 * 60 * 1000) return;

    this.dbUpdateTracker.set(userId, now);
    // Fire & Forget (لا ننتظر الـ await لعدم تأخير الطلب)
    supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', userId).then();
  }

  // 4. تنظيف دقيق (من لم يرسل طلباً منذ دقيقتين يعتبر غير نشط)
  cleanupStaleUsers() {
    const now = new Date();
    for (const [id, data] of this.activeUsersMap.entries()) {
      // تقليص المدة إلى 2 دقيقة فقط للدقة
      if (now - data.lastSeen > 2 * 60 * 1000) { 
        this.activeUsersMap.delete(id);
      }
    }
  }

  // 5. تقرير شامل
  getStats() {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    
    // تحويل المستخدمين لقائمة
    const onlineUsers = Array.from(this.activeUsersMap.entries())
      .map(([id, data]) => ({
        id,
        email: data.email,
        path: data.lastPath,
        secondsAgo: Math.floor((new Date() - data.lastSeen) / 1000)
      }))
      .sort((a, b) => a.secondsAgo - b.secondsAgo);

    return {
      live_rpm: this.currentMinuteRequests, // العداد اللحظي
      last_minute_rpm: this.lastMinuteRequests, // العداد الثابت (استخدم هذا في التطبيق)
      peak_rpm: this.peakRPM,
      online_count: onlineUsers.length,
      uptime: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
      users_list: onlineUsers // القائمة التفصيلية
    };
  }
}

// Singleton Pattern
const instance = new LiveMonitor();
module.exports = instance;
