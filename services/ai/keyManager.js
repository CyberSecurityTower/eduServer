// services/ai/keyManager.js
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
        
        // 🔥 الذاكرة الجماعية للفشل (Global Cooldown Memory)
        // تخزن متى ينتهي عقاب المفتاح. إذا كان الوقت الحالي < الوقت المخزن، المفتاح محظور
        this.globalCooldowns = new Map(); 

        this.lastResetDay = new Date().getDate(); 
        setInterval(() => this._dailyResetCheck(), 60 * 1000);
    }

    async init() {
        if (this.isInitialized) return;
        logger.info('🔑 KeyManager: Loading Genius Mode (Google + HF)...');

        // 1. تحميل مفاتيح Google
        if (process.env.GOOGLE_API_KEY) this._addKey(process.env.GOOGLE_API_KEY, 'Google_Master', 'google');
        for (let i = 1; i <= 20; i++) {
            const k = process.env[`GOOGLE_API_KEY_${i}`];
            if (k) this._addKey(k, `Google_${i}`, 'google');
        }

        // 2. تحميل مفاتيح Hugging Face (الثلاثة)
        for (let i = 1; i <= 5; i++) {
            const k = process.env[`HUGGINGFACE_API_KEY_${i}`];
            if (k) this._addKey(k, `HF_Key_${i}`, 'huggingface');
        }

        logger.success(`🧠 KeyManager Ready: ${this.keys.size} keys loaded.`);
        this.isInitialized = true;
    }

    _addKey(keyStr, nickname, provider) {
        if (this.keys.has(keyStr)) return;

        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            provider, // 'google' or 'huggingface'
            client: provider === 'google' ? new GoogleGenerativeAI(keyStr) : null,
            status: 'idle',
            fails: 0,
            usage: 0,
            cooldownUntil: 0 // 🕒 وقت فك الحظر (timestamp)
        });
    }

    /**
     * ✅ الدالة الذكية: تعطي مفتاحاً صالحاً فقط وتتجاهل المحروقين عالمياً
     */
    async acquireKey(providerFilter = 'google') {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                const now = Date.now();

                // 1. تنظيف تلقائي: تحرير المفاتيح التي انتهى وقت عقابها
                this.keys.forEach(k => {
                    if (k.cooldownUntil > 0 && now > k.cooldownUntil) {
                        k.status = 'idle';
                        k.cooldownUntil = 0;
                        // logger.log(`♻️ Key ${k.nickname} is back from penalty box!`);
                    }
                });

                // 2. الفلترة الذكية
                const candidates = Array.from(this.keys.values()).filter(k => {
                    return k.provider === providerFilter && // المزود المطلوب
                           k.status === 'idle' &&           // غير مشغول حالياً
                           k.cooldownUntil <= now;          // غير معاقب عالمياً
                });

                if (candidates.length > 0) {
                    const selected = shuffled(candidates)[0];
                    selected.status = 'busy';
                    selected.lastUsed = now;
                    selected.usage++;
                    resolve(selected);
                } else {
                    // إذا لم نجد مفتاحاً صالحاً، نرجع null (ليدير Orchestrator الأمر)
                    resolve(null); 
                }
            };
            tryAcquire();
        });
    }

    /**
     * ✅ تحرير المفتاح مع معاقبته إذا فشل
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
            
            // 🔥 نظام العقوبات الذكي
            let penaltyDuration = 0;

            if (errorType === '429' || errorType === 'quota') {
                // عقوبة قاسية: دقيقة كاملة (لأن جوجل يطلب ذلك)
                penaltyDuration = 60 * 1000; 
                logger.warn(`❄️ FREEZING ${keyObj.nickname} for 60s (Quota/Rate Limit).`);
            } else if (errorType === '503_loading') {
                // عقوبة بسيطة: 10 ثواني (HF Model Loading)
                penaltyDuration = 10 * 1000;
            } else {
                // خطأ غير معروف: 5 ثواني
                penaltyDuration = 5 * 1000;
            }

            keyObj.cooldownUntil = Date.now() + penaltyDuration;
            keyObj.status = 'cooldown'; // نغير الحالة لكي لا يختاره acquireKey

            if (keyObj.fails >= this.MAX_FAILS * 2) {
                keyObj.status = 'dead';
                logger.error(`💀 Key ${keyObj.nickname} is DEAD.`);
            }
        }
    }

    // ✅ الدالة الجديدة: فحص الوقت وتصفير العدادات
    _dailyResetCheck() {
        const now = new Date();
        // تعديل التوقيت ليكون بتوقيت الجزائر (أو السيرفر)
        const currentHour = now.getHours();
        const currentDay = now.getDate();

        // الشرط: إذا تغير اليوم، والساعة الآن 8 أو أكثر
        if (this.lastResetDay !== currentDay && currentHour >= 8) {
            logger.info('🌅 8:00 AM Trigger: Resetting all API Key quotas...');
            
            this.keys.forEach(keyObj => {
                keyObj.todayRequests = 0;
                keyObj.usage = 0; 
                // 🔥 إنعاش المفاتيح الميتة
                if (keyObj.status === 'dead' || keyObj.status === 'busy') {
                    keyObj.status = 'idle';
                    keyObj.fails = 0;
                }
                // تحديث التاريخ
                keyObj.lastReset = now.toISOString();
            });

            this.lastResetDay = currentDay;
            
            // مزامنة سريعة مع الداتابايز (Fire & Forget)
            supabase.from('system_api_keys')
                .update({ today_requests_count: 0, status: 'active', fails_count: 0 })
                .neq('status', 'reserved') 
                .then();
                
            logger.success('✅ All Keys Revived & Quotas Reset!');
        }
    }

    // ============================================================
    // 1. Smart Initialization
    // ============================================================
    async init() {
        if (this.isInitialized) return;
        logger.info('🔑 KeyManager: Initializing & Syncing with DB...');

        try {
            // A. Fetch all keys from Database first
            const { data: dbKeys, error } = await supabase
                .from('system_api_keys')
                .select('*');

            if (error) logger.error(`KeyManager DB Load Error: ${error.message}`);

            // Convert DB array to Map for faster lookup
            const dbKeyMap = new Map();
            if (dbKeys) {
                dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));
            }

            // B. Prepare Environment Keys
            const envKeys = [];
            // Master Key
            if (process.env.GOOGLE_API_KEY) {
                envKeys.push({ key: process.env.GOOGLE_API_KEY, nick: 'Master_Key' });
            }
            // Loop for numbered keys (GOOGLE_API_KEY_1 to GOOGLE_API_KEY_20)
            for (let i = 1; i <= 20; i++) {
                const k = process.env[`GOOGLE_API_KEY_${i}`];
                if (k) envKeys.push({ key: k, nick: `Env_Key_${i}` });
            }

            // C. Smart Merge Logic
            for (const envK of envKeys) {
                const existing = dbKeyMap.get(envK.key);

                if (existing) {
                    // ✅ Case 1: Key exists in DB -> Restore stats
                    this._addKeyToMemory(
                        existing.key_value,
                        existing.nickname || envK.nick,
                        existing.fails_count,
                        existing.usage_count,
                        existing.total_input_tokens,
                        existing.total_output_tokens,
                        existing.today_requests_count,
                        existing.last_reset_at
                    );
                    // Remove from map to avoid duplication in step D
                    dbKeyMap.delete(envK.key);
                } else {
                    // 🆕 Case 2: New key in .env not in DB -> Register it
                    await this._registerNewKeyInDb(envK.key, envK.nick);
                    this._addKeyToMemory(envK.key, envK.nick); 
                }
            }

            // D. Add keys that are ONLY in DB
           // D. Add keys that are ONLY in DB
            for (const [keyStr, row] of dbKeyMap.entries()) {
                // 👇 التغيير: نحمل المفتاح مهما كانت حالته، ونعطيه فرصة جديدة
                // نمرر fails=0 لنعتبره نشطاً في الذاكرة
                this._addKeyToMemory(
                    row.key_value,
                    row.nickname,
                    0, // fails = 0 (Force Reset in Memory)
                    row.usage_count,
                    row.total_input_tokens,
                    row.total_output_tokens,
                    row.today_requests_count,
                    row.last_reset_at
                );
            }
            logger.success(`🔑 KeyManager Initialized. Loaded ${this.keys.size} keys (Stats Restored).`);
            this.isInitialized = true;

        } catch (e) {
            logger.error('KeyManager Critical Init Error:', e);
            this._emergencyLoadEnv();
        }
    }

    // Helper to register new key in DB
    async _registerNewKeyInDb(keyStr, nickname) {
        try {
            await supabase.from('system_api_keys').insert({
                key_value: keyStr,
                nickname: nickname,
                status: 'active',
                created_at: new Date().toISOString()
            });
        } catch (e) {
            // Ignore if key already exists
        }
    }

    // Emergency Mode (If DB is down)
    _emergencyLoadEnv() {
        logger.warn('⚠️ KeyManager: Running in Emergency Mode (Env Only, No Stats).');
        if (process.env.GOOGLE_API_KEY) {
            this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key');
        }
        for (let i = 1; i <= 20; i++) {
            const k = process.env[`GOOGLE_API_KEY_${i}`];
            if (k) this._addKeyToMemory(k, `Env_Key_${i}`);
        }
    }

    _addKeyToMemory(keyStr, nickname = 'Unknown', fails = 0, usage = 0, inputTokens = 0, outputTokens = 0, todayCount = 0, lastReset = null) {
        if (this.keys.has(keyStr)) return;

        // Daily Reset Logic
        let currentTodayCount = todayCount;
        const now = new Date();
        const lastResetDate = lastReset ? new Date(lastReset) : new Date();

        if (lastReset && lastResetDate.toDateString() !== now.toDateString()) {
            currentTodayCount = 0;
        }

        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            client: new GoogleGenerativeAI(keyStr),
            status: fails >= this.MAX_FAILS ? 'dead' : 'idle',
            fails: fails,
            usage: usage,
            inputTokens: inputTokens || 0,
            outputTokens: outputTokens || 0,
            todayRequests: todayCount,
            rpdLimit: 2000, 
            lastUsed: null,
            lastReset: lastReset
        });
    }

    // ============================================================
    // 2. Acquire Key
    // ============================================================
    async acquireKey() {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                // 1. تنظيف سريع
                const now = Date.now();
                this.keys.forEach(k => {
                    if (k.status === 'busy' && (now - k.lastUsed > 60000)) {
                        k.status = 'idle';
                    }
                });

                // 2. الفلترة
                const available = Array.from(this.keys.values()).filter(k => {
                    return k.status === 'idle' && k.todayRequests < k.rpdLimit;
                });

                if (available.length > 0) {
                    const selected = shuffled(available)[0];

                    selected.status = 'busy';
                    selected.lastUsed = Date.now();
                    selected.usage++;
                    selected.todayRequests++;

                    this._syncKeyStats(selected.key, {
                        usage_count: selected.usage,
                        today_requests_count: selected.todayRequests,
                        last_reset_at: new Date().toISOString()
                    });

                    resolve(selected);
               } else {
                    // 🚨 حالة الطوارئ (Desperate Mode)
                    const deadKeys = Array.from(this.keys.values()).filter(k => k.status === 'dead');
                    
                    if (deadKeys.length > 0) {
                        // 👇 التعديل هنا: نختار مفتاحاً عشوائياً من الموتى (وليس الأول دائماً)
                        const zombie = deadKeys[Math.floor(Math.random() * deadKeys.length)];
                        
                        logger.warn(`🧟 Desperate Mode: Reviving zombie key ${zombie.nickname} in 5s...`);
                        
                        // 👇 الحل الجذري: تأخير إجباري لمدة 5 ثواني قبل تسليم المفتاح الميت
                        // هذا يمنع الـ Loop السريع الذي رأيته في اللوجات
                        setTimeout(() => {
                            zombie.status = 'busy'; 
                            resolve(zombie);
                        }, 5000); 

                    } else {
                        logger.warn('⚠️ Queueing request (System saturated)...');
                        this.queue.push(tryAcquire);
                    }
                }
            };

            tryAcquire();
        });
    }

    // ============================================================
    // 3. Release Key
    // ============================================================
    releaseKey(keyStr, wasSuccess = true, errorType = null) {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj) return;

        if (wasSuccess) {
            keyObj.status = 'idle';
            keyObj.fails = 0; 
        } else {
            keyObj.fails++;
            logger.warn(`❌ Key ${keyObj.nickname} failed (${keyObj.fails}/${this.MAX_FAILS}). Error: ${errorType}`);

            if (keyObj.fails >= this.MAX_FAILS) {
                keyObj.status = 'dead';
                logger.error(`💀 Key ${keyObj.nickname} is now DEAD.`);
                this._syncKeyStats(keyStr, { status: 'dead', fails_count: keyObj.fails });
            } else if (errorType === '429') {
                keyObj.status = 'cooldown';
                logger.warn(`❄️ Key ${keyObj.nickname} in cooldown for 1 min.`);
                
                setTimeout(() => {
                    if (keyObj.status !== 'dead') keyObj.status = 'idle';
                    this._processQueue();
                }, 60000);
            } else {
                keyObj.status = 'idle';
            }

            this._syncKeyStats(keyStr, { fails_count: keyObj.fails });
        }

        this._processQueue();
    }

    _processQueue() {
        if (this.queue.length > 0) {
            const hasIdle = Array.from(this.keys.values()).some(k => k.status === 'idle');
            if (hasIdle) {
                const nextRequest = this.queue.shift(); 
                if (nextRequest) nextRequest();
            }
        }
    }

    async recordUsage(keyStr, usageMetadata, userId = null, modelName = 'unknown') {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj || !usageMetadata) return;

        const input = usageMetadata.promptTokenCount || 0;
        const output = usageMetadata.candidatesTokenCount || 0;

        keyObj.inputTokens += input;
        keyObj.outputTokens += output;

        try {
            await supabase.rpc('increment_key_usage', {
                key_val: keyStr,
                inc_input: input,
                inc_output: output
            });
        } catch (e) {
            console.error('Failed to log tokens:', e.message);
        }
    }

    async _syncKeyStats(keyStr, updates) {
        try {
            await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
        } catch (e) { /* ignore */ }
    }

    getAllKeysStatus() {
        return Array.from(this.keys.values()).map(k => ({
            key: k.key.substring(0, 8) + '...',
            nickname: k.nickname,
            status: k.status,
            fails: k.fails,
            todayRequests: k.todayRequests,
            limit: k.rpdLimit,
            usage: k.usage,
            lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : 'Never'
        }));
    }

    async addKey(keyStr, nickname) {
        if (this.keys.has(keyStr)) return { success: false, msg: 'Duplicate' };
        await this._registerNewKeyInDb(keyStr, nickname);
        this._addKeyToMemory(keyStr, nickname);
        return { success: true };
    }

    async removeKey(keyStr) {
        this.keys.delete(keyStr);
        await supabase.from('system_api_keys').delete().eq('key_value', keyStr);
        return { success: true };
    }

    async reviveKey(keyStr) {
        const k = this.keys.get(keyStr);
        if (k) {
            k.status = 'idle';
            k.fails = 0;
            this._syncKeyStats(keyStr, { status: 'active', fails_count: 0 });
            return { success: true };
        }
        return { success: false };
    }

    // ✅ تم نقل الدالة لتكون داخل الكلاس
    getKeyCount() {
        return this.keys.size;
    }
} 
const instance = new KeyManager();
module.exports = instance;
