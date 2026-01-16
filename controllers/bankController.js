// controllers/bankController.js
'use strict';

const geniusBankWorker = require('../services/ai/geniusBankWorker');
const CONFIG = require('../config');

async function triggerBankGeneration(req, res) {
    // 1. الأمان
    if (req.headers['x-admin-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. الرد الفوري (عشان التايم آوت)
    res.json({ 
        success: true, 
        message: '🚀 The Genius Dual-Core Engine started. System is now in Maintenance Mode.',
        details: 'Check logs for live progress: Subject -> Lesson'
    });

    // 3. إطلاق المهمة (Fire & Forget)
    // لا ننتظرها هنا لأنها قد تأخذ ساعات
    geniusBankWorker.startMission();
}

module.exports = { triggerBankGeneration };
