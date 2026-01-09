// services/ai/failover.js
const { _callModelInstance } = require('./index');

async function generateWithFailover(poolName, prompt, opts = {}) {
    return await _callModelInstance(
        null, 
        prompt, 
        opts.timeoutMs, 
        opts.label, 
        opts.systemInstruction,
        opts.history,
        opts.fileData,   
        opts.enableSearch 
    );
}
module.exports = generateWithFailover;
