// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout } = require('../../utils');
const keyManager = require('./keyManager');

// قائمة الموديلات بالترتيب (الأقوى فالأضعف)
const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.0-flash', // تأكد من الاسم الصحيح في الوثائق
  'gemini-2.5-flash-lite'      // الملاذ الأخير (حدود عالية)
];

async function initializeModelPools() {
  await keyManager.init();
  logger.success('🤖 AI Engine: Model Pools & Key Manager Ready.');
}
async function _callModelInstance(unused_instance, prompt, timeoutMs, label) {
  let keyObj = null;

  // helper to decide whether an error is transient (retryable)
  const isTransientError = (err) => {
    const msg = (err && (err.message || String(err))) || '';
    return /429|503|Quota|Overloaded/i.test(msg);
  };

  try {
    // 1. طلب مفتاح
    keyObj = await keyManager.acquireKey();
    let lastError = null;
    let successText = null;

    // 2. حلقة المحاولة (The Cascade Loop)
    for (const modelName of MODEL_CASCADE) {
      try {
        // logger.info(`🔄 Trying ${modelName} with key ${keyObj.nickname}...`);

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

        // some APIs return a Promise for the response text, so await safely
        const response = await result.response;
        successText = typeof response.text === 'function' ? await response.text() : String(response);

        // إذا وصلنا هنا، يعني نجحنا! نخرج من الحلقة
        const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
        if (usageMetadata) {
          keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
        }

        // successful - break out of cascade loop
        break;
      } catch (err) {
        lastError = err;

        // إذا كان الخطأ ليس ضغطاً (429/503/Quota/Overloaded)، نوقف المحاولة لأنه قد يكون خطأ في الكود
        if (!isTransientError(err)) {
          // non-transient: rethrow immediately to be handled by outer catch
          throw err;
        }

        // transient: log and try next model in cascade
        logger.warn(`⚠️ Model ${modelName} exhausted/overloaded on key ${keyObj?.nickname || 'unknown'}. Trying next... (${err && err.message ? err.message : String(err)})`);
        // continue to next modelName
      }
    } // end for

    if (successText != null) {
      // success: mark key healthy and return text
      keyManager.releaseKey(keyObj.key, true);
      return successText;
    } else {
      // إذا فشلت كل الموديلات، نرمي الخطأ الأخير ونعاقب المفتاح
      throw lastError ?? new Error('All models failed without throwing an error');
    }
  } catch (err) {
    // Outer catch: mark key as bad (if we acquired one)
    const msg = (err && (err.message || String(err))) || '';
    const errorType = /429/i.test(msg) ? '429' : 'error';
    if (keyObj) {
      try {
        keyManager.releaseKey(keyObj.key, false, errorType);
      } catch (releaseErr) {
        logger.error(`Failed to release key ${keyObj?.key}: ${releaseErr && releaseErr.message ? releaseErr.message : String(releaseErr)}`);
      }
    }

    logger.warn(`❌ All models failed on key: ${msg}`);
    throw err;
  }
}


module.exports = {
  initializeModelPools,
  _callModelInstance
};

