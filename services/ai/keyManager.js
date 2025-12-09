// services/ai/keyManager.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { shuffled, sleep } = require('../../utils');

class KeyManager {
  constructor() {
    this.keys = new Map(); // التخزين في الذاكرة: { keyString: { client, status, fails, usage, ... } }
    this.queue = []; // طابور الانتظار للطلبات
    this.MAX_FAILS = 4;
    this.isInitialized = false;
  }

  // 1. التهيئة: سحب المفاتيح من البيئة + قاعدة البيانات
  async init() {
    if (this.isInitialized) return;

    // أ) سحب من Env Variables (GOOGLE_API_KEY_1 ... 20)
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GOOGLE_API_KEY_${i}`];
      if (key) this._addKeyToMemory(key, `Env_Key_${i}`);
    }
    // المفتاح الرئيسي
    if (process.env.GOOGLE_API_KEY) this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key');

    // ب) سحب من Supabase
    try {
      const { data } = await supabase.from('system_api_keys').select('*').eq('status', 'active');
      if (data) {
        data.forEach(row => this._addKeyToMemory(row.key_value, row.nickname, row.fails_count, row.usage_count));
      }
    } catch (e) {
      logger.error('KeyManager DB Load Error:', e.message);
    }

    logger.success(`🔑 KeyManager Initialized. Loaded ${this.keys.size} keys.`);
    this.isInitialized = true;
  }

  _addKeyToMemory(keyStr, nickname = 'Unknown', fails = 0, usage = 0) {
    if (this.keys.has(keyStr)) return;
    
    // Lazy Import لتجنب المشاكل الدائرية
    const { GoogleGenerativeAI } = require('@google/generative-ai'); 
    
    this.keys.set(keyStr, {
      key: keyStr,
      nickname,
      client: new GoogleGenerativeAI(keyStr),
      status: fails >= this.MAX_FAILS ? 'dead' : 'idle', // idle, busy, dead, cooldown
      fails: fails,
      usage: usage,
      lastUsed: null
    });
  }

  // 2. طلب مفتاح (Check-Out)
  async acquireKey() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        // فلترة المفاتيح المتاحة (active & idle)
        const available = Array.from(this.keys.values()).filter(k => k.status === 'idle');

        if (available.length > 0) {
          // خوارزمية الاختيار: عشوائي لكن يفضل الأقل فشلاً
          const selected = shuffled(available)[0];
          
          selected.status = 'busy'; // حجز المفتاح
          selected.lastUsed = Date.now();
          selected.usage++;
          
          // تحديث العداد في الخلفية (اختياري لتقليل الضغط على DB)
          this._syncKeyStats(selected.key, { usage_count: selected.usage });
          
          resolve(selected);
        } else {
          // الكل مشغول أو ميت -> طابور الانتظار
          logger.warn('⚠️ All keys are busy or dead. Request queued...');
          this.queue.push(tryAcquire);
        }
      };

      tryAcquire();
    });
  }

  // 3. إرجاع المفتاح (Check-In)
  releaseKey(keyStr, wasSuccess = true, errorType = null) {
    const keyObj = this.keys.get(keyStr);
    if (!keyObj) return;

    if (wasSuccess) {
      keyObj.status = 'idle';
      keyObj.fails = 0; // تصفير الفشل عند النجاح (رحمة)
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

    // تفقد الطابور: هل يوجد أحد ينتظر؟
    this._processQueue();
  }

  _processQueue() {
    if (this.queue.length > 0) {
      // هل يوجد مفتاح متاح الآن؟
      const hasIdle = Array.from(this.keys.values()).some(k => k.status === 'idle');
      if (hasIdle) {
        const nextRequest = this.queue.shift(); // FIFO
        if (nextRequest) nextRequest();
      }
    }
  }

  async _syncKeyStats(keyStr, updates) {
     // تحديث قاعدة البيانات في الخلفية
     // نبحث أولاً إذا كان المفتاح موجود في DB، إذا لا نضيفه، إذا نعم نحدثه
     // للسرعة، سنفترض أنه موجود أو نتجاهل الخطأ
     try {
       const { error } = await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
       if (error) {
         // ربما المفتاح من .env وغير موجود في DB، يمكننا إضافته
         // await supabase.from('system_api_keys').insert({ key_value: keyStr, ...updates });
       }
     } catch (e) { /* ignore background errors */ }
  }

  // --- دوال Admin ---

  getAllKeysStatus() {
    return Array.from(this.keys.values()).map(k => ({
      key: k.key.substring(0, 8) + '...', // Masked
      fullKey: k.key, // للأدمين فقط
      nickname: k.nickname,
      status: k.status,
      fails: k.fails,
      usage: k.usage,
      lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : 'Never'
    }));
  }

  async addKey(keyStr, nickname) {
    if (this.keys.has(keyStr)) return { success: false, msg: 'Duplicate' };
    
    // Add to DB
    await supabase.from('system_api_keys').insert({ key_value: keyStr, nickname, status: 'active' });
    // Add to Memory
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
      if(k) {
          k.status = 'idle';
          k.fails = 0;
          return { success: true };
      }
      return { success: false };
  }
}

// Singleton Pattern
const instance = new KeyManager();
module.exports = instance;
