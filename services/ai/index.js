// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout } = require('../../utils');
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');

const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite'
];

async function initializeModelPools() {
  await keyManager.init();
  logger.success('🤖 AI Engine: Model Pools & Key Manager Ready.');
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label) {
  const MAX_KEY_RETRIES = 3; // سنحاول مع 3 مفاتيح مختلفة كحد أقصى
  let lastError = null;

  for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
    let keyObj = null;
    
    try {
      // 1. الحصول على مفتاح
      keyObj = await keyManager.acquireKey();
      
      // 2. محاولة الموديلات على هذا المفتاح
      for (const modelName of MODEL_CASCADE) {
        try {
          const model = keyObj.client.getGenerativeModel({ model: modelName });
          const generationConfig = { temperature: 0.4 };

          const result = await withTimeout(
            model.generateContent({
              contents: [
                {
                  role: 'user',
                  parts: [{ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }]
                }
              ],
              generationConfig
            }),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = typeof response.text === 'function' ? await response.text() : String(response);

          // تسجيل الاستهلاك
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
          liveMonitor.trackAiGeneration(totalTokens);
          
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }

          // ✅ نجاح! نطلق سراح المفتاح ونرجع النتيجة
          keyManager.releaseKey(keyObj.key, true);
          return successText;

        } catch (modelErr) {
          // إذا كان الخطأ ليس 429 (مثلاً خطأ في الموديل نفسه)، نجرب الموديل التالي
          // أما إذا كان 429، فهذا يعني المفتاح مات، نكسر الحلقة الداخلية لنغير المفتاح
          if (String(modelErr).includes('429') || String(modelErr).includes('Quota')) {
             throw modelErr; // ارمِ الخطأ لنغير المفتاح فوراً
          }
          logger.warn(`⚠️ Model ${modelName} failed on key ${keyObj.nickname}. Trying next model...`);
        }
      }
      
      // إذا وصلنا هنا، يعني جربنا كل الموديلات على هذا المفتاح وفشلت (بدون 429)
      throw new Error('All models failed on this key');

    } catch (keyErr) {
      lastError = keyErr;
      const isRateLimit = String(keyErr).includes('429') || String(keyErr).includes('Quota');
      
      if (keyObj) {
        // إذا كان الخطأ 429، نبلغ المدير بوضع المفتاح في "التبريد" (Cooldown)
        keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
      }

      if (isRateLimit) {
        logger.warn(`❄️ Key Rate Limited (Attempt ${attempt + 1}/${MAX_KEY_RETRIES}). Switching key...`);
        continue; // 🔄 جرب المفتاح التالي في الحلقة الخارجية
      } else {
        // إذا كان خطأ آخر غير الكوتا، ربما لا فائدة من التكرار
        logger.error(`❌ Non-Quota Error: ${keyErr.message}`);
      }
    }
  }

  // إذا فشلت كل المحاولات
  throw lastError ?? new Error('Service Busy: All keys exhausted.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
