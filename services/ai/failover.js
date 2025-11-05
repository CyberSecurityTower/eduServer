
// services/ai/failover.js
'use strict';

const CONFIG = require('../../config');
const logger = require('../../utils/logger');
const { shuffled } = require('../../utils');
const { modelPools, keyStates, _callModelInstance } = require('./index'); // Import from ai/index

/**
 * يستدعي نموذجًا من مجموعة (pool) محددة، مع تطبيق آليات قوية للتعامل مع الأخطاء والتجاوز (Failover).
 * يقوم بتوزيع الحمل عشوائيًا على مفاتيح الواجهة البرمجية المتاحة، ويتجنب مؤقتًا المفاتيح التي تواجه أخطاء،
 * ويعيد المحاولة باستخدام المفتاح التالي المتاح حتى ينجح أو تستنفد جميع الخيارات.
 *
 * @param {string} poolName - اسم مجموعة النماذج المراد استخدامها (مثل 'chat', 'analysis').
 * @param {any} prompt - المُوجّه (prompt) الذي سيتم إرساله إلى النموذج.
 * @param {object} [opts={}] - خيارات إضافية.
 * @param {number} [opts.timeoutMs] - مهلة زمنية مخصصة بالمللي ثانية لهذا الطلب.
 * @param {string} [opts.label] - تسمية مخصصة للطلب لتظهر في سجلات الأخطاء.
 * @returns {Promise<any>} - يعد بإرجاع نتيجة ناجحة من النموذج.
 * @throws {Error} - يطلق خطأ إذا فشلت جميع المحاولات مع كل المفاتيح المتاحة في المجموعة.
 */
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
      if (!inst || !inst.model) {
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
