// services/ai/failover.js
const { _callModelInstance } = require('./index');
const CONFIG = require('../../config');

async function generateWithFailover(poolName, prompt, opts = {}) {
    // تم تغيير الفولباك إلى 3-flash بدلاً من 1.5-flash
    const targetModel = CONFIG.MODEL[poolName] || 'gemini-2.5-flash';

    return await _callModelInstance(
        targetModel,
        prompt, 
        opts.timeoutMs, 
        opts.label, 
        opts.systemInstruction,
        opts.history,
        opts.attachments,
        opts.enableSearch,
        opts.maxRetries 
    );
}
module.exports = generateWithFailover;
