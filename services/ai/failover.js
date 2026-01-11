// services/ai/failover.js
const { _callModelInstance } = require('./index');
const CONFIG = require('../../config'); // استيراد الكونفيج

async function generateWithFailover(poolName, prompt, opts = {}) {
    // 1. تحديد اسم الموديل بناءً على اسم البول (مثلاً 'lesson_generator' -> 'gemini-2.5-pro')
    const targetModel = CONFIG.MODEL[poolName] || 'gemini-1.5-flash';

    return await _callModelInstance(
        targetModel, // 👈 نمرر اسم الموديل هنا
        prompt, 
        opts.timeoutMs, 
        opts.label, 
        opts.systemInstruction,
        opts.history,
        opts.attachments,
        opts.enableSearch
    );
}
module.exports = generateWithFailover;
