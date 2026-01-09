// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');
const { callHuggingFace } = require('./huggingFaceAdapter');

// 🔄 التسلسل الهرمي للموديلات (Google)
const GOOGLE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Engine: Hybrid Genius Mode 🧠 | ${count} Keys (Google + HF)`);
}

async function _callModelInstance(unused, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  // سنحاول 3 مرات كحد أقصى (يمكنك زيادتها)
  // المحاولة 1: Google (الأسرع)
  // المحاولة 2: Hugging Face (الجوكر - DeepSeek/Qwen)
  // المحاولة 3: Google مرة أخرى (بمفتاح مختلف)
  
  const MAX_ATTEMPTS = 3; 

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    let currentProvider = 'google';

    try {
      // 🧠 استراتيجية الاختيار الذكي:
      // إذا كانت المحاولة 2، نطلب HuggingFace خصيصاً
      if (attempt === 2) {
          currentProvider = 'huggingface';
      }

      // جلب مفتاح (سيراعي الحظر العالمي تلقائياً)
      keyObj = await keyManager.acquireKey(currentProvider);
      
      // إذا لم نجد مفتاحاً للمزود المطلوب، KeyManager قد يعطينا أي مفتاح متاح
      // لذا نحدث المزود بناءً على المفتاح الذي حصلنا عليه فعلاً
      currentProvider = keyObj.provider;

      let responseText = '';

      // =================================================
      // 🔵 مسار GOOGLE GEMINI
      // =================================================
      if (currentProvider === 'google') {
          const genAI = keyObj.client;
          const modelName = GOOGLE_MODELS[0]; // نستخدم الفلاش للسرعة

          const tools = enableSearch ? [{ googleSearch: {} }] : [];
          const model = genAI.getGenerativeModel({ 
            model: modelName, 
            systemInstruction, 
            tools 
          });

          const chat = model.startChat({ 
              history: history || [],
              generationConfig: { temperature: 0.5 }
          });

          let messageParts = [];
          if (attachments && attachments.length > 0) messageParts.push(...attachments);
          if (prompt) messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

          const result = await withTimeout(
            chat.sendMessage(messageParts),
            timeoutMs || 30000,
            `${label} [Gemini]`
          );
          
          const response = await result.response;
          responseText = response.text();
      } 
      
      // =================================================
      // 🟡 مسار HUGGING FACE (DeepSeek / Qwen)
      // =================================================
      else if (currentProvider === 'huggingface') {
          logger.info(`🚀 Switching to HuggingFace (DeepSeek/Qwen) for failover...`);
          
          // دمج المرفقات في النص لأن HF غالباً text-only في الخطة المجانية
          let finalPrompt = prompt;
          if (attachments && attachments.length > 0) {
              finalPrompt += "\n[Note: User provided attachments/images which cannot be processed by this backup model. Ask user to describe them if needed.]";
          }

          responseText = await withTimeout(
             callHuggingFace(keyObj.key, finalPrompt, systemInstruction, history),
             timeoutMs || 45000, // نعطيه وقتاً أطول قليلاً
             `${label} [HuggingFace]`
          );
      }

      // ✅ نجاح!
      keyManager.releaseKey(keyObj.key, true);
      return { text: responseText, sources: [] }; // HF حالياً لا يرجع مصادر

    } catch (err) {
      const errStr = String(err);
      let errorType = 'error';

      // تصنيف الأخطاء للحظر الذكي
      if (errStr.includes('429') || errStr.includes('Quota')) errorType = '429';
      if (errStr.includes('503') || errStr.includes('LOADING')) errorType = '503';

      logger.warn(`🔸 Attempt ${attempt} failed on ${currentProvider}: ${errStr.substring(0, 100)}...`);

      if (keyObj) {
          keyManager.releaseKey(keyObj.key, false, errorType);
      }

      // إذا كان الخطأ "تحميل موديل" في HF، ننتظر قليلاً ثم نعيد المحاولة
      if (errorType === '503') await sleep(5000);
      else await sleep(1000);
    }
  }

  throw new Error('All AI providers failed. System overloaded.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
