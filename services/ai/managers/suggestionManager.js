
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

    const res = await generateWithFailoverRef('suggestion', prompt, { label: 'SuggestionManager', timeoutMs: 25000 }); 
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'suggestion');

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      // فلتر أمان إضافي للتأكد من الطول
      return parsed.suggestions
        .filter(s => s.split(' ').length <= 7) // نتأكد أنها ليست جريدة
        .slice(0, 4);
    }
  } catch (error) {
    logger.error(`SuggestionManager failed for ${userId}:`, error.message);
  }

  return getDefaultSuggestions();
}

function getDefaultSuggestions() {
  // اقتراحات افتراضية جذابة وقصيرة (بالدارجة)
  return [
    "واش هو الدرس الجاي؟",
    "نديرو كويز خفيف؟ 🔥",
    "فكرني وين حبسنا",
    "لخصلي أهم النقاط"
  ];
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
