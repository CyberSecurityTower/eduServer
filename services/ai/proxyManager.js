// services/ai/proxyManager.js
'use strict';

const logger = require('../../utils/logger');

class ProxyManager {
    constructor() {
        // يمكن وضع البروكسيات هنا أو في ملف .env بصيغة مفصولة بفاصلة
        // Example: http://user:pass@ip:port,http://ip:port,...
        const rawProxies = process.env.AI_PROXIES || '';
        this.proxies = rawProxies.split(',').filter(p => p.trim() !== '');
        this.currentIndex = 0;
    }

    /**
     * جلب بروكسي عشوائي أو بالتتابع
     */
    getProxy() {
        if (this.proxies.length === 0) return null;

        // الطريقة 1: تدوير (Round Robin) - جيد لتوزيع الحمل بالتساوي
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        
        // الطريقة 2: عشوائي (Random) - فعل هذا السطر إذا أردت عشوائية تامة
        // const proxy = this.proxies[Math.floor(Math.random() * this.proxies.length)];

        return proxy.trim();
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
