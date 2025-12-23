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

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history) {
  const MAX_KEY_RETRIES = 3; 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
    let keyObj = null;
    
    try {
      keyObj = await keyManager.acquireKey();
      
      for (const modelName of MODEL_CASCADE) {
        try {
          // 🔥 السر الأول: تمرير التعليمات البرمجية (المنهج الدراسي) للموديل
          const model = keyObj.client.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction // 👈 هنا يتم حقن المنهج الدراسي
          });

          const generationConfig = { 
            temperature: 0.4,
            topP: 0.8,
            topK: 40
          };

          // 🔥 السر الثاني: استخدام startChat لدعم التاريخ (History)
          const chat = model.startChat({
            history: history || [], // 👈 هنا يتم تمرير سياق المحادثة السابقة
            generationConfig
          });

          const result = await withTimeout(
            chat.sendMessage(typeof prompt === 'string' ? prompt : JSON.stringify(prompt)),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          // تسجيل الاستهلاك
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
          liveMonitor.trackAiGeneration(totalTokens);
          
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }

          keyManager.releaseKey(keyObj.key, true);
          return successText;

        } catch (modelErr) {
          if (String(modelErr).includes('429') || String(modelErr).includes('Quota')) {
             throw modelErr; 
          }
          logger.warn(`⚠️ Model ${modelName} failed on key ${keyObj.nickname}. Trying next model...`);
        }
      }
      throw new Error('All models failed on this key');

    } catch (keyErr) {
      lastError = keyErr;
      const isRateLimit = String(keyErr).includes('429') || String(keyErr).includes('Quota');
      
      if (keyObj) {
        keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
      }

      if (isRateLimit) {
        logger.warn(`❄️ Key Rate Limited (Attempt ${attempt + 1}/${MAX_KEY_RETRIES}). Switching key...`);
        continue; 
      } else {
        logger.error(`❌ Non-Quota Error: ${keyErr.message}`);
        break; // إذا كان الخطأ ليس كوتا، لا داعي للتكرار
      }
    }
  }

  throw lastError ?? new Error('Service Busy: All keys exhausted.');
}
module.exports = {
  initializeModelPools,
  _callModelInstance
};
