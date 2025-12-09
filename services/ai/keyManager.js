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

    // 1. مفاتيح Render (تعمل دائماً للتجربة)
    // هذه المفاتيح ستكون هي "الجيش الأول" حالياً
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GOOGLE_API_KEY_${i}`];
      if (key) this._addKeyToMemory(key, `Env_Key_${i}`, 0, 0, 0, 0, 0, null, 'active');
    }
    if (process.env.GOOGLE_API_KEY) {
        this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key', 0, 0, 0, 0, 0, null, 'active');
    }

    // 2. مفاتيح Supabase (نجلب فقط النشطة!)
    try {
      // 👇 التعديل هنا: eq('status', 'active')
      const { data } = await supabase
          .from('system_api_keys')
          .select('*')
          .eq('status', 'active'); 

      if (data) {
        data.forEach(row => this._addKeyToMemory(
            row.key_value, 
            row.nickname, 
            row.fails_count, 
            row.usage_count,
            row.total_input_tokens,
            row.total_output_tokens,
            row.today_requests_count,
            row.last_reset_at
        ));
      }
    } catch (e) {
      logger.error('KeyManager DB Load Error:', e.message);
    }

    logger.success(`🔑 KeyManager Initialized. Loaded ${this.keys.size} active keys.`);
    this.isInitialized = true;
}

_addKeyToMemory(keyStr, nickname = 'Unknown', fails = 0, usage = 0, inputTokens = 0, outputTokens = 0, todayCount = 0, lastReset = null) {
    if (this.keys.has(keyStr)) return;
    
    const { GoogleGenerativeAI } = require('@google/generative-ai'); 
    
    // منطق تصفير العداد اليومي
    let currentTodayCount = todayCount;
    const now = new Date();
    const lastResetDate = lastReset ? new Date(lastReset) : new Date();
    
    // إذا مر يوم مختلف، نصفر العداد
    if (lastResetDate.getDate() !== now.getDate()) {
        currentTodayCount = 0;
        // (ملاحظة: التحديث في الداتابيز سيتم عند أول استخدام)
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
      // 👇 الإضافات الجديدة
      todayRequests: currentTodayCount,
      rpdLimit: 20, // القيمة الافتراضية حسب الصورة
      rpmLimit: 5,
      lastUsed: null
    });
}
  // 2. طلب مفتاح (Check-Out)
  async acquireKey() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        // 1. تصفية المفاتيح المتاحة (Idle)
        // 2. شرط إضافي: لم تتجاوز الحد اليومي (20)
        const available = Array.from(this.keys.values()).filter(k => {
            return k.status === 'idle' && k.todayRequests < k.rpdLimit;
        });

        if (available.length > 0) {
          // اختيار عشوائي لتوزيع الحمل
          const selected = shuffled(available)[0];
          
          selected.status = 'busy';
          selected.lastUsed = Date.now();
          selected.usage++;
          selected.todayRequests++; // زيادة العداد اليومي

          // تحديث الداتابيز (عداد الاستخدام الكلي + اليومي)
          this._syncKeyStats(selected.key, { 
              usage_count: selected.usage,
              today_requests_count: selected.todayRequests,
              last_reset_at: new Date().toISOString()
          });
          
          resolve(selected);
        } else {
          // إذا نفدت كل المفاتيح لليوم
          logger.warn('⚠️ All keys reached daily limit or are busy!');
          
          // هنا يمكننا عمل Fallback لموديل آخر (مثلاً 1.5 Flash) إذا أردت
          // حالياً سنضعه في الطابور
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

  // 👇 دالة جديدة لتسجيل الاستهلاك
  async recordUsage(keyStr, usageMetadata, userId = null, modelName = 'unknown') {
    const keyObj = this.keys.get(keyStr);
    if (!keyObj || !usageMetadata) return;

    const input = usageMetadata.promptTokenCount || 0;
    const output = usageMetadata.candidatesTokenCount || 0;

    // 1. تحديث الذاكرة (RAM)
    keyObj.inputTokens += input;
    keyObj.outputTokens += output;

    // 2. تحديث قاعدة البيانات (Fire and Forget)
    // نستخدم rpc لزيادة العدادات بشكل آمن (Atomic Increment)
    // أو تحديث مباشر إذا لم يكن الضغط عالياً جداً
    try {
        // تحديث جدول المفاتيح
        await supabase.rpc('increment_key_usage', { 
            key_val: keyStr, 
            inc_input: input, 
            inc_output: output 
        });

        // (اختياري) تسجيل في جدول السجلات
        await supabase.from('ai_usage_logs').insert({
            user_id: userId, // يمكن تمريره لاحقاً
            model_name: modelName,
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
            key_nickname: keyObj.nickname
        });

    } catch (e) {
        console.error('Failed to log tokens:', e.message);
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
