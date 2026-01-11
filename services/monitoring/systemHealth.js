// services/monitoring/systemHealth.js
'use strict';

const logger = require('../../utils/logger');
const keyManager = require('../ai/keyManager'); // نحتاجه لاختبار النبض
const { GoogleGenerativeAI } = require('@google/generative-ai');

class SystemHealthMonitor {
    constructor() {
        this.status = 'HEALTHY'; // HEALTHY | WARNING | LOCKDOWN
        this.consecutiveFailures = 0;
        this.LOCKDOWN_THRESHOLD = 3; // إذا فشل 3 مستخدمين وراء بعض، أغلق النظام
        
        // بروتوكول العنقاء: فحص كل 2 دقيقة إذا كنا في حالة إغلاق
        setInterval(() => this._runPhoenixProbe(), 2 * 60 * 1000);
    }

    // يتم استدعاؤها عند نجاح توليد درس
    reportSuccess() {
        if (this.consecutiveFailures > 0) {
            logger.info(`📉 System healing: Failures reset (was ${this.consecutiveFailures})`);
        }
        this.consecutiveFailures = 0;
        if (this.status !== 'HEALTHY') {
            this.status = 'HEALTHY';
            logger.success('🟢 SYSTEM RECOVERED: Traffic is allowed again.');
        }
    }

    // يتم استدعاؤها عند فشل توليد درس (بعد استنفاذ الـ 15 محاولة)
    reportCriticalFailure(error) {
        this.consecutiveFailures++;
        logger.error(`🔥 Critical Failure #${this.consecutiveFailures}: ${error.message}`);

        if (this.consecutiveFailures >= this.LOCKDOWN_THRESHOLD) {
            this.status = 'LOCKDOWN';
            logger.error('⛔ SYSTEM LOCKDOWN ACTIVATED: Rejecting new uploads to save resources.');
        }
    }

    isLocked() {
        return this.status === 'LOCKDOWN';
    }

    // إعادة الضبط اليدوية (عند إضافة مفاتيح جديدة)
    manualReset() {
        this.status = 'HEALTHY';
        this.consecutiveFailures = 0;
        logger.success('🔧 System Manually Reset by Admin.');
    }

    /**
     * 🦅 بروتوكول العنقاء:
     * يحاول القيام بطلب بسيط جداً ليرى هل عادت المفاتيح للعمل؟
     */
    async _runPhoenixProbe() {
        if (this.status !== 'LOCKDOWN') return;

        logger.info('🦅 Phoenix Protocol: Probing AI availability...');
        
        // نحاول الحصول على مفتاح
        const keyObj = await keyManager.acquireKey();
        if (!keyObj) {
            logger.warn('🦅 Phoenix Probe: No keys available yet.');
            return;
        }

        try {
            // تجربة بسيطة جداً (Ping)
            const genAI = keyObj.client;
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const result = await model.generateContent("Hi");
            const response = await result.response;
            
            if (response.text()) {
                logger.success('🦅 Phoenix Probe SUCCESS! System is rising from the ashes!');
                this.manualReset(); // فتح النظام
                keyManager.reportResult(keyObj.key, true);
            }
        } catch (e) {
            logger.warn(`🦅 Phoenix Probe Failed: ${e.message}. Staying in LOCKDOWN.`);
            keyManager.reportResult(keyObj.key, false, 'probe_failed');
        }
    }
}

const instance = new SystemHealthMonitor();
module.exports = instance;
