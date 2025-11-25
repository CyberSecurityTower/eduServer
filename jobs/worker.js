
const supabase = require('../data/supabase');

async function checkScheduledActions() {
  const now = new Date().toISOString();

  // ✅ Supabase Query
  const { data: actions, error } = await supabase
    .from('scheduled_actions')
    .select('*')
    .eq('status', 'pending')
    .lte('execute_at', now) // Less than or equal
    .order('execute_at', { ascending: true })
    .limit(50);

  if (!actions || actions.length === 0) return;

  logger.log(`[Ticker] Processing ${actions.length} actions.`);
  const updates = [];
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
