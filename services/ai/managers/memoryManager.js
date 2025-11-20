
// services/ai/managers/memoryManager.js
'use strict';

const { safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');

let db;
let embeddingServiceRef;
const COLLECTION_NAME = 'userMemoryEmbeddings';

// ✅ التصحيح: تغيير اسم الدالة من init إلى initMemoryManager لتتوافق مع index.js
function initMemoryManager(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService) {
    throw new Error('Memory Manager requires db and embeddingService.');
  }
  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService;
  logger.success('Memory Manager Initialized.');
}

async function saveMemoryChunk(userId, text) {
  if (!userId || !text || text.trim().length < 10) return;
  try {
    if (!embeddingServiceRef) return;
    const embedding = await embeddingServiceRef.generateEmbedding(text);
    if (!embedding.length) return;

    await db.collection(COLLECTION_NAME).add({
      userId,
      originalText: text,
      embedding,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[Memory] Save failed: ${error.message}`);
  }
}

async function runMemoryAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) return '';
    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding.length) return '';

    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding, COLLECTION_NAME, 5, userId
    );

    if (!similar.length) return '';

    return `Relevant Past Context:\n` +
      similar.map(m => `- "${safeSnippet(m.originalText, 100)}"`).join('\n');
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

module.exports = {
  initMemoryManager, // ✅ تأكد أن هذا الاسم يطابق ما تستدعيه في index.js
  saveMemoryChunk,
  runMemoryAgent,
};
