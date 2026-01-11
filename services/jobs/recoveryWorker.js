// services/jobs/recoveryWorker.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
// استدعاء الكونترولر للوصول للدالة الجديدة
const { triggerSystemRetry } = require('../../controllers/sourceController');

async function recoverStuckJobs() {
    logger.info('🧟 Recovery Worker: Hunting for zombies...');

    // 1. تحديد المعايير:
    // - معلقة (Processing) منذ أكثر من 5 دقائق (نفترض أن السيرفر مات أثناءها)
    // - أو فاشلة (Failed) خلال آخر 24 ساعة (لمنحها فرصة ثانية أوتوماتيكية)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // جلب المعلقة
    const { data: stuckJobs } = await supabase
        .from('lesson_sources')
        .select('id, status')
        .eq('status', 'processing')
        .lt('created_at', fiveMinutesAgo);

    /* 
       (اختياري) إذا أردت إعادة محاولة "الفاشلة" أيضاً، ألغِ تعليق هذا الجزء.
       لكن احذر: الملف الفاسد سيفشل دائماً، لذا يفضل إعادة المحاولة مرة واحدة فقط.
       لذلك سنكتفي بالمعلقة (stuck) الآن لضمان الأمان.
    */
    
    if (!stuckJobs || stuckJobs.length === 0) {
        logger.info('✅ System Clean. No stuck jobs found.');
        return;
    }

    logger.warn(`🚑 Found ${stuckJobs.length} stuck jobs. Starting intensive care...`);

    // 2. المعالجة التسلسلية (واحد تلو الآخر)
    // نستخدم for...of بدلاً من Promise.all لتجنب تفجير الذاكرة إذا كان هناك 100 ملف
    for (const job of stuckJobs) {
        logger.info(`💉 Injecting life into Job ${job.id}...`);
        
        // استدعاء دالة النظام لإعادة المحاولة
        await triggerSystemRetry(job.id);
        
        // انتظار صغير (1 ثانية) بين كل ملف والآخر لتهدئة المعالج
        await new Promise(r => setTimeout(r, 1000));
    }

    logger.success('✨ Recovery Mission Complete.');
}

module.exports = { recoverStuckJobs };
