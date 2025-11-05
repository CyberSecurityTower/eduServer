
// services/ai/managers/memoryManager.js (Updated)
'use strict';

// متغيرات سيتم تهيئتها من الملف الرئيسي
let db;
let embeddingServiceRef; // Changed to Ref to indicate it's an injected dependency

const COLLECTION_NAME = 'userMemoryEmbeddings';
const logger = require('../../../utils/logger'); // Add logger

/**
 * يقوم بتهيئة مدير الذاكرة وتمرير الخدمات اللازمة.
 * @param {object} initConfig - كائن يحتوي على db و embeddingService.
 */
function init(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService) {
    throw new Error('Memory Manager requires db and embeddingService for initialization.');
  }
  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService; // Assign to the Ref
  logger.success('Memory Manager Initialized.');
}

/**
 * يحفظ رسالة مستخدم كنقطة ذاكرة دلالية جديدة.
 * @param {string} userId - معرّف المستخدم.
 * @param {string} text - نص الرسالة المراد حفظها.
 * @returns {Promise<void>}
 */
async function saveMemoryChunk(userId, text) {
  if (!userId || !text || text.trim().length < 10) {
    return;
  }

  try {
    if (!embeddingServiceRef) {
      logger.error('saveMemoryChunk: embeddingService is not set.');
      return;
    }
    const embedding = await embeddingServiceRef.generateEmbedding(text);
    if (embedding.length === 0) return;

    await db.collection(COLLECTION_NAME).add({
      userId: userId,
      originalText: text,
      embedding: embedding,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error(`[Memory Manager] Failed to save memory for user ${userId}:`, error.message);
  }
}

module.exports = {
  init,
  saveMemoryChunk,
};
