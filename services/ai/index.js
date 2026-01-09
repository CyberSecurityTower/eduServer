
// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');
const proxyManager = require('./proxyManager');
const { SocksProxyAgent } = require('socks-proxy-agent'); // ✅ إضافة جديدة

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
  const mode = proxyCount > 0 ? `Active (${proxyCount} IPs)` : 'Direct (Server IP)';
  logger.success(`🤖 AI Engine Ready: ${keyManager.getKeyCount()} Keys | Proxy Mode: ${mode}`);
}

/**
 * ✅ الدالة الذكية المحدثة: تدعم SOCKS و HTTP
 */
function createSmartFetch(proxyUrl) {
    return (url, init) => {
        const options = { ...init };
        
        if (proxyUrl) {
            // التحقق من نوع البروكسي
            if (proxyUrl.startsWith('socks')) {
                // ✅ استخدام مكتبة SOCKS
                options.agent = new SocksProxyAgent(proxyUrl);
            } else {
                // ✅ استخدام مكتبة HTTP/HTTPS
                options.agent = new HttpsProxyAgent(proxyUrl);
            }
            options.timeout = 15000; // مهلة 15 ثانية
        } 
        // إذا كان null، سيتم الاتصال المباشر تلقائياً
        
        return fetch(url, options);
    };
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 5; 
  // نزيد عدد المحاولات لضمان تجربة عدة بروكسيات وعدة مفاتيح
  const MAX_ATTEMPTS = Math.max(totalKeys * 2, 6); 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      // 1. جلب البروكسي (أو null للاتصال المباشر)
      const currentProxy = proxyManager.getProxy();
      const connectionType = currentProxy ? 'Proxy' : 'Direct';

      // طباعة توضيحية عند الفشل وإعادة المحاولة
      if (attempt > 0) {
          logger.log(`🔄 [Failover] Retry ${attempt}/${MAX_ATTEMPTS} using: ${connectionType} IP...`);
      }

      // 2. تجهيز دالة Fetch المناسبة لهذا الطلب
      const customFetch = createSmartFetch(currentProxy);
      
      const genAI = new GoogleGenerativeAI(keyObj.key);
      
      // 3. ⚠️ Monkey-patching: إجبار مكتبة Google على استخدام الـ fetch الخاص بنا
      // نحفظ الـ fetch الأصلي للنظام
      const originalFetch = global.fetch;
      // نستبدله بـ customFetch لهذه العملية فقط
      global.fetch = customFetch;

      try {
          // --- بداية منطق استدعاء الموديل ---
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

              // تسجيل الاستهلاك
              const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
              if (usageMetadata) {
                keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
              }
               
              liveMonitor.trackAiGeneration((usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0));

              // تحرير المفتاح بنجاح
              keyManager.releaseKey(keyObj.key, true);
              return successText; 

            } catch (modelErr) {
               const errStr = String(modelErr);
               
               // هل الخطأ يستحق تبديل الموديل فقط (مثل Model Overloaded) أم تبديل الاتصال بالكامل؟
               // الأخطاء التالية تعني أن IP أو المفتاح محروق، لذا نرمي الخطأ للخارج لتبديل كل شيء
               if (errStr.includes('429') || errStr.includes('Quota') || errStr.includes('fetch failed') || errStr.includes('network') || errStr.includes('EHOSTUNREACH')) {
                   throw modelErr;
               }
               
               logger.warn(`⚠️ Model ${modelName} hiccup. Trying backup model...`);
            }
          }
          // --- نهاية منطق الموديل ---
      } finally {
          // ✅ استعادة الـ fetch الأصلي دائماً (حتى لو حدث خطأ) لكي لا نؤثر على باقي التطبيق
          global.fetch = originalFetch;
      }

      throw new Error('All models failed on this key/proxy configuration');

    } catch (err) {
        lastError = err;
        const errStr = String(err);
        
        // تصنيف الخطأ لاتخاذ القرار المناسب
        const isProxyError = errStr.includes('ECONNRESET') || errStr.includes('ETIMEDOUT') || errStr.includes('fetch failed');
        const isRateLimit = errStr.includes('429') || errStr.includes('Quota');

        if (isProxyError && currentProxy) {
            // إذا كان الخطأ من البروكسي، نحرر المفتاح كـ "خطأ شبكة" ليتم استخدامه لاحقاً
            if (keyObj) keyManager.releaseKey(keyObj.key, false, 'network');
        } else if (keyObj) {
            // إذا كان خطأ كوتا أو غيره، نحسبه فشل على المفتاح
            keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
        }

        // انتظار قصير قبل المحاولة التالية ببروكسي ومفتاح جديد
        await sleep(200);
    }
  }
  
  throw lastError ?? new Error('Service Unavailable: All attempts failed.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
