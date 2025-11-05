
// services/ai/index.js
'use strict';

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
    logger.error('No Google API keys found (GOOGLE_API_KEY or GOOGLE_API_KEY_1..5). Exiting.');
    process.exit(1);
  }

  for (const key of apiKeyCandidates) {
    try {
      const client = new GoogleGenerativeAI(key);
      keyStates[key] = { fails: 0, backoffUntil: 0 };
      for (const pool of poolNames) {
        try {
          const instance = client.getGenerativeModel({ model: CONFIG.MODEL[pool] });
          modelPools[pool].push({ model: instance, key });
        } catch (e) {
          logger.warn(`Failed to create model instance for pool ${pool} with key:`, e.message);
        }
      }
    } catch (e) {
      logger.warn('GoogleGenerativeAI init failed for a key:', e.message);
    }
  }

  poolNames.forEach(p => {
    if (!modelPools[p] || modelPools[p].length === 0) {
      logger.error(`Model pool "${p}" is empty. Check API keys & model names. Requires: ${CONFIG.MODEL[p]}`);
      process.exit(1);
    }
  });
  logger.success('Model pools ready:', Object.fromEntries(poolNames.map(p => [p, modelPools[p].length])));
}

// Robust model caller that tries multiple possible SDK method names
async function _callModelInstance(instance, prompt, timeoutMs, label) {
  const model = instance.model;
  const methodCandidates = ['generateContent', 'generate', 'generateText', 'predict', 'response', 'complete'];
  let lastErr = null;

  for (const name of methodCandidates) {
    const fn = model && model[name];
    if (typeof fn !== 'function') continue;
    try {
      const maybe = fn.length === 1 ? fn(prompt) : fn({ prompt });
      const res = await withTimeout(Promise.resolve(maybe), timeoutMs, `${label}:${name}`);
      return res;
    } catch (err) {
      lastErr = err;
      logger.warn(`Model method ${name} failed for key ${instance.key?.slice(-4)}:`, err && err.message ? err.message : err);
    }
  }

  throw lastErr || new Error('No callable model method found on instance');
}

module.exports = {
  initializeModelPools,
  modelPools,
  keyStates,
  _callModelInstance,
  poolNames,
};
