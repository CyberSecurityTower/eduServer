// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils'); 
const keyManager = require('./keyManager');
const liveMonitor = require('../monitoring/realtimeStats');

const MODEL_CASCADE = [
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];

async function initializeModelPools() {
  await keyManager.init();
  logger.success('🤖 AI Engine: Model Pools & Key Manager Ready.');
}

/**
 * الوظيفة الأساسية لاستدعاء الموديل
 * @param {*} unused_instance - (متروك للتوافق)
 * @param {string} prompt - النص
 * @param {number} timeoutMs - مهلة الانتظار
 * @param {string} label - لتتبع السجلات
 * @param {string} systemInstruction - تعليمات النظام
 * @param {Array} history - سجل المحادثة
 * @param {Array} attachments - مصفوفة المرفقات (صور/ملفات) جاهزة
 * @param {boolean} enableSearch - تفعيل البحث في جوجل
 */
async function _callModelInstance(unused_instance, prompt, timeoutMs, label, systemInstruction, history, attachments = [], enableSearch = false) {
  
  // استراتيجية المحاولات: ضعف عدد المفاتيح
  const totalKeys = keyManager.getKeyCount() || 5; 
  const MAX_ATTEMPTS = totalKeys * 2; 
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let keyObj = null;
    try {
      keyObj = await keyManager.acquireKey();
      
      for (const modelName of MODEL_CASCADE) {
        try {
          
          // 1. إعداد الأدوات (Google Search)
          const tools = [];
          if (enableSearch) {
              tools.push({ googleSearch: {} }); // 🔍 تفعيل البحث
          }

          const model = keyObj.client.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction,
            tools: tools // نمرر الأدوات
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

          // 2. تحضير الرسالة (نص + مرفقات متعددة)
          let messageParts = [];

          // ✅ التعديل الجوهري: دمج مصفوفة المرفقات (سواء كانت صورة واحدة أو 10)
          if (attachments && Array.isArray(attachments) && attachments.length > 0) {
             console.log(`📎 [AI Service] Injecting ${attachments.length} attachments into prompt.`);
             // التحقق من صحة الهيكل (Google GenAI يتطلب inlineData)
             attachments.forEach((att, idx) => {
                 if (!att.inlineData || !att.inlineData.data || !att.inlineData.mimeType) {
                     console.error(`⚠️ [AI Service] Invalid attachment format at index ${idx}:`, JSON.stringify(att));
                 }
             });
             messageParts.push(...attachments);
          }

          // إضافة النص (Prompt)
          if (prompt) {
             messageParts.push({ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });
          }

          // 🛑 DEBUG: طباعة ما سيتم إرساله للموديل (بدون طباعة الـ Base64 الطويل)
          const debugParts = messageParts.map(p => {
              if (p.inlineData) return { type: 'image', mime: p.inlineData.mimeType, size: p.inlineData.data.length };
              return { type: 'text', content: p.text ? p.text.substring(0, 50) + '...' : '...' };
          });
          console.log('🤖 [AI Service] Final MessageParts to Model:', JSON.stringify(debugParts, null, 2));


          // 3. الإرسال
          const result = await withTimeout(
            chat.sendMessage(messageParts),
            timeoutMs,
            `${label} [${modelName}]`
          );

          const response = await result.response;
          const successText = response.text();

          // 4. تسجيل الاستهلاك
          const usageMetadata = response.usageMetadata ?? result?.usageMetadata;
          if (usageMetadata) {
            keyManager.recordUsage(keyObj.key, usageMetadata, null, modelName);
          }
           
          // تعقب الاستهلاك المباشر (للداشبورد)
          const totalTokens = (usageMetadata?.promptTokenCount || 0) + (usageMetadata?.candidatesTokenCount || 0);
          liveMonitor.trackAiGeneration(totalTokens);

          // نجاح! حرر المفتاح
          keyManager.releaseKey(keyObj.key, true);
          return successText;

        } catch (modelErr) {
            // معالجة أخطاء الكوتا (429)
             if (String(modelErr).includes('429') || String(modelErr).includes('Quota') || String(modelErr).includes('403')) {
             throw modelErr; 
          }
           logger.warn(`⚠️ Model ${modelName} hiccup on key ${keyObj.nickname}. Trying next...`);
        }
      }
      throw new Error('All models failed on this key');

    } catch (keyErr) {
        lastError = keyErr;
        const isRateLimit = String(keyErr).includes('429') || String(keyErr).includes('Quota') || String(keyErr).includes('403');
        
        if (keyObj) {
            keyManager.releaseKey(keyObj.key, false, isRateLimit ? '429' : 'error');
        }

        if (isRateLimit) { 
            await sleep(100); 
            continue; 
        } else { 
            break; 
        }
    }
  }
  
  throw lastError ?? new Error('Service Busy: All keys exhausted.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
