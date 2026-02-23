
// controllers/bankController.js
'use strict';

const geniusBankWorker = require('../services/ai/geniusBankWorker');
const CONFIG = require('../config');

// 1. تشغيل العملية
async function triggerBankGeneration(req, res) {
    if (req.headers['x-admin-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 🔥 الجديد: استقبال أيدي المادة
    const { subjectId } = req.body;

    res.json({ 
        success: true, 
        message: `🚀 Smart Bank Engine Started. Targeting Subject: ${subjectId || 'ALL'}. Check logs.`,
        status: 'Maintenance Mode ON'
    });

    // إرسال الأيدي للمحرك
    geniusBankWorker.startMission(subjectId);
}

// 2. إيقاف العملية
async function stopBankGeneration(req, res) {
    if (req.headers['x-admin-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const wasRunning = geniusBankWorker.stop();

    if (wasRunning) {
        res.json({ 
            success: true, 
            message: '🛑 Stop signal sent. Workers will finish current lesson and halt.',
            note: 'System maintenance mode will be disabled automatically.'
        });
    } else {
        res.json({ 
            success: false, 
            message: '⚠️ Engine was not running.' 
        });
    }
}

module.exports = { triggerBankGeneration, stopBankGeneration };
