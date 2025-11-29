
// services/ai/failover.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { shuffled } = require('../../utils');
const { modelPools, keyStates, _callModelInstance } = require('./index');

async function generateWithFailover(poolName, prompt, opts = {}) {
  const pool = modelPools[poolName];
  if (!pool || pool.length === 0) {
    throw new Error(`No models available for pool "${poolName}". Check configuration.`);
  }

  const timeoutMs = opts.timeoutMs || CONFIG.TIMEOUTS.default;
  const label = opts.label || poolName;
  let lastErr = null;

  for (const inst of shuffled(pool)) {
    try {
      // 🔥 التعديل هنا: التحقق من client و modelName بدلاً من model
      if (!inst || !inst.client || !inst.modelName) {
        logger.warn(`[Failover] Skipping invalid instance in pool "${poolName}"`);
        continue;
      }

      if (inst.key && keyStates[inst.key]?.backoffUntil > Date.now()) {
        continue;
      }

      const res = await _callModelInstance(inst, prompt, timeoutMs, `${label} (key:${inst.key.slice(-4)})`);
      
      if (inst.key && keyStates[inst.key]) {
        keyStates[inst.key].fails = 0;
      }
      return res;

    } catch (err) {
      lastErr = err;
      if (inst.key && keyStates[inst.key]) {
        const fails = (keyStates[inst.key].fails || 0) + 1;
        const backoff = Math.min(1000 * (2 ** fails), 10 * 60 * 1000);
        keyStates[inst.key] = { fails, backoffUntil: Date.now() + backoff };
        logger.warn(`[Failover] ${label} failed for key (fails=${fails}), backing off for ${backoff}ms:`, err.message);
      } else {
        logger.warn(`[Failover] ${label} failed for an instance without a key:`, err.message);
      }
    }
  }

  throw lastErr || new Error(`[Failover] ${label} failed for all available keys.`);
}

module.exports = generateWithFailover;
