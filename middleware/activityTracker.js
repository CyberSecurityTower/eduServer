
// middleware/activityTracker.js
'use strict';

const supabase = require('../services/data/supabase');
const liveMonitor = require('../services/monitoring/realtimeStats');
// نحتاج لاستيراد helper لمسح الكاش عند تحديث الاستهلاك
const { cacheDel } = require('../services/data/helpers');

// كاش لتجنب تحديث "آخر ظهور" في كل ثانية
const lastUpdateMap = new Map();

async function activityTracker(req, res, next) {
  // تجاهل المسارات التي لا تستهلك موارد (مثل الصور، الصحة)
  if (req.method === 'OPTIONS' || req.path.startsWith('/health') || req.path.startsWith('/favicon')) {
    return next();
  }

  let userId = null;

  // 1. استخراج الهوية
  if (req.user) {
      userId = req.user.id;
  } else if (req.headers.authorization) {
      try {
          const token = req.headers.authorization.split(' ')[1];
          const base64Url = token.split('.')[1];
          const payload = JSON.parse(Buffer.from(base64Url, 'base64').toString());
          userId = payload.sub;
      } catch (e) {}
  }

  if (userId) {
      const now = Date.now();
      
      // A. تحديث "آخر ظهور" (كل 60 ثانية لتخفيف الضغط على الداتابايز)
      const lastUpdate = lastUpdateMap.get(userId) || 0;
      if (now - lastUpdate > 60 * 1000) {
          lastUpdateMap.set(userId, now);
          // Fire & Forget: تحديث آخر ظهور
          supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', userId).then();
      }
      
      // B. 💰 زيادة عداد الاستهلاك (Tier System Tracker)
      // نحسب الطلبات "المكلفة" فقط التي تستخدم الذكاء الاصطناعي
      const isCostlyRoute = req.path.includes('chat') || 
                            req.path.includes('quiz') || 
                            req.path.includes('generate') || 
                            req.path.includes('analyze') ||
                            req.path.includes('ghost');
      
      if (isCostlyRoute) {
          // Fire & Forget: استدعاء دالة الـ RPC الذكية
          // هذه الدالة تزيد العداد، وتصفر العداد اليومي إذا دخلنا يوماً جديداً
          supabase.rpc('increment_user_usage', { p_user_id: userId }).then(({ error }) => {
              if (error) {
                  console.error('Usage tracking error:', error.message);
              } else {
                  // ✅ مهم جداً: نمسح كاش البروفايل لهذا المستخدم
                  // السبب: لكي يرى المستخدم العداد الجديد فوراً في التطبيق ولا يرى القيمة القديمة
                  cacheDel('profile', userId);
              }
          });
          
          // تتبع في الرصد اللحظي للأدمين
          liveMonitor.trackAiGeneration(0);
      }
  }

  next();
}

module.exports = activityTracker;
