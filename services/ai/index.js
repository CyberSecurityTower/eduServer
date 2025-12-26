
// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); // تأكد من وجود sleep في utils
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

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history) {
  
  // 🔥 التغيير الجذري: عدد المحاولات يساوي ضعف عدد المفاتيح
  // هذا يعني "جرب كل المفاتيح الممكنة ولا تستسلم بسهولة"
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = totalKeys * 2; 
  
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    
    try {
      // طلب مفتاح (سينتظر إذا كان الطابور ممتلئاً)
      keyObj = await keyManager.acquireKey();
      
      for (const modelName of MODEL_CASCADE) {
        try {
          const model = keyObj.client.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction 
          });

          const generationConfig = { 
            temperature: 0.4,
            topP: 0.8,
            topK: 40
          };

          const chat = model.startChat({
            history: history || [],
            generationConfig
          });

          const result = await withTimeout(
            chat.sendMessage(typeof prompt === 'string' ? prompt : JSON.stringify(prompt)),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          // نجاح!
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
          liveMonitor.trackAiGeneration(totalTokens);
          
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }

          keyManager.releaseKey(keyObj.key, true);
          return successText; // 🚀 خروج من الدالة بنجاح

        } catch (modelErr) {
          // إذا كان الخطأ 429 (كوتا)، نخرج من حلقة الموديلات لنجرب مفتاحاً آخر
          if (String(modelErr).includes('429') || String(modelErr).includes('Quota') || String(modelErr).includes('403')) {
             throw modelErr; 
          }
          // أخطاء أخرى (مثل Overloaded) نجرب الموديل التالي بنفس المفتاح
          logger.warn(`⚠️ Model ${modelName} hiccup on key ${keyObj.nickname}. Trying next model...`);
        }
      }
      throw new Error('All models failed on this key');

    } catch (keyErr) {
      lastError = keyErr;
      const isRateLimit = String(keyErr).includes('429') || String(keyErr).includes('Quota') || String(keyErr).includes('403');
      
      if (keyObj) {
        // إذا كان الخطأ كوتا، نبلغ المدير ليضع المفتاح في التبريد
        keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
      }

      if (isRateLimit) {
        // ❄️ المفتاح مات، لا بأس، المحاولة التالية في الـ Loop ستجلب مفتاحاً جديداً
        // ننتظر قليلاً جداً (100ms) لتخفيف الضغط على الـ CPU
        await sleep(100);
        continue; 
      } else {
        // خطأ غير الكوتا (مثل خطأ في البرومبت نفسه)، لا فائدة من التكرار
        logger.error(`❌ Fatal AI Error: ${keyErr.message}`);
        break; 
      }
    }
  }

  // إذا وصلنا هنا، يعني جربنا كل المفاتيح وفشلنا
  throw lastError ?? new Error('Service Busy: All keys exhausted after multiple retries.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
