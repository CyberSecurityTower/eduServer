
// services/ai/managers/suggestionManager.js
'use strict';

const { getProfile, getProgress, fetchUserWeaknesses, fetchRecentComprehensiveChatHistory } = require('../../data/helpers');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initSuggestionManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Suggestion Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Suggestion Manager initialized.');
}

async function runSuggestionManager(userId) {
  const [profile, progress, weaknesses, conversationTranscript] = await Promise.all([
    getProfile(userId),
    getProgress(userId),
    fetchUserWeaknesses(userId),
    fetchRecentComprehensiveChatHistory(userId)
  ]);

  const profileSummary = profile?.profileSummary || 'لا يوجد ملخص للملف الشخصي.';
  const currentTasks = progress?.dailyTasks?.tasks?.map(t => `- ${t.title} (${t.status})`).join('\n') || 'لا توجد مهام حالية.';
  const weaknessesSummary = (weaknesses || []).map(w => w.lessonTitle).join(', ') || 'لا توجد نقاط ضعف محددة.';

  const prompt = `You are a prediction engine. Your task is to anticipate 4 highly relevant, diverse, and constructive questions a user might ask.

  <user_context>
    <long_term_profile_summary>${profileSummary}</long_term_profile_summary>
    <current_academic_tasks>${currentTasks}</current_academic_tasks>
    <identified_academic_weaknesses>${weaknessesSummary}</identified_academic_weaknesses>
    <recent_conversation_transcript>
    ${conversationTranscript}
    </recent_conversation_transcript>
  </user_context>

  <instructions>
  1.  **Generate 4 distinct suggestions** phrased as questions FROM THE USER'S PERSPECTIVE.
  2.  **CRITICAL: AVOID** illogical, negative, or self-destructive questions like "how to forget a topic?". All suggestions must be helpful and proactive.
  3.  **Suggestion Mix (Mandatory):**
      *   **Suggestion 1 (Capability):** Suggest a core feature you can perform. MUST be one of: "أنشئ لي خطة دراسية", "حلل أدائي الأكاديمي", "لخص لي آخر محادثة".
      *   **Suggestion 2 (Contextual Academic):** A specific question about a pending task or a known weakness from the user's context.
      *   **Suggestion 3 (General Knowledge):** A broad, curious question related to the user's general field of study but NOT a specific lesson. (e.g., "ما علاقة الاقتصاد بالسياسة؟").
      *   **Suggestion 4 (Personal/Follow-up):** A question based on the emotional tone of the last conversation, or a follow-up to a topic that was left open.
  4.  **Strict Formatting:**
      *   Each question must be a maximum of 9 words.
      *   The language must be natural Arabic.
      *   Respond ONLY with a valid JSON object: { "suggestions": ["...", "...", "...", "..."] }
  </instructions>

  <example_output>
  {
    "suggestions": ["أنشئ لي خطة دراسية للأسبوع", "كيف أراجع درس الندرة بفعالية؟", "ما العلاقة بين الاقتصاد وعلم النفس؟", "هل يمكننا إكمال نقاش الأمس؟"]
  }
  </example_output>`;

  try {
    if (!generateWithFailoverRef) {
      logger.error('runSuggestionManager: generateWithFailover is not set.');
      return ["أنشئ لي خطة دراسية", "حلل أدائي الدراسي", "ما هي مهامي المتبقية؟", "ذكرني بأهدافي الدراسية"];
    }
    const res = await generateWithFailoverRef('suggestion', prompt, { label: 'SuggestionManager' });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length === 4) {
      return parsed.suggestions;
    }
  } catch (error) {
    logger.error(`runSuggestionManager failed for user ${userId}:`, error);
  }

  return ["أنشئ لي خطة دراسية", "حلل أدائي الدراسي", "ما هي مهامي المتبقية؟", "ذكرني بأهدافي الدراسية"];
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
