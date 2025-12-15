// middleware/activityTracker.js
'use strict';

const supabase = require('../services/data/supabase');
const liveMonitor = require('../services/monitoring/realtimeStats');

// كاش بسيط لتجنب قصف الداتابايز بالتحديثات في كل ثانية
const lastUpdateMap = new Map();

async function activityTracker(req, res, next) {
  // تجاهل مسارات النظام
  if (req.path.startsWith('/health') || req.path.startsWith('/favicon')) return next();

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

  // 2. تحديث الداتابايز (العمود الفقري للنظام الجديد)
  if (userId) {
      const now = Date.now();
      const lastUpdate = lastUpdateMap.get(userId) || 0;

      // نحدث الداتابايز فقط إذا مرت 30 ثانية على آخر تحديث لهذا المستخدم
      if (now - lastUpdate > 30 * 1000) {
          lastUpdateMap.set(userId, now);
          
          // Fire & Forget Update
          supabase.from('users')
              .update({ last_active_at: new Date().toISOString() })
              .eq('id', userId)
              .then(({ error }) => {
                  if (error) console.error('Error updating last_active_at:', error.message);
              });
      }
      
      // إذا كان طلب ذكاء اصطناعي، نسجله في العداد اللحظي
      if (req.path.includes('chat') || req.path.includes('quiz')) {
          liveMonitor.trackAiGeneration(0); // نحسبها كطلب، التوكيز يحسب لاحقاً
      }
  }

  next();
}

module.exports = activityTracker;
