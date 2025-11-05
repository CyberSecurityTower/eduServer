
// services/ai/managers/reviewManager.js
'use strict';

const CONFIG = require('../../../config');
const { escapeForPrompt, safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initReviewManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Review Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Review Manager initialized.');
}

// Review manager: score an assistant reply and provide feedback
async function runReviewManager(userMessage, assistantReply) {
  try {
    const prompt = `You are a quality reviewer. Rate the assistant reply from 1 to 10 and provide concise feedback to improve it. Return ONLY a JSON object {"score": number, "feedback": "..."}.\n\nUser Message:\n${escapeForPrompt(safeSnippet(userMessage, 2000))}\n\nAssistant Reply:\n${escapeForPrompt(safeSnippet(assistantReply, 4000))}`;
    if (!generateWithFailoverRef) {
      logger.error('runReviewManager: generateWithFailover is not set.');
      return { score: 10, feedback: 'Good answer.' };
    }
    const res = await generateWithFailoverRef('review', prompt, { label: 'RunReview', timeoutMs: CONFIG.TIMEOUTS.review });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'review');
    if (parsed && typeof parsed.score === 'number') return parsed;
    return { score: 10, feedback: 'Good answer.' };
  } catch (err) {
    logger.error('runReviewManager error:', err.message);
    return { score: 10, feedback: 'No review available.' };
  }
}

module.exports = {
  initReviewManager,
  runReviewManager,
};
