// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Genius Hive-Mind Active | Nodes: ${count}`);
}

async function _callModelInstance(targetModelName, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  const MAX_ATTEMPTS = 3; 
  // قائمة سوداء مؤقتة لهذا الطلب فقط (لضمان عدم تجربة نفس المفتاح مرتين في نفس الطلب)
  const failedKeysInThisRequest = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      
      // 1. طلب مفتاح ذكي
      const keyObj = await keyManager.acquireKey();
      
      // إذا لم نجد مفتاحاً، أو أعطانا المدير مفتاحاً جربناه وفشل للتو (نادر الحدوث مع النظام الجديد لكن للاحتياط)
      if (!keyObj || failedKeysInThisRequest.has(keyObj.key)) {
          if (attempt === 1 && !keyObj) throw new Error('System Overload: No healthy AI nodes available.');
          await sleep(500);
          continue;
      }

      try {
          const selectedModel = targetModelName || 'gemini-1.5-flash';
          
          if(attempt > 1) logger.warn(`🔄 Smart Retry ${attempt}/${MAX_ATTEMPTS} for [${label}] | Node: ${keyObj.nickname} (Health: ${keyObj.health})`);
          
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
          if (prompt) parts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

          const result = await withTimeout(
              chat.sendMessage(parts),
              timeoutMs || 60000,
              `Gemini_Call`
          );
          
          const response = await result.response;
          const responseText = response.text();
          
          // تحقق إضافي: هل النص فارغ؟ (أحياناً يحدث بدون خطأ)
          if (!responseText || responseText.length < 2) throw new Error('Empty Response');

          // ✅ نجاح باهر!
          // نخبر المدير ليرفع صحة هذا المفتاح ويكافئ أدائه
          keyManager.reportResult(keyObj.key, true);
          
          // استخراج المصادر
          let sources = [];
          if (enableSearch && response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
              sources = response.candidates[0].groundingMetadata.groundingChunks
                  .map(c => c.web ? { title: c.web.title, url: c.web.uri } : null)
                  .filter(Boolean);
          }

          return { text: responseText, sources: sources };

      } catch (err) {
          const errStr = String(err);
          let errType = 'error';

          if (errStr.includes('429') || errStr.includes('Quota')) errType = '429';
          else if (errStr.includes('Candidate was stopped')) errType = 'safety';

          logger.warn(`❌ Node Failure: ${keyObj.nickname} (${errType}). Reporting to Hive-Mind...`);

          // 🚨 تبليغ الفشل فوراً!
          // هذا سيقوم بخصم نقاط الصحة وعزل المفتاح إذا لزم الأمر
          // وبالتالي، أي مستخدم آخر سيطلب مفتاحاً الآن لن يحصل على هذا المفتاح
          keyManager.reportResult(keyObj.key, false, errType);
          
          // إضافته للقائمة السوداء المحلية لهذه الدالة
          failedKeysInThisRequest.add(keyObj.key);

          // انتظار ذكي قبل المحاولة التالية
          await sleep(500 * attempt);
      }
  }

  logger.error(`💀 REQUEST FAILED after ${MAX_ATTEMPTS} attempts. The Hive is struggling.`);
  throw new Error('AI Service Unavailable: Please try again later.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
