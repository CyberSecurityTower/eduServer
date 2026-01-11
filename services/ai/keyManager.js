
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeniusKeyManager {
    constructor() {
        this.keys = new Map();
        this.isInitialized = false;
        
        // إعدادات الذكاء
        this.CONFIG = {
            MAX_SCORE: 100,           // الصحة الكاملة
            MIN_SCORE_TO_USE: 40,     // أقل صحة مسموح بها للاستخدام
            PENALTY_429: 50,          // عقوبة انتهاء الكوتا (قوية جداً)
            PENALTY_ERROR: 20,        // عقوبة خطأ غير معروف
            REWARD_SUCCESS: 5,        // مكافأة النجاح
            CircuitBreakerThreshold: 2 // عدد الأخطاء المتتالية قبل العزل
        };

        // عملية إنعاش دورية (كل 30 ثانية) لرفع صحة المفاتيح المعزولة تدريجياً
        setInterval(() => this._healKeys(), 30 * 1000);
    }

    async init() {
        if (this.isInitialized) return;
        logger.info('🧠 KeyManager: Initializing Hive-Mind Protocol...');

        try {
            // تحميل المفاتيح (كما في الكود السابق)
            const { data: dbKeys } = await supabase.from('system_api_keys').select('*').eq('status', 'active');
            const dbKeyMap = new Map();
            if (dbKeys) dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));

            if (process.env.GOOGLE_API_KEY) this._mergeKey(process.env.GOOGLE_API_KEY, 'Master_Key', dbKeyMap);
            for (let i = 1; i <= 20; i++) {
                const k = process.env[`GOOGLE_API_KEY_${i}`];
                if (k) this._mergeKey(k, `Google_Node_${i}`, dbKeyMap);
            }

            // إضافة المفاتيح المتبقية
            for (const [keyStr, row] of dbKeyMap.entries()) {
                if (!row.provider || row.provider === 'google') {
                    this._addKeyToMemory(keyStr, row.nickname, row.usage_count);
                }
            }

            logger.success(`🧠 Hive-Mind Ready: Monitoring ${this.keys.size} Neural Nodes (Keys).`);
            this.isInitialized = true;
        } catch (e) {
            logger.error('Critical Init Error:', e);
            this._emergencyLoadEnv();
        }
    }

    _mergeKey(keyStr, nick, map) {
        const existing = map.get(keyStr);
        this._addKeyToMemory(keyStr, existing?.nickname || nick, existing?.usage_count || 0);
        map.delete(keyStr);
    }

    _addKeyToMemory(keyStr, nickname, usage = 0) {
        if (this.keys.has(keyStr)) return;
        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            client: new GoogleGenerativeAI(keyStr),
            
            // --- الذكاء الجديد ---
            health: 100,               // الصحة (0-100)
            consecutiveErrors: 0,      // الأخطاء المتتالية الحالية
            totalUsage: usage,
            avgLatency: 0,             // متوسط سرعة الاستجابة
            
            status: 'active',          // active, cooldown, dead
            cooldownUntil: 0,          // متى ينتهي العزل؟
            banLevel: 0                // مستوى العقاب (0, 1, 2...)
        });
    }

    /**
     * 🟢 طلب أذكى مفتاح متاح
     * الخوارزمية:
     * 1. استبعاد المفاتيح المعزولة (Cooldown) والميتة.
     * 2. الترتيب حسب الصحة (Health) تنازلياً.
     * 3. إذا تساوت الصحة، نختار الأقل استخداماً أو الأسرع.
     */
    async acquireKey() {
        const now = Date.now();
        
        // 1. الفلترة
        let candidates = Array.from(this.keys.values()).filter(k => {
            // تحرير تلقائي إذا انتهى وقت العزل
            if (k.status === 'cooldown' && now > k.cooldownUntil) {
                k.status = 'active';
                k.health = 50; // يعود بصحة متوسطة (تحت الاختبار)
                k.consecutiveErrors = 0;
            }
            return k.status === 'active' && k.health >= this.CONFIG.MIN_SCORE_TO_USE;
        });

        // إذا لم نجد مفاتيح "صحية"، نبحث عن "أي شيء حي" (Desperation Mode)
        if (candidates.length === 0) {
            candidates = Array.from(this.keys.values()).filter(k => k.status !== 'dead');
            if (candidates.length === 0) return null; // النظام ميت تماماً
        }

        // 2. الفرز الذكي (Smart Sorting)
        // نفضل: الصحة العالية > أخطاء متتالية أقل > وقت استجابة أسرع
        candidates.sort((a, b) => {
            if (b.health !== a.health) return b.health - a.health; // الأصح أولاً
            return a.consecutiveErrors - b.consecutiveErrors; // الأقل أخطاءً ثانياً
        });

        // 3. الاختيار (Load Balancing)
        // نأخذ أفضل 3 مفاتيح ونختار عشوائياً بينهم لتوزيع الحمل
        const topCandidates = candidates.slice(0, 3);
        const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];

        selected.startTime = now; // لتتبع سرعة الاستجابة لاحقاً
        return selected;
    }

    /**
     * 🔴 تقرير النتيجة (هنا يحدث التعلم)
     * @param {string} keyStr - المفتاح
     * @param {boolean} success - هل نجح؟
     * @param {string} errorType - نوع الخطأ (429, 500...)
     */
    reportResult(keyStr, success, errorType = null) {
        const k = this.keys.get(keyStr);
        if (!k) return;

        if (success) {
            // ✅ مكافأة النجاح
            k.health = Math.min(this.CONFIG.MAX_SCORE, k.health + this.CONFIG.REWARD_SUCCESS);
            k.consecutiveErrors = 0;
            k.banLevel = Math.max(0, k.banLevel - 1); // تقليل مستوى العقاب
            k.totalUsage++;
            
            // حساب سرعة الاستجابة (Moving Average)
            const latency = Date.now() - (k.startTime || Date.now());
            k.avgLatency = k.avgLatency === 0 ? latency : (k.avgLatency * 0.8 + latency * 0.2);

        } else {
            // ❌ معاقبة الفشل
            k.consecutiveErrors++;
            
            let damage = this.CONFIG.PENALTY_ERROR;
            let banDuration = 0;

            if (errorType === '429' || errorType === 'quota') {
                damage = this.CONFIG.PENALTY_429;
                // عقاب تصاعدي: الدقيقة الأولى، ثم 5، ثم 30...
                banDuration = 60 * 1000 * Math.pow(5, k.banLevel); 
                k.banLevel = Math.min(3, k.banLevel + 1); // أقصى مستوى 3
                logger.warn(`🚫 Key ${k.nickname} Rate Limited! Banned for ${banDuration/1000}s (Level ${k.banLevel})`);
            } else {
                // أخطاء أخرى (500, network)
                if (k.consecutiveErrors >= this.CONFIG.CircuitBreakerThreshold) {
                    banDuration = 30 * 1000; // عزل قصير (30 ثانية) للمراجعة
                    logger.warn(`⚠️ Key ${k.nickname} unstable. Paused for 30s.`);
                }
            }

            k.health = Math.max(0, k.health - damage);

            // تطبيق العزل
            if (banDuration > 0 || k.health < this.CONFIG.MIN_SCORE_TO_USE) {
                k.status = 'cooldown';
                k.cooldownUntil = Date.now() + (banDuration || 60000);
            }

            if (k.health === 0 && k.banLevel >= 3) {
                k.status = 'dead'; // الموت الرحيم
                logger.error(`💀 Key ${k.nickname} pronounced DEAD.`);
            }
        }
        
        // تحديث قاعدة البيانات بشكل غير متزامن (Fire & Forget)
        this._syncDb(k);
    }

    _healKeys() {
        // "الشفاء الطبيعي": زيادة صحة المفاتيح الخاملة قليلاً لتعطى فرصة أخرى
        const now = Date.now();
        this.keys.forEach(k => {
            if (k.status !== 'dead' && k.health < 100) {
                // إذا لم يُستخدم منذ دقيقتين، ارفع صحته قليلاً
                if (now - k.startTime > 120 * 1000) {
                    k.health = Math.min(100, k.health + 5);
                }
            }
        });
    }

    async _syncDb(k) {
        try {
            await supabase.from('system_api_keys').update({
                usage_count: k.totalUsage,
                // يمكنك إضافة عمود 'health' في الداتابيز لمراقبة الأداء
                status: k.status === 'dead' ? 'dead' : 'active' 
            }).eq('key_value', k.key);
        } catch(e) {}
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

const instance = new GeniusKeyManager();
module.exports = instance;
