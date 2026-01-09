// services/ai/proxyManager.js
'use strict';

const logger = require('../../utils/logger');

class ProxyManager {
 constructor() {
        const rawProxies = process.env.AI_PROXIES || '';
        // تنظيف القائمة وحذف الفراغات
        this.proxies = rawProxies.split(',').map(p => p.trim()).filter(p => p !== '');
        this.currentIndex = 0;
    }


    /**
     * جلب بروكسي عشوائي أو بالتتابع
     */
     getProxy() {
        if (this.proxies.length === 0) return null; // 👈 هنا يكمن السر: نعود لاستخدام IP الجهاز

        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        return proxy;
    }

    getProxyCount() {
        return this.proxies.length;
    }


    reportBadProxy(proxyUrl) {
        // يمكن تطوير هذا الجزء لحذف البروكسي السيء مؤقتاً
        logger.warn(`⚠️ Reported bad proxy: ${proxyUrl}`);
    }
}

const instance = new ProxyManager();
module.exports = instance;
