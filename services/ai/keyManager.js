// services/ai/keyManager.js
'use strict';
const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { shuffled, sleep } = require('../../utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');
class KeyManager {
constructor() {
this.keys = new Map(); // التخزين في الذاكرة
this.queue = []; // طابور الانتظار
this.MAX_FAILS = 4;
this.isInitialized = false;
}
async reloadKeys() {
this.isInitialized = false;
this.keys.clear();
await this.init();
}
// ============================================================
// 1. التهيئة الذكية (Smart Init)
// ============================================================
async init() {
if (this.isInitialized) return;
logger.info('🔑 KeyManager: Initializing & Syncing with DB...');
try {
  // أ. جلب كل المفاتيح المسجلة في قاعدة البيانات أولاً
  const { data: dbKeys, error } = await supabase
    .from('system_api_keys')
    .select('*');

  if (error) logger.error('KeyManager DB Load Error:', error.message);

  // تحويل مصفوفة الداتابيز إلى Map لسهولة البحث
  const dbKeyMap = new Map();
  if (dbKeys) {
    dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));
  }

  // ب. تحضير مفاتيح البيئة (Environment Keys)
  const envKeys = [];
  if (process.env.GOOGLE_API_KEY) {
    envKeys.push({ key: process.env.GOOGLE_API_KEY, nick: 'Master_Key' });
  }
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GOOGLE_API_KEY_${i}`];
    if (k) envKeys.push({ key: k, nick: `Env_Key_${i}` });
  }

  // ج. الدمج الذكي (Merge Logic)
  for (const envK of envKeys) {
    const existing = dbKeyMap.get(envK.key);

    if (existing) {
      // ✅ الحالة 1: المفتاح موجود في الداتابيز -> نسترجع إحصائياته (لا نبدأ من الصفر)
      this._addKeyToMemory(
        existing.key_value,
        existing.nickname || envK.nick, // نفضل الاسم المسجل في القاعدة
        existing.fails_count,
        existing.usage_count,
        existing.total_input_tokens,
        existing.total_output_tokens,
        existing.today_requests_count, // 🔥 هنا السر: استرجاع عداد اليوم
        existing.last_reset_at
      );
      // نحذفه من الماب لكي لا نكرره في الخطوة التالية
      dbKeyMap.delete(envK.key);
    } else {
      // 🆕 الحالة 2: مفتاح جديد في .env غير موجود في الداتابيز -> نسجله
      await this._registerNewKeyInDb(envK.key, envK.nick);
      this._addKeyToMemory(envK.key, envK.nick); // يبدأ أصفار
    }
  }

  // د. إضافة المفاتيح الموجودة في الداتابيز فقط (مثل التي أضافها الأدمين يدوياً)
  for (const [keyStr, row] of dbKeyMap.entries()) {
    if (row.status === 'active') {
      this._addKeyToMemory(
        row.key_value,
        row.nickname,
        row.fails_count,
        row.usage_count,
        row.total_input_tokens,
        row.total_output_tokens,
        row.today_requests_count,
        row.last_reset_at
      );
    }
  }

  logger.success(`🔑 KeyManager Initialized. Loaded ${this.keys.size} keys (Stats Restored).`);
  this.isInitialized = true;

} catch (e) {
  logger.error('KeyManager Critical Init Error:', e);
  // Fallback: في حالة فشل الداتابيز تماماً، نحمل مفاتيح البيئة فقط لكي لا يتوقف السيرفر
  this._emergencyLoadEnv();
}

}
// دالة مساعدة لتسجيل مفتاح جديد في القاعدة
async _registerNewKeyInDb(keyStr, nickname) {
try {
await supabase.from('system_api_keys').insert({
key_value: keyStr,
nickname: nickname,
status: 'active',
created_at: new Date().toISOString()
});
} catch (e) {
// نتجاهل الخطأ إذا كان المفتاح موجوداً مسبقاً (Duplicate)
}
}
// دالة الطوارئ (إذا سقطت الداتابيز)
_emergencyLoadEnv() {
logger.warn('⚠️ KeyManager: Running in Emergency Mode (Env Only, No Stats).');
if (process.env.GOOGLE_API_KEY) this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key');
for (let i = 1; i <= 20; i++) {
const k = process.env[GOOGLE_API_KEY_${i}];
if (k) this._addKeyToMemory(k, Env_Key_${i});
}
}
_addKeyToMemory(keyStr, nickname = 'Unknown', fails = 0, usage = 0, inputTokens = 0, outputTokens = 0, todayCount = 0, lastReset = null) {
if (this.keys.has(keyStr)) return;
// منطق تصفير العداد اليومي
let currentTodayCount = todayCount;
const now = new Date();
// نستخدم توقيت الجزائر لضبط "اليوم"
// (اختياري: يمكنك استخدام UTC لتبسيط الأمور، هنا نستخدم التاريخ المحلي للسيرفر)
const lastResetDate = lastReset ? new Date(lastReset) : new Date();

// إذا اختلف اليوم (مثلاً آخر استخدام كان يوم 15 واليوم 16) -> نصفر العداد
if (lastReset && lastResetDate.getDate() !== now.getDate()) {
  currentTodayCount = 0;
  // ملاحظة: التحديث في الداتابيز سيتم عند أول استخدام (lazy update)
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
  todayRequests: currentTodayCount,
  rpdLimit: 20,
  rpmLimit: 5, 
  lastUsed: null
});
  }
// ============================================================
// 2. طلب مفتاح (Check-Out)
// ============================================================
async acquireKey() {
return new Promise((resolve) => {
const tryAcquire = () => {
// 1. تصفية المفاتيح المتاحة (Idle) والتي لم تتجاوز الحد اليومي
const available = Array.from(this.keys.values()).filter(k => {
return k.status === 'idle' && k.todayRequests < k.rpdLimit;
});
if (available.length > 0) {
      // اختيار عشوائي لتوزيع الحمل (Load Balancing)
      const selected = shuffled(available)[0];

      selected.status = 'busy';
      selected.lastUsed = Date.now();
      selected.usage++;
      selected.todayRequests++; // زيادة العداد اليومي في الذاكرة

      // تحديث الداتابيز (عداد الاستخدام الكلي + اليومي + تاريخ التحديث)
      // هذا يضمن حفظ الحالة حتى لو انطفأ السيرفر
      this._syncKeyStats(selected.key, {
        usage_count: selected.usage,
        today_requests_count: selected.todayRequests,
        last_reset_at: new Date().toISOString()
      });

      resolve(selected);
    } else {
      // إذا نفدت كل المفاتيح أو كلها مشغولة
      logger.warn('⚠️ All keys reached daily limit or are busy! Queuing request...');
      this.queue.push(tryAcquire);
    }
  };

  tryAcquire();
});
}
// ============================================================
// 3. إرجاع المفتاح (Check-In)
// ============================================================
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
const hasIdle = Array.from(this.keys.values()).some(k => k.status === 'idle');
if (hasIdle) {
const nextRequest = this.queue.shift(); // FIFO
if (nextRequest) nextRequest();
}
}
}
// تسجيل استهلاك التوكنز
async recordUsage(keyStr, usageMetadata, userId = null, modelName = 'unknown') {
const keyObj = this.keys.get(keyStr);
if (!keyObj || !usageMetadata) return;
const input = usageMetadata.promptTokenCount || 0;
const output = usageMetadata.candidatesTokenCount || 0;

keyObj.inputTokens += input;
keyObj.outputTokens += output;

try {
  // تحديث ذري (Atomic) في الداتابيز
  await supabase.rpc('increment_key_usage', {
    key_val: keyStr,
    inc_input: input,
    inc_output: output
  });

  // (اختياري) سجل مفصل
  /* await supabase.from('ai_usage_logs').insert({
      user_id: userId,
      model_name: modelName,
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      key_nickname: keyObj.nickname
  }); */

} catch (e) {
  console.error('Failed to log tokens:', e.message);
}
}
async _syncKeyStats(keyStr, updates) {
// تحديث خفيف في الخلفية (Fire & Forget)
try {
await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
} catch (e) { /* ignore */ }
}
// --- دوال Admin ---
getAllKeysStatus() {
return Array.from(this.keys.values()).map(k => ({
key: k.key.substring(0, 8) + '...',
nickname: k.nickname,
status: k.status,
fails: k.fails,
todayRequests: k.todayRequests, // ✅ إضافة مهمة للأدمين
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
this._syncKeyStats(keyStr, { status: 'active', fails_count: 0 }); // تحديث الداتابيز أيضاً
return { success: true };
}
return { success: false };
}
}
const instance = new KeyManager();
module.exports = instance;
