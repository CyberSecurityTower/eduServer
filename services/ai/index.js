// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Engine: Google Only Mode | Loaded ${count} Keys`);
}

async function _callModelInstance(targetModelName, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  // سنحاول حتى 3 مرات باستخدام مفاتيح مختلفة في حال فشل أحدها
  const MAX_RETRIES = 3; 

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      
      // طلب مفتاح من المدير
      const keyObj = await keyManager.acquireKey(); // لا داعي لتمرير 'google'
      
      if (!keyObj) {
          if (attempt === 1) throw new Error('No Available AI Keys! System overloaded.');
          await sleep(1000); 
          continue; 
      }

      try {
          // استخدام الموديل المحدد أو الافتراضي
          const selectedModel = targetModelName || 'gemini-1.5-flash';
          
          if(attempt > 1) logger.warn(`🔄 Retry ${attempt}/${MAX_RETRIES} for [${label}] using Key: ${keyObj.nickname}...`);
          
          const genAI = keyObj.client;
          const tools = enableSearch ? [{ googleSearch: {} }] : [];
          
          const model = genAI.getGenerativeModel({ 
              model: selectedModel,
              systemInstruction,
              tools: tools 
          });

          const chat = model.startChat({ 
              history: history || [],
              generationConfig: { temperature: 0.7 }
          });

          let parts = [];
          if (attachments?.length) parts.push(...attachments);
          // إضافة النص
          if (prompt) parts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

          const result = await withTimeout(
              chat.sendMessage(parts),
              timeoutMs || 60000,
              `Gemini_Call`
          );
          
          const response = await result.response;
          const responseText = response.text();

          // استخراج المصادر (إذا تم استخدام البحث)
          let sources = [];
          if (enableSearch && response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
              sources = response.candidates[0].groundingMetadata.groundingChunks
                  .map(c => c.web ? { title: c.web.title, url: c.web.uri } : null)
                  .filter(Boolean);
          }

          // ✅ نجاح
          keyManager.releaseKey(keyObj.key, true);
          return { text: responseText, sources: sources };

      } catch (err) {
          const errStr = String(err);
          let errType = 'error';

          // تصنيف الخطأ
          if (errStr.includes('429') || errStr.includes('Quota')) errType = '429';
          else if (errStr.includes('Candidate was stopped')) errType = 'safety';

          logger.warn(`❌ FAIL: Key ${keyObj.nickname}. Reason: ${errType}`);
          
          // تحرير المفتاح مع تسجيل الفشل
          keyManager.releaseKey(keyObj.key, false, errType);
          
          // انتظار قصير قبل المحاولة التالية
          await sleep(500);
      }
  }

  // إذا وصلنا هنا، يعني فشلت كل المحاولات
  logger.error(`💀 AI SYSTEM FAIL: All ${MAX_RETRIES} attempts failed.`);
  throw new Error('Service Busy: Unable to generate response after multiple attempts.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
