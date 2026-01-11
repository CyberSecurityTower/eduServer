// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');
const { callHuggingFace } = require('./huggingFaceAdapter');

// موديلات جوجل
const GOOGLE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Engine: Hybrid Mode Active | Loaded ${count} Keys`);
}

async function _callModelInstance(targetModelName, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  // 🔁 سنحاول دورتين: الدورة الأولى HF ثم Google (حسب طلبك للتجربة)
  const MAX_CYCLES = 2; 

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      if (cycle > 1) logger.warn(`🔄 Cycle ${cycle}: Retrying AI sequence...`);

      // ========================================================
      // 1️⃣ المرحلة الأولى: Hugging Face (DeepSeek/Qwen) 🔥 [الأولوية الآن]
      // ========================================================
      // نجرب كل مفاتيح HF المتاحة أولاً
      let hfKeyObj;
      // نطلب مفتاح HF صالح
      while ((hfKeyObj = await keyManager.acquireKey('huggingface'))) {
          try {
              logger.info(`🚀 [Try HF] Using Key: ${hfKeyObj.nickname} | Model: DeepSeek-R1...`);
              
              // تحذير: HF Inference API لا يدعم تصفح الويب المباشر، هو يولد نصوص فقط
              // لكننا نمرر له البرومبت كما هو
              
              // دمج المرفقات في النص (لأن النسخة المجانية نصية فقط)
              let finalPrompt = prompt;
              if (attachments?.length) finalPrompt += "\n[System Note: User attached images/files. Do your best to answer based on text context.]";
              if (enableSearch) finalPrompt += "\n[System Note: User requested current web info. Use your internal knowledge base as best as you can.]";

              const responseText = await withTimeout(
                  callHuggingFace(hfKeyObj.key, finalPrompt, systemInstruction, history, 'deepseek'),
                  (timeoutMs || 40000) + 10000, 
                  `HF_Call`
              );

              if (responseText && responseText.length > 5) {
                  logger.success(`✅ SUCCESS: [HuggingFace] Key: ${hfKeyObj.nickname} | Model: DeepSeek | Length: ${responseText.length}`);
                  keyManager.releaseKey(hfKeyObj.key, true);
                  return { text: responseText, sources: [] };
              }
              
              throw new Error('Empty response from HF');

          } catch (err) {
              const errStr = String(err);
              let errType = 'error';
              if (errStr.includes('503') || errStr.includes('LOADING')) errType = '503_loading';

              logger.warn(`❌ FAIL: HF Key ${hfKeyObj.nickname}. Reason: ${errType} | Msg: ${errStr.substring(0, 50)}...`);
              keyManager.releaseKey(hfKeyObj.key, false, errType);

              // إذا كان "تحميل"، ننتظر قليلاً قبل تجربة المفتاح التالي
              if (errType === '503_loading') await sleep(3000);
          }
      }

      // ========================================================
      // 2️⃣ المرحلة الثانية: Google Gemini (الاحتياطي الآن)
      // ========================================================
      // نحاول مرتين مع جوجل
      for (let gAttempt = 1; gAttempt <= 2; gAttempt++) {
          const keyObj = await keyManager.acquireKey('google');
          
          if (!keyObj) break; // لا توجد مفاتيح جوجل

         
          try {
              // 👇 نستخدم الموديل المحدد في الكونفيج، أو نعود للافتراضي (flash)
              const selectedModel = targetModelName || 'gemini-1.5-flash';
              
              logger.info(`🔹 [Try Google] Key: ${keyObj.nickname} | Model: ${selectedModel} | Search: ${enableSearch ? 'ON' : 'OFF'}...`);
              
              const genAI = keyObj.client;
              const tools = enableSearch ? [{ googleSearch: {} }] : [];
              
              const model = genAI.getGenerativeModel({ 
                  model: selectedModel, // 👈 استخدام المتغير الديناميكي
                  systemInstruction,
                  tools: tools 
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
                  timeoutMs || 180000,
                  `Gemini_Call`
              );
              
              const response = await result.response;
              const responseText = response.text();

              // استخراج المصادر إذا وجدت (Web Search Results)
              let sources = [];
              if (enableSearch && response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
                  sources = response.candidates[0].groundingMetadata.groundingChunks
                      .map(c => c.web ? { title: c.web.title, url: c.web.uri } : null)
                      .filter(Boolean);
              }

              logger.success(`✅ SUCCESS: [Google] Key: ${keyObj.nickname} | Search Used: ${sources.length > 0}`);
              keyManager.releaseKey(keyObj.key, true);
              return { text: responseText, sources: sources };

          } catch (err) {
              const errStr = String(err);
              let errType = 'error';
              if (errStr.includes('429') || errStr.includes('Quota')) errType = '429';

              logger.warn(`❌ FAIL: Google Key ${keyObj.nickname}. Reason: ${errType}`);
              keyManager.releaseKey(keyObj.key, false, errType);
              await sleep(200);
          }
      }
      
      // انتظار قبل الدورة التالية
      if (cycle < MAX_CYCLES) await sleep(1000);
  }

  logger.error(`💀 SYSTEM MELTDOWN: All providers (HF & Google) failed.`);
  throw new Error('Service Busy: AI is overloaded. Please try again.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
