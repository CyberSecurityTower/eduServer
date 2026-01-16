// controllers/bankController.js
'use strict';

const bankGenerator = require('../services/ai/bankGenerator');
const systemHealth = require('../services/monitoring/systemHealth');
const logger = require('../utils/logger');
const CONFIG = require('../config');

async function triggerBankGeneration(req, res) {
    // 1. الأمان
    if (req.headers['x-admin-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. الرد الفوري
    res.json({ message: '🚀 Bank Generation Started. System entering Maintenance Mode.' });

    // 3. العملية في الخلفية
    setImmediate(async () => {
        try {
            // 🔒 قفل النظام
            systemHealth.setMaintenanceMode(true);
            
            logger.info('🏦 [Bank Job] Scanning for lessons...');
            
            // نحاول معالجة 5 دروس كحد أقصى في كل تشغيل لتجنب الضغط الطويل
            let processedCount = 0;
            const MAX_BATCH = 5;

            while (processedCount < MAX_BATCH) {
                const targetLesson = await bankGenerator.findEligibleLesson();
                
                if (!targetLesson) {
                    logger.info('✅ [Bank Job] No more eligible lessons found.');
                    break;
                }

                const success = await bankGenerator.generateAndSaveQuestions(targetLesson);
                if (success) processedCount++;
                
                // استراحة قصيرة بين الدروس
                await new Promise(r => setTimeout(r, 5000));
            }

            logger.success(`🏁 [Bank Job] Finished. Processed ${processedCount} lessons.`);

        } catch (err) {
            logger.error('❌ [Bank Job] Critical Error:', err);
        } finally {
            // 🔓 فتح النظام مهما حدث
            systemHealth.setMaintenanceMode(false);
        }
    });
}

module.exports = { triggerBankGeneration };
