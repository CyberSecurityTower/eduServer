// services/jobs/recoveryWorker.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { triggerSystemRetry } = require('../../controllers/sourceController');
// 👇 1. استيراد مراقب صحة النظام
const systemHealth = require('../monitoring/systemHealth'); 

async function recoverStuckJobs() {
    // 👇 2. التحقق: إذا كان النظام في حالة إغلاق، لا تقم بالإنعاش الآن وتأجل المهمة
    if (systemHealth.isLocked()) {
        logger.warn('🛡️ Recovery Worker: System is in LOCKDOWN. Skipping recovery until AI revives.');
        
        // أعد المحاولة بعد دقيقة (لعل وعسى بروتوكول العنقاء Phoenix ينجح)
        setTimeout(recoverStuckJobs, 60 * 1000);
        return;
    }

    logger.info('🧟 Recovery Worker: Hunting for zombies...');

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: stuckJobs } = await supabase
        .from('lesson_sources')
        .select('id, status, retry_count')
        .eq('status', 'processing')
        .lt('created_at', fiveMinutesAgo);

    if (!stuckJobs || stuckJobs.length === 0) {
        // لا توجد مهام عالقة، نعيد الفحص بعد فترة (مثلاً 5 دقائق)
         setTimeout(recoverStuckJobs, 5 * 60 * 1000); 
        return;
    }

    logger.warn(`🚑 Found ${stuckJobs.length} potential stuck jobs.`);

    for (const job of stuckJobs) {
        // حماية إضافية: لا تحاول إذا تجاوز الحد الأقصى
        if (job.retry_count >= 3) {
             await supabase.from('lesson_sources').update({ status: 'failed_permanently' }).eq('id', job.id);
             continue;
        }

        logger.info(`💉 Injecting life into Job ${job.id}...`);
        await triggerSystemRetry(job.id);
        
        // انتظار بسيط بين كل عملية لعدم خنق السيرفر
        await new Promise(r => setTimeout(r, 2000));
    }

    logger.success('✨ Recovery Mission Complete.');
}

module.exports = { recoverStuckJobs };
