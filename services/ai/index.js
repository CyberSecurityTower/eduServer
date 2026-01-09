
// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');
const proxyManager = require('./proxyManager');

// ✅ استيراد المكتبات
const nodeFetch = require('node-fetch'); // استخدمنا اسماً مميزاً
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
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
 * ✅ الدالة الذكية (Smart Fetch)
 */
function createSmartFetch(proxyUrl) {
    return (url, init) => {
        const options = { ...init };
        
        if (proxyUrl) {
            try {
                if (proxyUrl.startsWith('socks')) {
                    options.agent = new SocksProxyAgent(proxyUrl);
                } else {
                    options.agent = new HttpsProxyAgent(proxyUrl);
                }
                options.timeout = 20000; // زيادة المهلة لـ 20 ثانية للبروكسيات البطيئة
            } catch (e) {
                logger.warn(`Invalid Proxy URL: ${proxyUrl}`);
            }
        }
        
        return nodeFetch(url, options);
    };
}

async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = Math.max(totalKeys * 2, 6); 
  let lastError = null;

  // حفظ الـ fetch الأصلي للنظام
  const originalGlobalFetch = global.fetch;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      const currentProxy = proxyManager.getProxy();
      const connectionType = currentProxy ? 'Proxy' : 'Direct';

      if (attempt > 0) {
          logger.log(`🔄 [Failover] Retry ${attempt}/${MAX_ATTEMPTS} using: ${connectionType} IP...`);
      }

      const customFetch = createSmartFetch(currentProxy);
      const genAI = new GoogleGenerativeAI(keyObj.key);
      
      // ⚠️ Monkey-patching: الحذر الشديد هنا
      global.fetch = customFetch;

      try {
          for (const modelName of MODEL_CASCADE) {
            try {
              const tools = [];
              if (enableSearch) tools.push({ googleSearch: {} });

              const model = genAI.getGenerativeModel({ 
                model: modelName,
                systemInstruction: systemInstruction,
                tools: tools
              });

              const chat = model.startChat({
                history: history || [],
                generationConfig: { temperature: 0.4, topP: 0.8, topK: 40 }
              });

              let messageParts = [];
              if (attachments && Array.isArray(attachments)) messageParts.push(...attachments);
              if (prompt) messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });

              // 🚀 تنفيذ الطلب
              const result = await withTimeout(
                chat.sendMessage(messageParts),
                timeoutMs,
                `${label} [${modelName}]`
              );

              const response = await result.response;
              const successText = response.text();

              // تسجيل الاستهلاك
              const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
              if (usageMetadata) keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
              
              liveMonitor.trackAiGeneration((usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0));

              keyManager.releaseKey(keyObj.key, true);
              return successText; 

            } catch (modelErr) {
               const errStr = String(modelErr);
               
               // أخطاء تستوجب تبديل البروكسي/المفتاح
               if (errStr.includes('429') || errStr.includes('Quota') || errStr.includes('fetch failed') || errStr.includes('network') || errStr.includes('EHOSTUNREACH') || errStr.includes('socket hang up') || errStr.includes('ECONNRESET')) {
                   throw modelErr;
               }
               
               logger.warn(`⚠️ Model ${modelName} hiccup. Trying backup model...`);
            }
          }
      } finally {
          // ✅ استعادة الـ fetch الأصلي فوراً بعد انتهاء محاولة الذكاء الاصطناعي
          global.fetch = originalGlobalFetch;
      }

      throw new Error('All models failed on this key/proxy configuration');

    } catch (err) {
        // تأكيد الاستعادة في حالة حدوث خطأ خارجي
        global.fetch = originalGlobalFetch;

        lastError = err;
        const errStr = String(err);
        
        const isProxyError = errStr.includes('ECONNRESET') || errStr.includes('ETIMEDOUT') || errStr.includes('fetch failed') || errStr.includes('socket hang up') || errStr.includes('timeout');
        const isRateLimit = errStr.includes('429') || errStr.includes('Quota');

        if (isProxyError && currentProxy) {
            // لا نحرر المفتاح كخطأ إذا كان البروكسي هو السبب
            // لكننا نحرره كـ 'network' لكي لا يستخدم فوراً
            if (keyObj) keyManager.releaseKey(keyObj.key, false, 'network');
        } else if (keyObj) {
            keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
        }

        await sleep(500); // زدنا مدة الانتظار قليلاً لتخفيف الضغط
    }
  }
  
  throw lastError ?? new Error('Service Unavailable: All attempts failed.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
