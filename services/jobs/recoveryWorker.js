// services/jobs/recoveryWorker.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
// استدعاء الكونترولر للوصول للدالة الجديدة
const { triggerSystemRetry } = require('../../controllers/sourceController');

async function recoverStuckJobs() {
    logger.info('🧟 Recovery Worker: Hunting for zombies...');

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // نعدل الاستعلام: نستبعد الحالات النهائية
    const { data: stuckJobs } = await supabase
        .from('lesson_sources')
        .select('id, status, retry_count') // نجلب العداد أيضاً للمراقبة
        .eq('status', 'processing')        // فقط العالقة
        .lt('created_at', fiveMinutesAgo); // القديمة

    if (!stuckJobs || stuckJobs.length === 0) {
        return;
    }

    logger.warn(`🚑 Found ${stuckJobs.length} potential stuck jobs.`);

    for (const job of stuckJobs) {
        // فحص إضافي سريع قبل الاستدعاء (اختياري لأن الدالة الداخلية تفحص أيضاً)
        // لكن هذا يوفر استدعاء للدالة إذا كنا نعرف مسبقاً
        if (job.retry_count >= 3) {
             // تحديث سريع للحالة إذا كانت ما تزال processing بالخطأ
             await supabase.from('lesson_sources').update({ status: 'failed_permanently' }).eq('id', job.id);
             continue;
        }

        await triggerSystemRetry(job.id);
        await new Promise(r => setTimeout(r, 1000));
    }


    logger.success('✨ Recovery Mission Complete.');
}

module.exports = { recoverStuckJobs };
