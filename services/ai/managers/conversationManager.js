
// services/ai/managers/conversationManager.js
'use strict';

const { getFirestoreInstance } = require('../../data/firestore');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initConversationManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Conversation Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Conversation Manager initialized.');
}

const db = getFirestoreInstance();

async function runConversationAgent(userId, userMessage) {
  try {
    const sessionsSnapshot = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .orderBy('updatedAt', 'desc')
      .limit(3)
      .get();

    if (sessionsSnapshot.empty) return '';

    let recentHistory = [];
    sessionsSnapshot.forEach(doc => {
      const messages = doc.data().messages || [];
      recentHistory.push(...messages);
    });

    recentHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const conversationSnippet = recentHistory.slice(-50).map(m => `${m.author}: ${m.text}`).join('\n');

    if (!conversationSnippet) return '';

    const prompt = `You are a conversation analyst with perfect short-term memory.
    Your job is to find the single most relevant exchange from the recent conversation history that relates to the user's new question.
    Focus on the semantic meaning and context.

    <recent_conversation_history>
    ${conversationSnippet}
    </recent_conversation_history>

    <user_new_question>
    "${userMessage}"
    </user_new_question>

    If you find a relevant exchange, summarize its key point in one concise sentence.
    Respond ONLY with a JSON object: { "summary": "..." }.
    Example: { "summary": "Yesterday, the user was confused about the practical application of this economic theory." }
    If nothing is relevant, return an empty JSON object: {}.`;

    if (!generateWithFailoverRef) {
      logger.error('runConversationAgent: generateWithFailover is not set.');
      return '';
    }
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'ConversationAgent', timeoutMs: 25000 });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.summary) {
      return parsed.summary;
    }

    return '';

  } catch (error) {
    logger.error(`ConversationAgent failed for user ${userId}:`, error.message);
    return '';
  }
}

module.exports = {
  initConversationManager,
  runConversationAgent,
};
