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
                    contents: [{ role: 'user', parts: [{ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }] }],
                    generationConfig
                }),
                timeoutMs,
                `${label} [${modelName}]`
            );

            const response = await result.response;
            successText = response.text();
            
            // إذا وصلنا هنا، يعني نجحنا! نخرج من الحلقة
            if (response.usageMetadata) {
                keyManager.recordUsage(keyObj.key, response.usageMetadata, null, modelName);
            }
            
            break; 

        } catch (err) {
            lastError = err;
            // إذا كان الخطأ ليس 429 (مثلاً خطأ في البرومبت)، لا فائدة من تغيير الموديل، نوقف المحاولة
            if (!err.message.includes('429') && !err.message.includes('Quota')) {
                throw err;
            }
            // إذا كان 429، نكمل للدورة التالية (الموديل التالي)
             logger.warn(`⚠️ Model ${modelName} exhausted on key ${keyObj.nickname}. Trying next...`);
        }
    }

    if (successText) {
        keyManager.releaseKey(keyObj.key, true);
        return successText;
    } else {
        // إذا فشلت كل الموديلات، نرمي الخطأ الأخير ونعاقب المفتاح
        throw lastError;
    }

  } catch (err) {
    const errorType = err.message?.includes('429') ? '429' : 'error';
    if (keyObj) keyManager.releaseKey(keyObj.key, false, errorType);
    
    logger.warn(`❌ All models failed on key: ${err.message}`);
    throw err;
  }
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
// تصدير
module.exports = {
  initializeModelPools,
  _callModelInstance,
  modelPools: {}, 
  keyStates: {} 
};
