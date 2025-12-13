// services/monitoring/liveStats.js
'use strict';

const supabase = require('../data/supabase');

class LiveMonitor {
  constructor() {
    // تخزين عدد الطلبات في الدقيقة الحالية
    this.currentMinuteRequests = 0;
    
    // تخزين المستخدمين النشطين في الذاكرة (آخر 5 دقائق)
    // Map<UserId, { lastSeen: Date, name: String }>
    this.activeUsersMap = new Map();

    // لتجنب الكتابة في الداتابيز مع كل طلب (Throttling)
    this.dbUpdateTracker = new Map(); 

    // تصفير العداد كل دقيقة
    setInterval(() => {
      this.currentMinuteRequests = 0;
      this.cleanupStaleUsers();
    }, 60 * 1000);
  }

  // 1. تسجيل طلب جديد
  trackRequest(userId = null, userInfo = {}) {
    this.currentMinuteRequests++;

    if (userId) {
      const now = new Date();
      
      // تحديث الذاكرة الفورية (سريع جداً)
      this.activeUsersMap.set(userId, {
        lastSeen: now,
        name: userInfo.name || 'Unknown',
        email: userInfo.email || 'Hidden'
      });

      // تحديث الداتابيز (بذكاء: مرة واحدة كل دقيقتين للمستخدم)
      this.syncWithDbSmartly(userId);
    }
  }

  // 2. التحديث الذكي للداتابيز
  async syncWithDbSmartly(userId) {
    const now = Date.now();
    const lastUpdate = this.dbUpdateTracker.get(userId) || 0;

    // إذا مر أقل من دقيقتين على آخر تحديث للداتابيز، لا تفعل شيئاً
    if (now - lastUpdate < 2 * 60 * 1000) return;

    // تحديث الداتابيز
    this.dbUpdateTracker.set(userId, now);
    try {
      await supabase.from('users').update({
        last_active_at: new Date().toISOString()
      }).eq('id', userId);
    } catch (e) {
      console.error('Failed to update last_active_at:', e.message);
    }
  }

  // 3. تنظيف المستخدمين الذين غادروا (أكثر من 5 دقائق خمول)
  cleanupStaleUsers() {
    const now = new Date();
    for (const [id, data] of this.activeUsersMap.entries()) {
      if (now - data.lastSeen > 5 * 60 * 1000) { // 5 دقائق
        this.activeUsersMap.delete(id);
        this.dbUpdateTracker.delete(id); // تنظيف الذاكرة
      }
    }
  }

  // 4. الحصول على التقرير المباشر
  getStats() {
    // تحويل Map إلى مصفوفة مرتبة حسب الأحدث
    const onlineUsers = Array.from(this.activeUsersMap.entries())
      .map(([id, data]) => ({
        id,
        name: data.name,
        email: data.email,
        lastSeen: data.lastSeen,
        secondsAgo: Math.floor((new Date() - data.lastSeen) / 1000)
      }))
      .sort((a, b) => a.secondsAgo - b.secondsAgo); // الأحدث أولاً

    return {
      rpm: this.currentMinuteRequests, // Requests Per Minute
      onlineCount: onlineUsers.length,
      onlineList: onlineUsers // قائمة دقيقة بمن متصل الآن
    };
  }
}

module.exports = new LiveMonitor();
