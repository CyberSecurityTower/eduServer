
// services/ai/failover.js
const { _callModelInstance } = require('./index');

async function generateWithFailover(poolName, prompt, opts = {}) {
    // نمرر كل الخيارات المهمة للدالة التي تنفذ الطلب
    return await _callModelInstance(
        null, 
        prompt, 
        opts.timeoutMs, 
        opts.label, 
        opts.systemInstruction,
        opts.history           
    );
}
module.exports = generateWithFailover;
