
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
 * تسجيل بداية الجلسة (Session Start)
 * يقوم بضرب عصفورين بحجر: الأرشفة + التحديث الحي
 */
async function logSessionStart(req, res) {
  const { userId, client_telemetry } = req.body;

  if (!userId) return res.status(400).send('UserId required');

  try {
    const appVersion = client_telemetry?.appVersion || '1.0.0';

    // 1. الأرشفة: إضافة سطر جديد في جدول التاريخ (login_history)
    // هذا الجدول يسجل "كل" دخول للمستخدم عبر الزمن
    const { error: historyError } = await supabase.from('login_history').insert({
      user_id: userId,
      login_at: new Date().toISOString(),
      client_telemetry: client_telemetry || {}, // نحفظ حالة الجهاز في تلك اللحظة
      app_version: appVersion
    });

    if (historyError) {
        logger.error('Failed to insert login_history:', historyError.message);
    }

    // 2. التحديث الحي: تحديث جدول المستخدمين (users)
    // هذا الجدول يحتوي على "آخر" حالة معروفة فقط
    const { error: userError } = await supabase.from('users').update({
        last_active_at: new Date().toISOString(),
        app_version: appVersion,       // تحديث نسخة التطبيق
        client_telemetry: client_telemetry // تحديث حالة البطارية والشبكة الحالية
    }).eq('id', userId);

    if (userError) {
        logger.error('Failed to update user status:', userError.message);
    }

    // 3. (اختياري) تحليل فوري للبطارية
    if (client_telemetry && client_telemetry.batteryLevel < 0.15 && !client_telemetry.isCharging) {
        // يمكن هنا تفعيل flag معين أو إرسال تنبيه داخلي
    }
    
    res.status(200).json({ success: true, message: 'Session logged & Status updated' });

  } catch (e) {
    logger.error('logSessionStart Critical Error:', e.message);
    res.status(500).send('Internal Server Error');
  }
}

/**
 * 🚀 Telemetry Ingestion Engine
 * يستقبل حزمة من الأحداث (Batch) ويعالجها بخطين متوازيين.
 */
async function ingestTelemetryBatch(req, res) {
  const start = Date.now();
  const eventsBatch = req.body; // المصفوفة القادمة من الفرونت أند
  const userId = req.user?.id; // من التوكن

  // 1. استجابة فورية (Fire & Forget)
  // لا نترك الفرونت أند ينتظر، نرد بـ OK فوراً
  res.status(200).json({ success: true, queued: eventsBatch.length });

  // 2. المعالجة في الخلفية
  if (!Array.isArray(eventsBatch) || eventsBatch.length === 0) return;

  try {
    // --- أ. تحضير البيانات للخط البارد (Cold Path) ---
    const rowsToInsert = eventsBatch.map(event => ({
      user_id: userId,
      session_id: event.session_id,
      event_name: event.event_name,
      client_timestamp: event.timestamp,
      payload: {
        context: event.context,
        data: event.payload,
        device: event.device_info
      }
    }));

    // حفظ البيانات الخام (Bulk Insert)
    const { error } = await supabase.from('raw_telemetry_logs').insert(rowsToInsert);
    
    if (error) {
        logger.error('Telemetry Insert Error:', error.message);
        return; // نتوقف هنا إذا فشل الحفظ
    }

    // --- ب. تحديث العدادات للخط الساخن (Hot Path) ---
    // نحسب الإحصائيات من الحزمة الحالية فقط
    let quizCount = 0;
    let rageTapCount = 0;

    eventsBatch.forEach(e => {
        if (e.event_name === 'ai_quiz_session_complete') quizCount++;
        if (e.event_name === 'ux_rage_tap') rageTapCount++;
    });

    // استدعاء الدالة الذكية (RPC) لتحديث العدادات
    if (quizCount > 0 || rageTapCount > 0 || rowsToInsert.length > 0) {
        await supabase.rpc('increment_dashboard_stats', {
            inc_events: rowsToInsert.length,
            inc_quizzes: quizCount,
            inc_rage_taps: rageTapCount
        });
    }

    // (اختياري) سجل للأدمن في الكونسول للمراقبة
    // logger.info(`📊 Telemetry: Processed ${eventsBatch.length} events for ${userId} in ${Date.now() - start}ms`);

  } catch (err) {
    logger.error('Telemetry Engine Critical Error:', err.message);
  }
}
**
 * ✅ تتبع حملات الإعلانات (Campaign Analytics)
 * يستقبل البيانات من التطبيق ويرسلها لدالة SQL RPC
 */
async function trackCampaignEvent(req, res) {
  const { campaignId, eventType, pageIndex, duration, metadata } = req.body;
  
  // نأخذ معرف المستخدم من التوكن (لأن المسار محمي بـ requireAuth)
  const userId = req.user?.id; 

  if (!campaignId || !userId) {
    return res.status(400).json({ error: 'Missing campaignId or userId' });
  }

  try {
    // استدعاء الدالة التي أنشأناها في Supabase SQL
    const { error } = await supabase.rpc('track_campaign_event', {
      p_user_id: userId,
      p_campaign_id: campaignId,
      p_event_type: eventType,
      p_page_index: pageIndex || 0,
      p_duration: duration || 0,
      p_meta: metadata || {}
    });

    if (error) {
      logger.error('Campaign RPC Error:', error.message);
      return res.status(500).json({ error: 'Failed to track event' });
    }

    // رد سريع للفرونت أند
    return res.status(200).json({ success: true });

  } catch (err) {
    logger.error('Track Campaign Critical Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
module.exports = {
  logEvent,
  processSession,
  logSessionStart,
  heartbeat,
  ingestTelemetryBatch,
  trackCampaignEvent 
};
