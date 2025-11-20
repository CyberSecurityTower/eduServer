
// services/ai/managers/suggestionManager.js
'use strict';

const { getProfile, getProgress, fetchUserWeaknesses, fetchRecentComprehensiveChatHistory } = require('../../data/helpers');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');
const PROMPTS = require('../../../config/ai-prompts');

let generateWithFailoverRef;

function initSuggestionManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Suggestion Manager requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Suggestion Manager initialized.');
}

async function runSuggestionManager(userId) {
  try {
    // جلب البيانات بالتوازي للسرعة
    const [profile, progress, weaknesses, conversationTranscript] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      getProgress(userId).catch(() => ({})),
      fetchUserWeaknesses(userId).catch(() => []),
      fetchRecentComprehensiveChatHistory(userId).catch(() => '')
    ]);

    const profileSummary = profile?.profileSummary || 'No profile.';
    const currentTasks = progress?.dailyTasks?.tasks?.map(t => t.title).join(', ') || 'No tasks.';
    const weaknessesSummary = (weaknesses || []).map(w => w.lessonTitle).join(', ') || 'None.';

    const prompt = PROMPTS.managers.suggestion(profileSummary, currentTasks, weaknessesSummary, conversationTranscript);

    if (!generateWithFailoverRef) return getDefaultSuggestions();

    // نستخدم موديل 'suggestion' (يفضل أن يكون Flash للسرعة)
    const res = await generateWithFailoverRef('suggestion', prompt, { label: 'SuggestionManager', timeoutMs: 8000 });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'suggestion');

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      return parsed.suggestions.slice(0, 4);
    }
  } catch (error) {
    logger.error(`SuggestionManager failed for ${userId}:`, error.message);
  }

  return getDefaultSuggestions();
}

function getDefaultSuggestions() {
  return ["لخص لي هذا الدرس", "أعطني كويز سريع", "اشرح لي المفهوم الأساسي", "ما هي خطوتي التالية؟"];
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
