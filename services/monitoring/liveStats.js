// services/monitoring/liveStats.js
'use strict';

class LiveMonitor {
  constructor() {
    // عدادات الذكاء الاصطناعي
    this.aiRequestsCurrentMinute = 0;
    this.aiRequestsLastMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
    
    // 🔥 الجديد: تاريخ آخر 6 دقائق للرسم البياني
    this.rpmHistory = [0, 0, 0, 0, 0, 0]; 

    // تتبع المستخدمين
    this.activeUsersMap = new Map();
    this.startTime = Date.now();

    // تدوير العدادات كل 60 ثانية
    setInterval(() => {
      this.rotateMetrics();
    }, 60 * 1000);

    // تنظيف المستخدمين الخاملين
    setInterval(() => {
        this.cleanupStaleUsers();
    }, 10 * 1000);
  }

  rotateMetrics() {
    // 1. تحديث التاريخ (نحذف الأقدم ونضيف الجديد)
    this.rpmHistory.shift(); 
    this.rpmHistory.push(this.aiRequestsCurrentMinute);

    // 2. تصفير العدادات
    this.aiRequestsLastMinute = this.aiRequestsCurrentMinute;
    this.aiRequestsCurrentMinute = 0;
    this.aiTokenUsageCurrentMinute = 0;
  }

  trackAiGeneration(tokens = 0) {
    this.aiRequestsCurrentMinute++;
    this.aiTokenUsageCurrentMinute += tokens;
  }

  // ✅ تحديث لاستقبال بيانات تفصيلية
  trackHttpRequest(userId, userInfo = {}, path = '/', deviceInfo = {}) {
    if (userId) {
      const now = new Date();
      
      // تحليل النشاط
      let action = 'Browsing';
      let isGenerating = false;
      if (path.includes('chat')) { action = 'Chatting 💬'; isGenerating = true; }
      else if (path.includes('quiz')) { action = 'Solving Quiz 📝'; isGenerating = true; }
      else if (path.includes('tasks')) { action = 'Planning 📅'; }
      else if (path.includes('heartbeat')) { action = 'Active 🟢'; }

      // تحديث أو إنشاء بيانات المستخدم
      const existing = this.activeUsersMap.get(userId) || {};
      
      this.activeUsersMap.set(userId, {
        ...existing, // نحافظ على البيانات القديمة لو موجودة
        lastSeen: now,
        // نحدث البيانات فقط إذا توفرت (لتجنب مسح الاسم إذا جاء طلب heartbeat فارغ)
        first_name: userInfo.first_name || existing.first_name || 'Unknown',
        last_name: userInfo.last_name || existing.last_name || '',
        email: userInfo.email || existing.email || 'Hidden',
        role: userInfo.role || existing.role || 'student',
        device: deviceInfo.userAgent || existing.device || 'Unknown',
        ip: deviceInfo.ip || existing.ip,
        action: action,
        isGenerating: isGenerating
      });
    }
  }

  cleanupStaleUsers() {
    const now = new Date();
    for (const [id, data] of this.activeUsersMap.entries()) {
      if (now - data.lastSeen > 45 * 1000) { 
        this.activeUsersMap.delete(id);
      }
      if (data.isGenerating && (now - data.lastSeen > 5000)) {
          data.isGenerating = false;
          data.action = 'Reading/Idle';
      }
    }
  }

  // ✅ إرجاع الهيكل المطلوب بالضبط (JSON Structure)
  getStats() {
    const onlineUsers = Array.from(this.activeUsersMap.entries())
      .map(([id, data]) => ({
        id: id,
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        role: data.role,
        action: data.action,
        status: data.isGenerating ? 'thinking' : 'idle',
        secondsAgo: Math.floor((new Date() - data.lastSeen) / 1000),
        device: this.parseDevice(data.device), // تبسيط اسم الجهاز
        location: data.ip === '::1' ? 'Localhost' : 'IP: ' + data.ip // (يحتاج مكتبة GeoIP للمدينة الحقيقية)
      }))
      .sort((a, b) => a.secondsAgo - b.secondsAgo);

    // دمج العداد الحالي مع التاريخ للرسم البياني اللحظي
    // الـ Frontend يريد آخر 6 دقائق، سنعطيه المصفوفة كما هي
    const currentRpmForChart = [...this.rpmHistory];
    // استبدال آخر عنصر بالعداد اللحظي ليكون الرسم حياً
    currentRpmForChart[5] = this.aiRequestsCurrentMinute; 

    return {
      status: "online",
      ai_requests_per_minute: this.aiRequestsCurrentMinute,
      total_tokens_processed: this.aiTokenUsageCurrentMinute,
      active_users: onlineUsers.length,
      rpm_history: currentRpmForChart, // ✅ المصفوفة المطلوبة
      users_details: onlineUsers       // ✅ القائمة التفصيلية المطلوبة
    };
  }

  // دالة مساعدة لتبسيط اسم الجهاز
  parseDevice(userAgent) {
    if (!userAgent) return 'Unknown';
    if (userAgent.includes('iPhone')) return 'iPhone';
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('Macintosh')) return 'Mac';
    if (userAgent.includes('Windows')) return 'Windows PC';
    if (userAgent.includes('Postman')) return 'Postman Tool';
    return 'Web Browser';
  }
}

const instance = new LiveMonitor();
module.exports = instance;
