// services/ai/index.js (Updated)
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout } = require('../../utils');
const keyManager = require('./keyManager'); // استيراد المدير الجديد

async function initializeModelPools() {
  await keyManager.init(); // تهيئة المفاتيح
  logger.success('🤖 AI Engine: Model Pools & Key Manager Ready.');
}

// دالة الاتصال الرئيسية (تم تعديلها لتستخدم المدير)
async function _callModelInstance(unused_instance, prompt, timeoutMs, label) {
  let keyObj = null;

  try {
    // 1. طلب مفتاح من المدير (قد ينتظر في الطابور)
    keyObj = await keyManager.acquireKey();
    
    // 2. الحصول على الموديل من المفتاح المختار
    // ملاحظة: الموديل يعتمد على اسم الـ pool، لكن هنا سنبسط الأمر وننشئ الموديل ديناميكياً
    // أو يمكن تخزين الموديلات داخل keyObj مسبقاً. للسهولة سنستخدم getGenerativeModel هنا.
    
    // نحتاج معرفة أي موديل نطلب (chat, embedding, etc). 
    // سنفترض أن CONFIG.MODEL يحتوي على اسم الموديل الافتراضي 'gemini-2.0-flash' مثلاً
    // للأسف الدالة _callModelInstance القديمة كانت تأخذ instance جاهز. 
    // سنعدل المنطق قليلاً. الدالة المستدعية (failover) يجب أن تمرر اسم الموديل.

    // الحل السريع: نأخذ الموديل الافتراضي من CONFIG إذا لم يمرر
    const modelName = CONFIG.MODEL.chat || 'gemini-2.5-flash'; 
    const model = keyObj.client.getGenerativeModel({ model: modelName });

    const generationConfig = { temperature: 0.4 };
    
    // 3. تنفيذ الطلب
    const result = await withTimeout(
        model.generateContent({
            contents: [{ role: 'user', parts: [{ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }] }],
            generationConfig
        }),
        timeoutMs,
        `${label} (Key: ${keyObj.nickname})`
    );

    const response = await result.response;
    const text = response.text();

    // 4. إبلاغ المدير بالنجاح
    keyManager.releaseKey(keyObj.key, true);
    
    return text;

  } catch (err) {
    // 5. إبلاغ المدير بالفشل
    const errorType = err.message.includes('429') ? '429' : 'error';
    if (keyObj) keyManager.releaseKey(keyObj.key, false, errorType);

    logger.warn(`Key execution failed: ${err.message}`);
    throw err; // نرمي الخطأ لكي يقوم failover بالمحاولة مرة أخرى (إذا أردت)
    // أو بما أن المدير لديه طابور، يمكننا الاكتفاء بذلك، لكن failover مفيد لتغيير البرومبت
  }
}

// تصدير
module.exports = {
  initializeModelPools,
  _callModelInstance,
  modelPools: {}, 
  keyStates: {} 
};
