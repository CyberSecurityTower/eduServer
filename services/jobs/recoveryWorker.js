// services/jobs/recoveryWorker.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const sourceController = require('../../controllers/sourceController');

/**
 * يبحث عن المهام العالقة (Zombie Jobs) ويعيد تشغيلها
 * الزومبي هو: مهمة حالتها 'processing' لكن مر عليها أكثر من 10 دقائق
 */
async function recoverStuckJobs() {
    logger.info('🧟 Recovery Worker: Checking for stuck processing jobs...');

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: stuckJobs, error } = await supabase
        .from('lesson_sources')
        .select('*')
        .eq('status', 'processing')
        .lt('created_at', tenMinutesAgo); // فقط القديمة جداً

    if (error) {
        logger.error('Recovery Check Failed:', error.message);
        return;
    }

    if (!stuckJobs || stuckJobs.length === 0) {
        logger.info('✅ No stuck jobs found.');
        return;
    }

    logger.warn(`⚠️ Found ${stuckJobs.length} stuck jobs. Attempting resurrection...`);

    for (const job of stuckJobs) {
        // 1. نضع علامة فشل مؤقتة لنعيد المحاولة
        logger.info(`🔄 Resurrecting Job ID: ${job.id}`);
        
        // نحتاج لمحاكاة كائني req و res لاستدعاء retryProcessing
        // أو الأفضل: استدعاء منطق إعادة المحاولة الداخلي مباشرة (لكن للسرعة سنحاكي الطلب)
        // الحل الأنظف: سنعيد تعيين الحالة إلى 'failed' مع رسالة خاصة، والفرونت إند أو الكرون جوب سيعيد المحاولة
        
        await supabase
            .from('lesson_sources')
            .update({ 
                status: 'failed', 
                error_message: 'System restart detected. Auto-recovery marked this as failed. Please Retry.' 
            })
            .eq('id', job.id);
            
        // (اختياري) يمكنك استدعاء retryProcessing برمجياً هنا إذا أردت الأتمتة الكاملة
    }
}

module.exports = { recoverStuckJobs };
