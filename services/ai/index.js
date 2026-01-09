// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');

const { GoogleGenerativeAI } = require('@google/generative-ai');

// التسلسل الهرمي للموديلات
const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];

// إعدادات الوضع العبقري
const MAX_ROUNDS = 3; // الحد الأقصى للدورات (يعيد الكرة 3 مرات)

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Engine: Genius Mode Activated 🧠 | ${count} Keys Loaded | ${MAX_ROUNDS} Failover Rounds`);
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 1; 
  // العدد الكلي للمحاولات = عدد المفاتيح × عدد الجولات
  const TOTAL_ALLOWED_ATTEMPTS = totalKeys * MAX_ROUNDS; 
  
  let lastError = null;

  for (let attempt = 1; attempt <= TOTAL_ALLOWED_ATTEMPTS; attempt++) {
    
    // 1. حساب رقم الجولة الحالية (Round Calculation)
    const currentRound = Math.ceil(attempt / totalKeys);
    
    // 2. حساب وقت الانتظار الذكي (Exponential Backoff)
    // الجولة 1: سريع جداً (0-100ms)
    // الجولة 2: متوسط (500ms)
    // الجولة 3: بطيء (2000ms) لإعطاء فرصة للسيرفرات
    let backoffTime = 0;
    if (currentRound === 2) backoffTime = 500;
    if (currentRound === 3) backoffTime = 2000;

    // إذا كنا في بداية جولة جديدة، ننتظر قليلاً لتهدأ الأمور
    if (attempt > 1 && (attempt - 1) % totalKeys === 0) {
        logger.warn(`🔄 [Failover] Round ${currentRound}/${MAX_ROUNDS} started. Cooling down for ${backoffTime}ms...`);
        await sleep(backoffTime);
    }

    let keyObj = null;
    try {
      // 3. الحصول على مفتاح (KeyManager يقوم بالتدوير تلقائياً)
      keyObj = await keyManager.acquireKey();
      
      const genAI = keyObj.client; 

      // 4. تجربة الموديلات (Flash ثم Pro)
      for (const modelName of MODEL_CASCADE) {
        try {
          // إعداد الأدوات
          const tools = [];
          if (enableSearch) tools.push({ googleSearch: {} });

          const model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction,
            tools: tools
          });

          // إعدادات التوليد
          const generationConfig = { 
            temperature: 0.4 + (currentRound * 0.1), // زيادة الإبداع قليلاً في المحاولات اليائسة
            topP: 0.8,
            topK: 40
          };

          const chat = model.startChat({
            history: history || [],
            generationConfig
          });

          // تجهيز الرسالة
          let messageParts = [];
          if (attachments && Array.isArray(attachments) && attachments.length > 0) {
             messageParts.push(...attachments);
          }
          if (prompt) {
             messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });
          }

          // 🚀 التنفيذ مع مهلة زمنية
          // في الجولات الأخيرة نزيد المهلة قليلاً لأننا يائسون
          const currentTimeout = timeoutMs + ((currentRound - 1) * 5000);

          const result = await withTimeout(
            chat.sendMessage(messageParts),
            currentTimeout,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          // 5. تسجيل النجاح والاستهلاك
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }
           
          liveMonitor.trackAiGeneration((usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0));

          // تحرير المفتاح بنجاح
          keyManager.releaseKey(keyObj.key, true);
          return successText; // 🏆 الخروج بنجاح

        } catch (modelErr) {
           const errStr = String(modelErr);
           
           // تحليل الخطأ:
           // 429 (Too Many Requests) أو Quota -> المفتاح انتهى، ارمِ الخطأ لنغير المفتاح
           if (errStr.includes('429') || errStr.includes('Quota') || errStr.includes('API key not valid')) {
               throw modelErr;
           }

           // 503 (Overloaded) أو 500 -> المشكلة في الموديل، جرب الموديل التالي (Pro) بنفس المفتاح
           logger.warn(`⚠️ [Round ${currentRound}] Model ${modelName} hiccup on key ${keyObj.nickname}. Trying backup model...`);
        }
      }
      
      // إذا وصلنا هنا، يعني كلا الموديلين (Flash & Pro) فشلا على هذا المفتاح
      throw new Error('All models failed on this key');

    } catch (keyErr) {
        lastError = keyErr;
        const errStr = String(keyErr);
        
        // تصنيف الخطأ لمدير المفاتيح
        // إذا كان كوتا (429) نحرره كخطأ ليتم تجميده
        // إذا كان خطأ آخر، نحرره كخطأ عادي ليأخذ دوره مرة أخرى لاحقاً
        const isRateLimit = errStr.includes('429') || errStr.includes('Quota');
        
        if (keyObj) {
            // الإبلاغ عن الفشل
            keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
            
            if (currentRound === MAX_ROUNDS) {
               logger.error(`❌ [Final Attempt] Key ${keyObj.nickname} died.`);
            } else {
               // لوج بسيط للمتابعة
               // logger.log(`🔸 Key ${keyObj.nickname} busy/failed. Switching...`);
            }
        }

        // انتظار ذكي قبل القفز للمفتاح التالي
        // إذا كان الخطأ كوتا، ننتظر قليلاً جداً
        // إذا كان خطأ شبكة، ننتظر أكثر
        const sleepDuration = isRateLimit ? 100 : (200 * currentRound);
        await sleep(sleepDuration); 
    }
  }
  
  // إذا وصلنا هنا، يعني استنفذنا كل المفاتيح × 3 جولات
  logger.error(`💀 SERVICE FAILURE: All ${totalKeys} keys failed after ${MAX_ROUNDS} rounds.`);
  throw lastError ?? new Error('Service Busy: All keys exhausted after multiple retries.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
