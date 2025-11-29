
// services/ai/index.js
'use strict';

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
      const client = new GoogleGenAI({ apiKey: key });
      keyStates[key] = { fails: 0, backoffUntil: 0 };
      
      for (const pool of poolNames) {
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

async function _callModelInstance(instance, prompt, timeoutMs, label) {
  const { client, modelName } = instance;
  
  try {
    let contents = [];
    if (typeof prompt === 'string') {
        contents = [{ role: 'user', parts: [{ text: prompt }] }];
    } else {
        contents = prompt; 
    }

    const config = {
        temperature: 0.4,
    };

    // استدعاء الموديل
    const response = await withTimeout(
        client.models.generateContent({
            model: modelName,
            config: config,
            contents: contents
        }),
        timeoutMs,
        `${label}:generateContent`
    );

    // 🔥 التعديل الجوهري: استخراج النص بطريقة آمنة جداً 🔥
    
    // محاولة 1: الطريقة الرسمية
    if (response && typeof response.text === 'function') {
        try {
            return response.text();
        } catch (e) {
            // تجاهل الخطأ والمحاولة بالطريقة اليدوية
        }
    }

    // محاولة 2: الاستخراج اليدوي من candidates
    if (response && response.candidates && response.candidates.length > 0) {
        const firstCandidate = response.candidates[0];
        if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
            return firstCandidate.content.parts.map(p => p.text).join('');
        }
    }

    // محاولة 3: فحص الهيكل العام (للموديلات التجريبية أحياناً)
    if (response && response.text) {
        return response.text; // أحياناً تكون خاصية وليست دالة
    }

    throw new Error('Empty response structure from GenAI');

  } catch (err) {
    // تحسين رسالة الخطأ لمعرفة السبب
    let errMsg = err.message;
    if (err.body) {
        try {
            const body = JSON.parse(err.body);
            if (body.error) errMsg = JSON.stringify(body.error);
        } catch(e) {}
    }
    
    logger.warn(`GenAI call failed for ${modelName} (key ending ${instance.key.slice(-4)}):`, errMsg);
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
