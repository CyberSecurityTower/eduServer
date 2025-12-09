// services/ai/failover.js (Simplified)
const { _callModelInstance } = require('./index');

async function generateWithFailover(poolName, prompt, opts = {}) {
    // KeyManager now handles load balancing. 
    // We just call the function.
    return await _callModelInstance(null, prompt, opts.timeoutMs, opts.label);
}
module.exports = generateWithFailover;
