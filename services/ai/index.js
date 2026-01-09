// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');
const { callHuggingFace } = require('./huggingFaceAdapter');

// موديلات جوجل
const GOOGLE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Engine: Multi-Layer Genius Mode 🧠 | ${count} Keys Loaded`);
}

async function _callModelInstance(unused, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  // 🔁 السيناريو: نكرر العملية مرتين كحد أقصى إذا فشل كل شيء في الدورة الأولى
  const MAX_CYCLES = 2; 

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      if (cycle > 1) logger.warn(`🔄 Cycle ${cycle}: Retrying entire AI sequence...`);

      // ========================================================
      // 1️⃣ مرحلة جوجل (Gemini): محاولتين (2 attempts)
      // ========================================================
      for (let gAttempt = 1; gAttempt <= 2; gAttempt++) {
          const keyObj = await keyManager.acquireKey('google');
          
          if (!keyObj) {
              // لا توجد مفاتيح جوجل صالحة (كلها محروقة أو مشغولة)
              // نكسر حلقة جوجل ونذهب لـ HF فوراً
              // logger.log(`🔸 No Google keys available. Skipping to HF.`);
              break; 
          }

          try {
              // logger.log(`🔹 [Cycle ${cycle}] Trying Google Key: ${keyObj.nickname}...`);
              
              const genAI = keyObj.client;
              const model = genAI.getGenerativeModel({ 
                  model: GOOGLE_MODELS[0], 
                  systemInstruction,
                  tools: enableSearch ? [{ googleSearch: {} }] : [] 
              });

              const chat = model.startChat({ 
                  history: history || [],
                  generationConfig: { temperature: 0.6 }
              });

              let parts = [];
              if (attachments?.length) parts.push(...attachments);
              if (prompt) parts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

              const result = await withTimeout(
                  chat.sendMessage(parts),
                  timeoutMs || 25000,
                  `Gemini Call`
              );
              
              const responseText = (await result.response).text();

              // ✅ نجاح باهر
              logger.success(`✅ SUCCESS: ${keyObj.nickname} (Gemini) delivered the answer!`);
              keyManager.releaseKey(keyObj.key, true);
              return { text: responseText, sources: [] };

          } catch (err) {
              const errStr = String(err);
              let errType = 'error';
              if (errStr.includes('429') || errStr.includes('Quota')) errType = '429';

              logger.warn(`❌ FAIL: ${keyObj.nickname} died. Reason: ${errType}`);
              keyManager.releaseKey(keyObj.key, false, errType);
              
              // انتظار بسيط جداً قبل المحاولة الثانية لتهدئة الشبكة
              await sleep(200);
          }
      }

      // ========================================================
      // 2️⃣ مرحلة Hugging Face: تجربة *كل* المفاتيح المتاحة
      // ========================================================
      // في هذه المرحلة، نجرب كل مفاتيح HF واحداً تلو الآخر حتى ينجح أحدها
      
      // نطلب مفتاحاً تلو الآخر حتى تنفد المفاتيح الصالحة
      let hfKeyObj;
      while ((hfKeyObj = await keyManager.acquireKey('huggingface'))) {
          try {
              // logger.log(`🚀 [Cycle ${cycle}] Switching to HF Key: ${hfKeyObj.nickname} (Model: DeepSeek/Qwen)...`);
              
              // دمج المرفقات في النص لأن HF غالباً نصي فقط
              let finalPrompt = prompt;
              if (attachments?.length) finalPrompt += "\n[Note: Attachments provided but ignored in fallback mode.]";

              const responseText = await withTimeout(
                  callHuggingFace(hfKeyObj.key, finalPrompt, systemInstruction, history, 'deepseek'), // نطلب DeepSeek
                  (timeoutMs || 30000) + 10000, // نعطيه وقتاً أطول
                  `HF Call`
              );

              if (responseText && responseText.length > 5) {
                  logger.success(`✅ SUCCESS: ${hfKeyObj.nickname} (DeepSeek) saved the day!`);
                  keyManager.releaseKey(hfKeyObj.key, true);
                  return { text: responseText, sources: [] };
              }
              
              throw new Error('Empty response from HF');

          } catch (err) {
              const errStr = String(err);
              let errType = 'error';
              if (errStr.includes('503') || errStr.includes('LOADING')) errType = '503_loading';

              logger.warn(`❌ FAIL: ${hfKeyObj.nickname} failed. Reason: ${errType}`);
              keyManager.releaseKey(hfKeyObj.key, false, errType);

              // إذا كان الخطأ "تحميل"، ننتظر قليلاً قبل تجربة المفتاح التالي
              if (errType === '503_loading') await sleep(2000);
          }
      }
      
      // إذا وصلنا هنا، يعني فشلت محاولتين جوجل + كل مفاتيح HF في هذه الدورة
      // ننتظر قليلاً قبل بدء الدورة الثانية (Cycle 2)
      if (cycle < MAX_CYCLES) await sleep(1000);
  }

  logger.error(`💀 TOTAL SYSTEM FAILURE: All providers exhausted after ${MAX_CYCLES} cycles.`);
  throw new Error('Server Busy: All AI brains are currently overloaded. Please try again in a minute.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
