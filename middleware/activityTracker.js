
// middleware/activityTracker.js
'use strict';

const supabase = require('../services/data/supabase');
const liveMonitor = require('../services/monitoring/realtimeStats');

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
      // A. تحديث "آخر ظهور" (كل 30 ثانية لتخفيف الضغط)
      const now = Date.now();
      const lastUpdate = lastUpdateMap.get(userId) || 0;
      if (now - lastUpdate > 30 * 1000) {
          lastUpdateMap.set(userId, now);
          // Fire & Forget: تحديث آخر ظهور
          supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', userId).then();
      }
      
      // B. 💰 زيادة عداد الطلبات (العداد المالي)
      // نحسب الطلبات المهمة فقط (Chat, Quiz, Plans, Analysis)
      const isCostlyRoute = req.path.includes('chat') || req.path.includes('quiz') || req.path.includes('generate') || req.path.includes('analyze');
      
      if (isCostlyRoute) {
          // Fire & Forget: استدعاء دالة الـ RPC لزيادة العداد +1
          supabase.rpc('increment_request_count', { user_id: userId }).then(({ error }) => {
              if (error) console.error('Error incrementing reqs:', error.message);
          });
          
          // تتبع في الرصد اللحظي
          liveMonitor.trackAiGeneration(0);
      }
  }

  next();
}

module.exports = activityTracker;
