
// services/ai/index.js
'use strict';

// 👇 استخدام المكتبة الجديدة
const { GoogleGenAI } = require('@google/genai');
const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { shuffled, withTimeout } = require('../../utils');

// ---------------- MODEL POOLS & KEY HEALTH ----------------
const poolNames = ['chat', 'todo', 'planner', 'titleIntent', 'notification', 'review', 'analysis', 'suggestion'];
const modelPools = poolNames.reduce((acc, p) => ({ ...acc, [p]: [] }), {});
const keyStates = {};

function initializeModelPools() {
  const apiKeyCandidates = Array.from({ length: 5 }, (_, i) => process.env[`GOOGLE_API_KEY_${i + 1}`]).filter(Boolean);
  if (process.env.GOOGLE_API_KEY && !apiKeyCandidates.includes(process.env.GOOGLE_API_KEY)) apiKeyCandidates.push(process.env.GOOGLE_API_KEY);
  
  if (apiKeyCandidates.length === 0) {
    logger.error('No Google API keys found. Exiting.');
    process.exit(1);
  }

  for (const key of apiKeyCandidates) {
    try {
      // 👇 التهيئة بالمكتبة الجديدة
      const client = new GoogleGenAI({ apiKey: key });
      
      keyStates[key] = { fails: 0, backoffUntil: 0 };
      
      for (const pool of poolNames) {
        // في المكتبة الجديدة، لا ننشئ "instance" للموديل، بل نحفظ الـ client واسم الموديل
        modelPools[pool].push({ 
            client: client, 
            modelName: CONFIG.MODEL[pool], 
            key 
        });
      }
    } catch (e) {
      logger.warn('GoogleGenAI init failed for a key:', e.message);
    }
  }

  logger.success('Model pools ready (GenAI SDK V1).');
}

// 👇 دالة الاستدعاء الجديدة المتوافقة مع Gemini 3
async function _callModelInstance(instance, prompt, timeoutMs, label) {
  const { client, modelName } = instance;
  
  try {
    // تحويل البرومبت إلى الصيغة التي تفهمها المكتبة الجديدة
    // المكتبة الجديدة تتوقع contents كمصفوفة
    let contents = [];
    if (typeof prompt === 'string') {
        contents = [{ role: 'user', parts: [{ text: prompt }] }];
    } else {
        // إذا كان البرومبت معقداً أصلاً
        contents = prompt; 
    }

    // إعدادات التفكير (اختياري، يمكن تفعيلها إذا أردت ذكاءً خارقاً)
    const config = {
        temperature: 0.3, // تقليل العشوائية لزيادة الدقة
        // thinkingConfig: { thinkingLevel: 'HIGH' } // ⚠️ فعل هذا السطر فقط إذا كان الموديل يدعم Thinking
    };

    // 👇 الاستدعاء الجديد
    const response = await withTimeout(
        client.models.generateContent({
            model: modelName,
            config: config,
            contents: contents
        }),
        timeoutMs,
        `${label}:generateContent`
    );

    // استخراج النص من الرد الجديد
    if (response && response.text) {
        return response.text();
    } else if (response && response.candidates && response.candidates[0]) {
         // أحياناً الرد يكون في candidates
         const parts = response.candidates[0].content.parts;
         return parts.map(p => p.text).join('');
    }
    
    throw new Error('Empty response from GenAI');

  } catch (err) {
    logger.warn(`GenAI call failed for ${modelName} (key ending ${instance.key.slice(-4)}):`, err.message);
    throw err;
  }
}

module.exports = {
  initializeModelPools,
  modelPools,
  keyStates,
  _callModelInstance,
  poolNames,
};
