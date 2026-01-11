// services/ai/failover.js
const { _callModelInstance } = require('./index');
const CONFIG = require('../../config');

async function generateWithFailover(poolName, prompt, opts = {}) {
    const targetModel = CONFIG.MODEL[poolName] || 'gemini-1.5-flash';

    return await _callModelInstance(
        targetModel,
        prompt, 
        opts.timeoutMs, 
        opts.label, 
        opts.systemInstruction,
        opts.history,
        opts.attachments,
        opts.enableSearch,
        opts.maxRetries // 👈 أضفنا هذا المعامل الجديد
    );
}
module.exports = generateWithFailover;
