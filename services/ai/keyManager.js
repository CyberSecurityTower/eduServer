'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { shuffled } = require('../../utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class KeyManager {
    constructor() {
        this.keys = new Map();
        this.queue = [];
        this.MAX_FAILS = 4;
        this.isInitialized = false;
        
        // الذاكرة الجماعية للفشل
        this.globalCooldowns = new Map(); 
        this.lastResetDay = new Date().getDate(); 
        
        // فحص يومي لتصفير العدادات
        setInterval(() => this._dailyResetCheck(), 60 * 1000);
    }

    /**
     * تهيئة النظام وتحميل المفاتيح من Env و Database
     */
    async init() {
        if (this.isInitialized) return;
        logger.info('🔑 KeyManager: Initializing Hybrid Mode (Google + HF)...');

        try {
            // 1. جلب المفاتيح من قاعدة البيانات (إن وجدت)
            const { data: dbKeys, error } = await supabase.from('system_api_keys').select('*');
            if (error) logger.warn(`KeyManager DB Notice: ${error.message} (Using Env only if DB fails)`);

            const dbKeyMap = new Map();
            if (dbKeys) dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));

            // 2. تجميع مفاتيح Google من Env
            if (process.env.GOOGLE_API_KEY) this._mergeKey(process.env.GOOGLE_API_KEY, 'Google_Master', 'google', dbKeyMap);
            for (let i = 1; i <= 20; i++) {
                const k = process.env[`GOOGLE_API_KEY_${i}`];
                if (k) this._mergeKey(k, `Google_${i}`, 'google', dbKeyMap);
            }

            // 3. تجميع مفاتيح Hugging Face من Env
            for (let i = 1; i <= 10; i++) {
                const k = process.env[`HUGGINGFACE_API_KEY_${i}`];
                if (k) this._mergeKey(k, `HF_Key_${i}`, 'huggingface', dbKeyMap);
            }

            // 4. إضافة المفاتيح الموجودة في الداتابيز فقط (ولم تكن في Env)
            for (const [keyStr, row] of dbKeyMap.entries()) {
                // محاولة استنتاج النوع إذا لم يكن محدداً
                let provider = row.provider;
                if (!provider) {
                    if (keyStr.startsWith('hf_')) provider = 'huggingface';
                    else provider = 'google';
                }
                
                this._addKeyToMemory(
                    keyStr,
                    row.nickname || 'DB_Key',
                    provider,
                    0, // Reset fails on reboot
                    row.usage_count,
                    row.today_requests_count,
                    row.last_reset_at
                );
            }

            logger.success(`🧠 KeyManager Ready: Loaded ${this.keys.size} keys.`);
            this.isInitialized = true;

        } catch (e) {
            logger.error('KeyManager Critical Init Error:', e);
            // تشغيل وضع الطوارئ
            this._emergencyLoadEnv();
        }
    }

    /**
     * دالة مساعدة لدمج المفتاح بين Env و DB
     */
    _mergeKey(keyStr, defaultNick, provider, dbMap) {
        const existing = dbMap.get(keyStr);
        if (existing) {
            // موجود في الداتابيز، استرجع الإحصائيات
            this._addKeyToMemory(
                keyStr,
                existing.nickname || defaultNick,
                provider,
                0, // Reset fails
                existing.usage_count,
                existing.today_requests_count,
                existing.last_reset_at
            );
            dbMap.delete(keyStr); // إزالة لكي لا يضاف مرة أخرى
        } else {
            // مفتاح جديد في Env غير موجود في DB
            this._registerNewKeyInDb(keyStr, defaultNick, provider);
            this._addKeyToMemory(keyStr, defaultNick, provider);
        }
    }

    /**
     * تسجيل المفتاح في الذاكرة الحية
     */
    _addKeyToMemory(keyStr, nickname, provider, fails = 0, usage = 0, todayCount = 0, lastReset = null) {
        if (this.keys.has(keyStr)) return;

        // منطق تصفير العداد اليومي
        let currentTodayCount = todayCount;
        const now = new Date();
        if (lastReset && new Date(lastReset).toDateString() !== now.toDateString()) {
            currentTodayCount = 0;
        }

        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            provider: provider, // 'google' or 'huggingface'
            client: provider === 'google' ? new GoogleGenerativeAI(keyStr) : null,
            status: fails >= this.MAX_FAILS ? 'dead' : 'idle',
            fails: fails,
            usage: usage,
            todayRequests: currentTodayCount,
            rpdLimit: provider === 'huggingface' ? 5000 : 2000, // HF limits are different
            lastUsed: 0,
            cooldownUntil: 0
        });
    }

    /**
     * 🟢 الدالة الأهم: طلب مفتاح بناءً على المزود
     */
    async acquireKey(providerFilter = 'google') {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                const now = Date.now();

                // 1. تنظيف وفلترة
                const candidates = Array.from(this.keys.values()).filter(k => {
                    // تحرير من التبريد
                    if (k.status === 'cooldown' && now > k.cooldownUntil) {
                        k.status = 'idle';
                    }

                    // الشرط الأساسي
                    return k.provider === providerFilter && 
                           k.status === 'idle' && 
                           k.todayRequests < k.rpdLimit;
                });

                if (candidates.length > 0) {
                    const selected = shuffled(candidates)[0];
                    selected.status = 'busy';
                    selected.lastUsed = now;
                    selected.usage++;
                    selected.todayRequests++;
                    
                    // تحديث قاعدة البيانات في الخلفية
                    this._syncKeyStats(selected.key, {
                        usage_count: selected.usage,
                        today_requests_count: selected.todayRequests,
                        last_reset_at: new Date().toISOString()
                    });

                    resolve(selected);
                } else {
                    resolve(null); // لا يوجد مفتاح متاح
                }
            };
            tryAcquire();
        });
    }

    /**
     * تحرير المفتاح بعد الاستخدام أو الفشل
     */
    releaseKey(keyStr, wasSuccess, errorType = null) {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj) return;

        if (wasSuccess) {
            keyObj.status = 'idle';
            keyObj.fails = 0;
            keyObj.cooldownUntil = 0;
        } else {
            keyObj.fails++;
            
            // تحديد مدة العقوبة
            let penalty = 5000; // 5 ثواني افتراضياً
            if (errorType === '429' || errorType === 'quota') penalty = 60000; // دقيقة
            if (errorType === '503_loading') penalty = 15000; // 15 ثانية

            keyObj.cooldownUntil = Date.now() + penalty;
            keyObj.status = 'cooldown';

            logger.warn(`❌ Key ${keyObj.nickname} (${keyObj.provider}) failed. Penalty: ${penalty/1000}s`);

            if (keyObj.fails >= this.MAX_FAILS) {
                keyObj.status = 'dead';
                logger.error(`💀 Key ${keyObj.nickname} is DEAD.`);
                this._syncKeyStats(keyStr, { status: 'dead', fails_count: keyObj.fails });
            }
        }
    }

    // --- Helper Methods ---

    async _registerNewKeyInDb(keyStr, nickname, provider) {
        try {
            await supabase.from('system_api_keys').insert({
                key_value: keyStr,
                nickname: nickname,
                // تأكد أن قاعدة بياناتك تدعم عمود 'provider' وإلا احذف هذا السطر
                provider: provider, 
                status: 'active',
                created_at: new Date().toISOString()
            });
        } catch (e) { /* Ignore duplicates */ }
    }

    async _syncKeyStats(keyStr, updates) {
        try {
            await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
        } catch (e) { /* ignore */ }
    }

    _emergencyLoadEnv() {
        if (process.env.GOOGLE_API_KEY) this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key', 'google');
        for (let i = 1; i <= 5; i++) {
            const k = process.env[`HUGGINGFACE_API_KEY_${i}`];
            if (k) this._addKeyToMemory(k, `HF_${i}`, 'huggingface');
        }
    }

    _dailyResetCheck() {
        const now = new Date();
        if (this.lastResetDay !== now.getDate() && now.getHours() >= 8) {
            logger.info('🌅 Daily Reset: Resetting Key Quotas...');
            this.keys.forEach(k => {
                k.todayRequests = 0;
                if (k.status === 'dead') k.status = 'idle';
                k.fails = 0;
            });
            this.lastResetDay = now.getDate();
        }
    }
    
    getKeyCount() {
        return this.keys.size;
    }
}

const instance = new KeyManager();
module.exports = instance;
