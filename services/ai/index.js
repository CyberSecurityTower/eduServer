
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


// 👇 نعدل الدالة لتقبل fileData و enableSearch
async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, fileData = null, enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = totalKeys * 2; 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      for (const modelName of MODEL_CASCADE) {
        try {
          
          // 1. إعداد الأدوات (Google Search)
          const tools = [];
          if (enableSearch) {
              tools.push({ googleSearch: {} }); // 🔍 تفعيل البحث
          }

          const model = keyObj.client.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction,
            tools: tools // نمرر الأدوات
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

          // 2. تحضير الرسالة (نص + صورة)
          let messageParts = [];

          if (fileData && fileData.data) {
             messageParts.push({
               inlineData: {
                 data: fileData.data, // Base64
                 mimeType: fileData.mime 
               }
             });
          }

          if (prompt) {
             messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });
          }

          // 3. الإرسال
          const result = await withTimeout(
            chat.sendMessage(messageParts),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          // ... (باقي كود التتبع كما هو) ...
          
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }
           // تعقب الاستهلاك المباشر
           const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
           liveMonitor.trackAiGeneration(totalTokens);

          keyManager.releaseKey(keyObj.key, true);
          return successText;

        } catch (modelErr) {
            // ... (نفس كود معالجة الأخطاء القديم) ...
             if (String(modelErr).includes('429') || String(modelErr).includes('Quota') || String(modelErr).includes('403')) {
             throw modelErr; 
          }
           logger.warn(`⚠️ Model ${modelName} hiccup. Trying next...`);
        }
      }
      throw new Error('All models failed on this key');
    } catch (keyErr) {
        // ... (نفس كود معالجة الأخطاء القديم) ...
        lastError = keyErr;
        if (keyObj) keyManager.releaseKey(keyObj.key, false, String(keyErr).includes('429') ? '429' : 'error');
        if (String(keyErr).includes('429')) { await sleep(100); continue; }
        else { break; }
    }
  }
  throw lastError ?? new Error('Service Busy');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
