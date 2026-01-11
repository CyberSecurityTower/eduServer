'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { shuffled } = require('../../utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class KeyManager {
    constructor() {
        this.keys = new Map();
        this.MAX_FAILS = 4;
        this.isInitialized = false;
        
        this.lastResetDay = new Date().getDate(); 
        
        // فحص يومي لتصفير العدادات
        setInterval(() => this._dailyResetCheck(), 60 * 1000);
    }

    /**
     * تهيئة النظام: تحميل مفاتيح Google فقط
     */
    async init() {
        if (this.isInitialized) return;
        logger.info('🔑 KeyManager: Initializing Google-Only Mode...');

        try {
            // 1. جلب المفاتيح من قاعدة البيانات
            const { data: dbKeys, error } = await supabase.from('system_api_keys').select('*').eq('status', 'active');
            if (error) logger.warn(`KeyManager DB Notice: ${error.message}`);

            const dbKeyMap = new Map();
            if (dbKeys) dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));

            // 2. تجميع مفاتيح Google من Env (الأساسي + الإضافية)
            if (process.env.GOOGLE_API_KEY) this._mergeKey(process.env.GOOGLE_API_KEY, 'Google_Master', dbKeyMap);
            
            // تحميل حتى 20 مفتاح إضافي من الـ ENV
            for (let i = 1; i <= 20; i++) {
                const k = process.env[`GOOGLE_API_KEY_${i}`];
                if (k) this._mergeKey(k, `Google_${i}`, dbKeyMap);
            }

            // 3. إضافة المفاتيح المتبقية في الداتابيز (التي لم تكن في Env)
            for (const [keyStr, row] of dbKeyMap.entries()) {
                // نقبل فقط مفاتيح جوجل (أو التي لم يحدد نوعها نفترض أنها جوجل)
                if (!row.provider || row.provider === 'google') {
                    this._addKeyToMemory(
                        keyStr,
                        row.nickname || 'DB_Key',
                        0,
                        row.usage_count,
                        row.today_requests_count,
                        row.last_reset_at
                    );
                }
            }

            logger.success(`🧠 KeyManager Ready: Loaded ${this.keys.size} Google Keys.`);
            this.isInitialized = true;

        } catch (e) {
            logger.error('KeyManager Critical Init Error:', e);
            this._emergencyLoadEnv();
        }
    }

    _mergeKey(keyStr, defaultNick, dbMap) {
        const existing = dbMap.get(keyStr);
        if (existing) {
            this._addKeyToMemory(
                keyStr,
                existing.nickname || defaultNick,
                0,
                existing.usage_count,
                existing.today_requests_count,
                existing.last_reset_at
            );
            dbMap.delete(keyStr);
        } else {
            this._registerNewKeyInDb(keyStr, defaultNick);
            this._addKeyToMemory(keyStr, defaultNick);
        }
    }

    _addKeyToMemory(keyStr, nickname, fails = 0, usage = 0, todayCount = 0, lastReset = null) {
        if (this.keys.has(keyStr)) return;

        let currentTodayCount = todayCount;
        const now = new Date();
        if (lastReset && new Date(lastReset).toDateString() !== now.toDateString()) {
            currentTodayCount = 0;
        }

        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            provider: 'google',
            client: new GoogleGenerativeAI(keyStr),
            status: fails >= this.MAX_FAILS ? 'dead' : 'idle',
            fails: fails,
            usage: usage,
            todayRequests: currentTodayCount,
            rpdLimit: 2000, // حد جوجل التقريبي المجاني
            lastUsed: 0,
            cooldownUntil: 0
        });
    }

    /**
     * طلب مفتاح (دائماً جوجل الآن)
     */
    async acquireKey() {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                const now = Date.now();

                // فلترة المفاتيح المتاحة
                const candidates = Array.from(this.keys.values()).filter(k => {
                    if (k.status === 'cooldown' && now > k.cooldownUntil) {
                        k.status = 'idle';
                    }
                    return k.status === 'idle' && k.todayRequests < k.rpdLimit;
                });

                if (candidates.length > 0) {
                    // اختيار عشوائي لتوزيع الحمل
                    const selected = shuffled(candidates)[0];
                    selected.status = 'busy';
                    selected.lastUsed = now;
                    selected.usage++;
                    selected.todayRequests++;
                    
                    // تحديث غير متزامن للقاعدة
                    this._syncKeyStats(selected.key, {
                        usage_count: selected.usage,
                        today_requests_count: selected.todayRequests,
                        last_reset_at: new Date().toISOString()
                    });

                    resolve(selected);
                } else {
                    resolve(null);
                }
            };
            tryAcquire();
        });
    }

    releaseKey(keyStr, wasSuccess, errorType = null) {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj) return;

        if (wasSuccess) {
            keyObj.status = 'idle';
            keyObj.fails = 0;
            keyObj.cooldownUntil = 0;
        } else {
            keyObj.fails++;
            
            // عقوبات زمنية
            let penalty = 2000; // ثانيتين
            if (errorType === '429') penalty = 60000; // دقيقة كاملة في حال انتهاء الكوتا

            keyObj.cooldownUntil = Date.now() + penalty;
            keyObj.status = 'cooldown';

            logger.warn(`❌ Key ${keyObj.nickname} failed (${errorType}). Penalty: ${penalty/1000}s`);

            if (keyObj.fails >= this.MAX_FAILS) {
                keyObj.status = 'dead';
                logger.error(`💀 Key ${keyObj.nickname} is DEAD.`);
                this._syncKeyStats(keyStr, { status: 'dead', fails_count: keyObj.fails });
            }
        }
    }

    async _registerNewKeyInDb(keyStr, nickname) {
        try {
            await supabase.from('system_api_keys').insert({
                key_value: keyStr,
                nickname: nickname,
                provider: 'google',
                status: 'active',
                created_at: new Date().toISOString()
            });
        } catch (e) { }
    }

    async _syncKeyStats(keyStr, updates) {
        try {
            await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
        } catch (e) { }
    }

    _emergencyLoadEnv() {
        if (process.env.GOOGLE_API_KEY) this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key');
    }

    _dailyResetCheck() {
        const now = new Date();
        if (this.lastResetDay !== now.getDate() && now.getHours() >= 8) {
            logger.info('🌅 Daily Reset: Resetting Google Key Quotas...');
            this.keys.forEach(k => {
                k.todayRequests = 0;
                if (k.status === 'dead') k.status = 'idle';
                k.fails = 0;
            });
            this.lastResetDay = now.getDate();
        }
    }
    
    getKeyCount() { return this.keys.size; }
    getAllKeysStatus() { return Array.from(this.keys.values()); }
}

const instance = new KeyManager();
module.exports = instance;
