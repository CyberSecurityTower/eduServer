
// controllers/analyticsController.js
'use strict';

const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { getProgress, sendUserNotification, processSessionAnalytics } = require('../services/data/helpers');
const { runInterventionManager } = require('../services/ai/managers/notificationManager');
const logger = require('../utils/logger');
const supabase = require('../services/data/supabase');


const procrastinationTimers = new Map();

function scheduleTriggerLiveCoach(userId, eventName, eventData) {
  const key = `${userId}:${eventName}`;
  const DELAY_MS = 1000;

  const prev = procrastinationTimers.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(async () => {
    procrastinationTimers.delete(key);
    try {
      await triggerLiveCoach(userId, eventName, eventData);
    } catch (err) {
      logger.error('triggerLiveCoach error for', key, err);
    }
  }, DELAY_MS);

  procrastinationTimers.set(key, timer);
}



// دالة مصححة لِـ logEvent
async function logEvent(req, res) {
  try {
    const { userId, eventName, eventData = {} } = req.body;

    if (!userId || !eventName) {
      return res.status(400).json({ error: 'userId and eventName are required.' });
    }

    const analyticsRef = db.collection('userBehaviorAnalytics').doc(userId);

    // سجل الحدث داخل المجموعة events
    await analyticsRef.collection('events').add({
      name: eventName,
      data: eventData,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // تحديث عداد الدروس عند بدء مشاهدة الدرس
    if (eventName === 'lesson_view_start') {
      await analyticsRef.set(
        { lessonsViewedCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );
    }

    // معالجة نقرة الإشعار (notification click)
    if (eventName === 'notification_click') {
      // eventData قد يحتوي على شيء مثل: { message: "...", type: "re_engagement" }
      if (eventData.type === 're_engagement') {
        await db.collection('users').doc(userId).update({
          pendingReEngagement: {
            active: true,
            triggerMessage: eventData.message || 'Unknown message',
            timestamp: new Date().toISOString(),
          },
        });

        if (typeof logger !== 'undefined' && logger.success) {
          logger.success(`[Analytics] User ${userId} returned via Notification!`);
        }
      }
    }

    // جدولة/تشغيل الـ coach (نفّذها، ولا تنتج استجابة أخرى بعد هذا السطر)
    try {
      // إذا scheduleTriggerLiveCoach هو دالة غير حظية، يمكنك اختيار await أو تركها بدون await
      // هنا سأُشغّلها بدون await حتى لا نؤخر الرد HTTP (لكن يمكنك تغييرها إلى await إذا أردت الانتظار)
      scheduleTriggerLiveCoach(userId, eventName, eventData);
    } catch (schedErr) {
      // لا نريد أن يفشل الرد لأن فشل جدولـة الـ coach — فقط سجل الخطأ
      if (typeof logger !== 'undefined' && logger.error) {
        logger.error('[Analytics] scheduleTriggerLiveCoach error:', schedErr);
      }
    }

    // أرسل استجابة واحدة فقط
    return res.status(202).json({ message: 'Event logged. Coach is analyzing.' });

  } catch (error) {
    // خطأ عام أثناء المعالجة
    if (typeof logger !== 'undefined' && logger.error) {
      logger.error('/log-event error:', error);
    }
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to log event.' });
    } else {
      // إذا كانت الاستجابة قد أُرسلت مسبقاً — فقط سجّل الخطأ
      if (typeof logger !== 'undefined' && logger.error) {
        logger.error('Error after response sent:', error);
      }
      return;
    }
  }
}


async function processSession(req, res) {
  const { userId, sessionId } = req.body;

  if (!userId || !sessionId) {
    return res.status(400).json({ error: 'userId and sessionId are required.' });
  }

  res.status(202).json({ message: 'Session processing started.' });

  processSessionAnalytics(userId, sessionId).catch(e => logger.error('Background processing failed:', e));
}

async function heartbeat(req, res) {
  const { sessionId } = req.body;
  
  // رد سريع جداً ولا ننتظر الـ DB
  res.status(200).send('♥');

  if (!sessionId) return;

  try {
    // استدعاء RPC في Supabase لتحديث الوقت وحساب المدة
    await supabase.rpc('update_heartbeat', { session_uuid: sessionId });
  } catch (err) {
    // Silent fail
  }
}


/**
 * تسجيل بداية الجلسة + تحديث بيانات التيليميتري الحية
 */
async function logSessionStart(req, res) {
  // ✅ نستخدم الاسم المعتمد: client_telemetry
  const { userId, client_telemetry } = req.body; 

  if (!userId) return res.status(400).send('UserId required');

  try {
    // 1. تسجيل الجلسة في Firestore (لأغراض التحليل التاريخي - History)
    // هذا يسمح لك مستقبلاً بمعرفة: "كيف كانت بطاريته عندما بدأ الجلسة؟"
    await db.collection('analytics_sessions').add({
      userId,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
      client_telemetry: client_telemetry || {}, // تخزين السياق التقني للجلسة
    });
    
    // 2. تحديث "الحالة الحية" في Supabase (لأغراض اتخاذ القرار الفوري)
    // هذا العمود (client_telemetry) في جدول users سيكون دائماً "أحدث حالة"
    if (client_telemetry) {
        await supabase.from('users').update({
            client_telemetry: client_telemetry, 
            last_active_at: new Date().toISOString()
        }).eq('id', userId);

        // 🧠 تحليل فوري بسيط (Micro-Analysis):
        // إذا كانت البطارية منخفضة جداً وغير مشحونة، قد نسجل "حدث خطر"
        if (client_telemetry.batteryLevel < 0.15 && !client_telemetry.isCharging) {
             logger.warn(`🔋 Low Battery Alert for User ${userId}: ${Math.round(client_telemetry.batteryLevel * 100)}%`);
             // مستقبلاً: يمكن إرسال هذا لـ "كرونو" ليقترح جلسة قصيرة
        }
    } else {
        // تحديث الوقت فقط إذا لم تتوفر بيانات الجهاز
        await supabase.from('users').update({
            last_active_at: new Date().toISOString()
        }).eq('id', userId);
    }
    
    res.status(200).send('Logged & Telemetry Updated');

  } catch (e) {
    logger.error('logSessionStart Error:', e.message);
    res.status(500).send('Error');
  }
}
module.exports = {
  logEvent,
  processSession,
  logSessionStart,
  heartbeat 
};
