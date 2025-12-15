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
  let keyObj = null;

  const isTransientError = (err) => {
    const msg = (err && (err.message || String(err))) || '';
    return /429|503|Quota|Overloaded/i.test(msg);
  };

  try {
    keyObj = await keyManager.acquireKey();
    let lastError = null;
    let successText = null;

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
        successText = typeof response.text === 'function' ? await response.text() : String(response);

        // ✅ هنا نسجل الطلب الحقيقي للذكاء الاصطناعي
        const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
        const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
        
        liveMonitor.trackAiGeneration(totalTokens); // 🔥 تسجيل النبضة
        
        if (usageMetadata) {
          keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
        }

        break; 
      } catch (err) {
        lastError = err;
        if (!isTransientError(err)) throw err;
        logger.warn(`⚠️ Model ${modelName} exhausted. Trying next...`);
      }
    }

    if (successText != null) {
      keyManager.releaseKey(keyObj.key, true);
      return successText;
    } else {
      throw lastError ?? new Error('All models failed');
    }
  } catch (err) {
    if (keyObj) keyManager.releaseKey(keyObj.key, false, 'error');
    throw err;
  }
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
