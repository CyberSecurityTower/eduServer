
// services/ai/index.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { withTimeout, sleep } = require('../../utils');
const keyManager = require('./keyManager');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 💎 1. تهيئة عميل جوجل المدفوع (مستقل تماماً عن المفاتيح المجانية)
const PAID_KEY = process.env.PAID_KEY;
let paidClient = null;
if (PAID_KEY) {
    paidClient = new GoogleGenerativeAI(PAID_KEY);
}

// 🚀 اسم الموديل الجديد الخاص بالمفتاح المدفوع (بناءً على طلبك)
const PAID_MODEL_NAME = 'gemini-3-flash-preview'; 

async function initializeModelPools() {
  await keyManager.init();
  const count = keyManager.getKeyCount();
  logger.success(`🤖 AI Genius Hive-Mind Active | Free Nodes: ${count} | Paid Node: ${paidClient ? 'ACTIVE 💎' : 'OFFLINE'}`);
}

// 🛠️ دالة مساعدة لتنفيذ الطلب الفعلي (لجعل الكود نظيفاً وتجنب التكرار)
async function executeGeminiRequest(client, modelName, prompt, timeoutMs, systemInstruction, history, attachments, enableSearch) {
    const tools = enableSearch ? [{ googleSearch: {} }] : [];
    
    const model = client.getGenerativeModel({ 
        model: modelName,
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

    let sources = [];
    if (enableSearch && response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
        sources = response.candidates[0].groundingMetadata.groundingChunks
            .map(c => c.web ? { title: c.web.title, url: c.web.uri } : null)
            .filter(Boolean);
    }

    return { text: responseText, sources: sources };
}

// 🧠 قلب النظام: هنا يحدث اتخاذ القرار الذكي
async function _callModelInstance(targetModelName, prompt, timeoutMs, label, systemInstruction, history, attachments, enableSearch) {
  
  // ====================================================================
  // 🟢 المرحلة الأولى: محاولة استخدام مفتاح مجاني (الموديلات القديمة)
  // ====================================================================
  const freeKeyObj = await keyManager.acquireKey();
  
  if (freeKeyObj) {
      try {
          // نستخدم الموديل العادي الممرر للمفاتيح المجانية (مثل gemini-2.5-flash)
          const selectedModel = targetModelName || 'gemini-2.5-flash';
          
          logger.info(`🟢 Attempting FREE KEY [${freeKeyObj.nickname}] for [${label}]...`);
          
          const result = await executeGeminiRequest(
              freeKeyObj.client, selectedModel, prompt, timeoutMs, 
              systemInstruction, history, attachments, enableSearch
          );

          // ✅ نجاح المفتاح المجاني (نرسل مكافأة للمفتاح في الداتابيز لترتفع صحته)
          keyManager.reportResult(freeKeyObj.key, true);
          return result;

      } catch (err) {
          const errStr = String(err);
          let errType = 'error';
          if (errStr.includes('429') || errStr.includes('Quota')) errType = '429';
          else if (errStr.includes('Candidate was stopped')) errType = 'safety';

          // 🚨 فشل المفتاح المجاني -> نعاقبه ونعزله (لكي يحصل المستخدم القادم على مفتاح مختلف)
          keyManager.reportResult(freeKeyObj.key, false, errType);
          logger.warn(`⚠️ Free Key [${freeKeyObj.nickname}] Failed. Moving to PAID KEY...`);
      }
  } else {
      logger.warn(`⚠️ No Free Keys available (All are resting). Moving directly to PAID KEY...`);
  }

  // ====================================================================
  // 💎 المرحلة الثانية: تدخل المفتاح المدفوع (Gemini 3 Flash)
  // ====================================================================
  if (paidClient) {
      try {
          logger.success(`💎 Using PAID KEY with Model [${PAID_MODEL_NAME}] for [${label}]...`);
          
          const result = await executeGeminiRequest(
              paidClient, PAID_MODEL_NAME, prompt, timeoutMs, 
              systemInstruction, history, attachments, enableSearch
          );
          
          return result;
          
      } catch (err) {
          logger.error(`❌ PAID KEY FAILED TOO!`, err.message);
          throw new Error('AI Service Unavailable: Both Free and Paid systems failed.');
      }
  }

  // إذا لم يكن المفتاح المدفوع موجوداً وفشلت كل المجانية
  throw new Error('AI Service Unavailable: System Overload.');
}

module.exports = {
  initializeModelPools,
  _callModelInstance
};
