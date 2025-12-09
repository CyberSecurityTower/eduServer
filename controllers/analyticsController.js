
// controllers/analyticsController.js
'use strict';

const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { getProgress, sendUserNotification, processSessionAnalytics } = require('../services/data/helpers');
const { runInterventionManager } = require('../services/ai/managers/notificationManager');
const logger = require('../utils/logger');

const db = getFirestoreInstance();

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


async function logSessionStart(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).send('UserId required');

  try {
    // نسجل وثيقة صغيرة وسريعة
    await db.collection('analytics_sessions').add({
      userId,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
      // يمكن إضافة معلومات الجهاز لاحقاً
    });
    
    res.status(200).send('Logged');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
}
async function triggerLiveCoach(userId, eventName, eventData) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return;
  const userCreationDate = userDoc.createTime.toDate();
  const daysSinceJoined = (new Date() - userCreationDate) / (1000 * 60 * 60 * 24);
  if (daysSinceJoined < 2) {
    return;
  }

  switch (eventName) {
    case 'lesson_view_start':
      if (procrastinationTimers.has(userId)) {
        clearTimeout(procrastinationTimers.get(userId));
        procrastinationTimers.delete(userId);
      }

      const progress = await getProgress(userId);
      const isPlanned = progress?.dailyTasks?.tasks?.some(task => task.relatedLessonId === eventData.lessonId);

      if (!isPlanned) {
        const message = await runInterventionManager('unplanned_lesson', { lessonTitle: eventData.lessonTitle });
        await sendUserNotification(userId, { title: 'مبادرة رائعة!', message });
      }
      break;

    case 'started_study_timer':
      const timerId = setTimeout(async () => {
        const recentEvents = await db.collection('userBehaviorAnalytics').doc(userId).collection('events')
          .orderBy('timestamp', 'desc').limit(1).get();

        const lastEvent = recentEvents.docs[0]?.data();
        if (lastEvent && lastEvent.name === 'started_study_timer') {
          const message = await runInterventionManager('timer_procrastination');
          await sendUserNotification(userId, { title: 'هل تحتاج مساعدة؟', message });
        }
        procrastinationTimers.delete(userId);
      }, 120000);

      procrastinationTimers.set(userId, timerId);
      break;
  }
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
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

  try {
    // استدعاء الدالة الذكية في Supabase (RPC)
    const { error } = await supabase.rpc('update_heartbeat', { session_uuid: sessionId });

    if (error) throw error;
    res.status(200).send('♥'); // رد خفيف جداً (1 بايت)
  } catch (err) {
    // لا نسجل Error هنا لتجنب تلوث اللوجز لأن الـ heartbeat متكرر جداً
    res.status(500).end(); 
  }
}

module.exports = {
  logEvent,
  processSession,
  logSessionStart
};
