// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');

// نستخدم المكتبة الرسمية مباشرة بدون تعقيدات
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];

async function initializeModelPools() {
  await keyManager.init();
  // رسالة تطمينية أن النظام يعمل بوضع الاتصال المباشر
  logger.success(`🤖 AI Engine Ready: ${keyManager.getKeyCount()} Keys | Mode: Direct Connection (Fastest) 🚀`);
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = totalKeys * 2; 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      // نستخدم العميل المخزن مباشرة
      const genAI = keyObj.client; 

      for (const modelName of MODEL_CASCADE) {
        try {
          const tools = [];
          if (enableSearch) {
              tools.push({ googleSearch: {} });
          }

          const model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction,
            tools: tools
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

          let messageParts = [];
          if (attachments && Array.isArray(attachments) && attachments.length > 0) {
             messageParts.push(...attachments);
          }
          if (prompt) {
             messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });
          }

          const result = await withTimeout(
            chat.sendMessage(messageParts),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }
           
          liveMonitor.trackAiGeneration((usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0));

          keyManager.releaseKey(keyObj.key, true);
          return successText;

        } catch (modelErr) {
           const errStr = String(modelErr);
           // إذا كان الخطأ 429 (كوتا)، نرمي الخطأ لنغير المفتاح
           if (errStr.includes('429') || errStr.includes('Quota')) {
               throw modelErr;
           }
           // أخطاء أخرى (مثل Overloaded) نجرب الموديل التالي بنفس المفتاح
           logger.warn(`⚠️ Model ${modelName} hiccup on key ${keyObj.nickname}. Trying next model...`);
        }
      }
      throw new Error('All models failed on this key');

    } catch (keyErr) {
        lastError = keyErr;
        const errStr = String(keyErr);
        const isRateLimit = errStr.includes('429') || errStr.includes('Quota');
        
        if (keyObj) {
            // نحرر المفتاح ونبلغ أنه فشل
            keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
        }

        // انتظار بسيط جداً
        if (isRateLimit) await sleep(200); 
    }
  }
  
  throw lastError ?? new Error('Service Busy: All keys exhausted.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
