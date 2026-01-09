// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');
const proxyManager = require('./proxyManager'); // ✅ استيراد مدير البروكسي

// ✅ استيراد مكتبات البروكسي (يجب تثبيتها: npm i https-proxy-agent node-fetch)
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];

async function initializeModelPools() {
  await keyManager.init();
  const proxyCount = proxyManager.getProxyCount();
  logger.success(`🤖 AI Engine Ready: ${keyManager.getKeyCount()} Keys | ${proxyCount} Proxies.`);
}

/**
 * دالة مساعدة لإنشاء دالة fetch مخصصة تستخدم البروكسي
 */
function createProxyFetch(proxyUrl) {
    return (url, init) => {
        const options = { ...init };
        if (proxyUrl) {
            options.agent = new HttpsProxyAgent(proxyUrl);
        }
        return fetch(url, options);
    };
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = totalKeys * 2; 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      // ✅ 1. جلب بروكسي جديد لهذه المحاولة
      const currentProxy = proxyManager.getProxy();
      
      if (currentProxy && attempt > 0) {
          logger.log(`🔄 [Failover] Rotating IP using proxy: ...${currentProxy.slice(-5)}`);
      }

      // ✅ 2. إنشاء عميل جديد تماماً لهذه المحاولة مع حقن الـ fetch المخصص
      // هذا يضمن أن الطلب يخرج من IP البروكسي وليس IP السيرفر
      const customFetch = createProxyFetch(currentProxy);
      
      // ملاحظة: GoogleGenerativeAI لا تدعم حقن fetch في الـ Constructor مباشرة في كل الإصدارات
      // الحل الأضمن في Node.js هو استبدال global.fetch مؤقتاً أو استخدام مكتبة تدعم ذلك.
      // لكن، في الإصدارات الحديثة، يمكننا تجاوز ذلك عبر عمل Patch بسيط للكلاس إذا لزم الأمر،
      // أو استخدام الخدعة التالية: استبدال global.fetch داخل النطاق (Scope) هذا فقط إذا كنا نستخدم Node 18+
      
      // الحل الأكثر استقراراً مع مكتبة Google الحالية هو إنشاء العميل وتمرير options إذا كانت مدعومة،
      // أو استخدام global fetch patch (الأكثر ضماناً للعمل مع البروكسي).
      
      const genAI = new GoogleGenerativeAI(keyObj.key);
      
      // ⚠️ Monkey-patching to force proxy usage (Google SDK uses global fetch in Node)
      // نحفظ الـ fetch الأصلي
      const originalFetch = global.fetch;
      // نستبدله بالخاص بنا
      global.fetch = customFetch;

      try {
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
               // إذا فشل الموديل، نجرب الموديل التالي (Flash -> Pro)
               const isQuota = String(modelErr).includes('429') || String(modelErr).includes('Quota');
               if (isQuota) throw modelErr; // ارمي الخطأ ليتم تغيير المفتاح والبروكسي
               
               logger.warn(`⚠️ Model ${modelName} hiccup on key ${keyObj.nickname}. Trying next...`);
            }
          }
      } finally {
          // ✅ استعادة الـ fetch الأصلي دائماً (حتى لو حدث خطأ)
          global.fetch = originalFetch;
      }

      throw new Error('All models failed on this key');

    } catch (keyErr) {
        lastError = keyErr;
        const isRateLimit = String(keyErr).includes('429') || String(keyErr).includes('Quota') || String(keyErr).includes('403') || String(keyErr).includes('EHOSTUNREACH');
        
        // إذا كان الخطأ من البروكسي، نبلغ عنه
        if (String(keyErr).includes('proxy') || String(keyErr).includes('ECONNRESET')) {
            logger.warn(`⚠️ Proxy connection failed.`);
        }

        if (keyObj) {
            // لا نعتبر المفتاح ميتاً فوراً إذا كان الخطأ بسبب الشبكة/البروكسي
            const errorType = isRateLimit ? '429' : 'network';
            keyManager.releaseKey(keyObj.key, false, errorType);
        }

        if (isRateLimit || String(keyErr).includes('network')) { 
            await sleep(200); // انتظار بسيط قبل المحاولة ببروكسي ومفتاح جديد
            continue; 
        } else { 
            break; 
        }
    }
  }
  
  throw lastError ?? new Error('Service Busy: All keys/proxies exhausted.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
