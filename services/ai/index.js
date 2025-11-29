
// services/ai/index.js
'use strict';

// 👇 العودة للمكتبة القديمة
const { GoogleGenerativeAI } = require('@google/generative-ai');
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
      // 👇 الطريقة القديمة
      const genAI = new GoogleGenerativeAI(key);
      keyStates[key] = { fails: 0, backoffUntil: 0 };
      
      for (const pool of poolNames) {
        // إنشاء instance للموديل وتخزينه
        const model = genAI.getGenerativeModel({ model: CONFIG.MODEL[pool] });
        modelPools[pool].push({ 
            model: model, // نخزن الموديل مباشرة
            key 
        });
      }
    } catch (e) {
      logger.warn('GoogleGenerativeAI init failed for a key:', e.message);
    }
  }

  logger.success('Model pools ready (Old SDK).');
}

async function _callModelInstance(instance, prompt, timeoutMs, label) {
  const { model } = instance; // نستخرج الموديل
  
  try {
    // إعدادات التوليد
    const generationConfig = {
        temperature: 0.4,
    };

    // 👇 الاستدعاء بالطريقة القديمة
    const result = await withTimeout(
        model.generateContent({
            contents: [{ role: 'user', parts: [{ text: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) }] }],
            generationConfig
        }),
        timeoutMs,
        `${label}:generateContent`
    );

    const response = await result.response;
    return response.text(); // دالة text() تعمل هنا بشكل ممتاز

  } catch (err) {
    logger.warn(`GenAI call failed (key ending ${instance.key.slice(-4)}):`, err.message);
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
