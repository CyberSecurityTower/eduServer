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

// 👇 أضفنا retryLimit هنا
async function _callModelInstance(targetModelName, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch, retryLimit = 3) {
  
  // نستخدم القيمة الممرة أو الافتراضي 3
  const MAX_ATTEMPTS = retryLimit; 
  const failedKeysInThisRequest = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      
      const keyObj = await keyManager.acquireKey();
      
      if (!keyObj || failedKeysInThisRequest.has(keyObj.key)) {
          if (attempt === 1 && !keyObj) {
              // إذا لم نجد مفاتيح من أول مرة، هذا يعني النظام ميت تماماً
               throw new Error('System Overload: No healthy AI nodes available.');
          }
          // إذا نفدت المفاتيح المتاحة (كلها cooldown)، ننتظر قليلاً ثم نحاول
          await sleep(1000);
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
          
          if (!responseText || responseText.length < 2) throw new Error('Empty Response');

          // ✅ نجاح
          keyManager.reportResult(keyObj.key, true);
          
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

          // 🚨 تبليغ الفشل فوراً
          keyManager.reportResult(keyObj.key, false, errType);
          failedKeysInThisRequest.add(keyObj.key);

          // انتظار ذكي
          await sleep(500 * attempt);
      }
  }

  logger.error(`💀 REQUEST FAILED after ${MAX_ATTEMPTS} attempts. tried: ${Array.from(failedKeysInThisRequest).length} keys.`);
  throw new Error('AI Service Unavailable: Please try again later.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
