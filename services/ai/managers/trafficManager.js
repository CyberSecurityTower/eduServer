
// services/ai/managers/trafficManager.js
'use strict';

const CONFIG = require('../../../config');
const { escapeForPrompt, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initTrafficManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Traffic Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Traffic Manager initialized.');
}
/*
async function runTrafficManager(message, lang = 'Arabic') {
  const prompt = `You are an expert intent classification system. Analyze the user's message and return a structured JSON object.

<rules>
1.  **Intent Classification:** Classify the intent into ONE of the following: 'analyze_performance', 'question', 'manage_todo', 'generate_plan', or 'unclear'.
2.  **Title Generation:** Create a short title (2-4 words) in the detected language.
3.  **Language Detection:** Identify the primary language (e.g., 'Arabic', 'English').
4.  **Output Format:** Respond with ONLY a single, valid JSON object. Do not add any extra text or explanations.
</rules>

<example>
User Message: "مرحبا، كيف يمكنني مراجعة أدائي الدراسي لهذا الأسبوع؟"
Your JSON Response:
{
  "intent": "analyze_performance",
  "title": "مراجعة الأداء الدراسي",
  "language": "Arabic"
}
</example>

User Message: "${escapeForPrompt(message)}"
Your JSON Response:`;
  try {
    if (!generateWithFailoverRef) {
      logger.error('runTrafficManager: generateWithFailover is not set.');
      return { intent: 'question', title: message.substring(0, 30), language: lang };
    }
    const res = await generateWithFailoverRef('titleIntent', prompt, { label: 'TrafficManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'titleIntent');
    if (parsed?.intent) return parsed;
    logger.warn(`TrafficManager fallback for: "${message}"`);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  } catch (err) {
    logger.error('runTrafficManager critical failure:', err.message);
    return { intent: 'question', title: message.substring(0, 30), language: lang };
  }
}
*/
async function runTrafficManager(message, lang = 'Arabic') {
  // 🛑 Return static fallback immediately
  return { 
      intent: 'question', 
      title: message.substring(0, 30), // استخدام جزء من الرسالة كعنوان
      language: lang 
  };
}
module.exports = {
  initTrafficManager,
  runTrafficManager,
};
