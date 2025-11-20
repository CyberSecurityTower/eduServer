

async function checkScheduledActions() {
  try {
    const now = admin.firestore.Timestamp.now();
    
    // استعلام ذكي وسريع: هات المهام التي حان وقتها (executeAt <= now)
    const snapshot = await db.collection('scheduledActions')
      .where('status', '==', 'pending')
      .where('executeAt', '<=', now)
      .limit(50) // دفعة معقولة
      .get();

    if (snapshot.empty) return;

    logger.log(`[Ticker] Found ${snapshot.size} actions to execute.`);
    
    const batch = db.batch();
    const promises = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // 1. إرسال الإشعار
      const notifPromise = sendUserNotification(data.userId, {
        title: data.title || 'تذكير ذكي',
        message: data.message, // الرسالة التي كتبها الـ AI سابقاً
        type: 'smart_reminder',
        meta: { actionId: doc.id }
      });
      promises.push(notifPromise);

      // 2. تحديث الحالة إلى completed
      batch.update(doc.ref, {
        status: 'completed',
        executedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await Promise.all(promises); // إرسال الإشعارات
    await batch.commit(); // تحديث الداتابيز دفعة واحدة
    
    logger.success(`[Ticker] Successfully executed ${snapshot.size} actions.`);

  } catch (err) {
    logger.error('[Ticker] Error:', err.message);
  }
}

// لا تنسَ إضافة الدالة للتصدير في الأسفل:
module.exports = {
  initJobWorker,
  jobWorkerLoop,
  stopWorker,
  processJob,
  checkScheduledActions // <--- أضفنا هذه
};
