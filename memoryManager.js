
'use strict';

// متغيرات سيتم تهيئتها من الملف الرئيسي
let db;
let embeddingService;

const COLLECTION_NAME = 'userMemoryEmbeddings';

/**
 * يقوم بتهيئة مدير الذاكرة وتمرير الخدمات اللازمة.
 * @param {object} initConfig - كائن يحتوي على db و embeddingService.
 */
function init(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService) {
    throw new Error('Memory Manager requires db and embeddingService for initialization.');
  }
  db = initConfig.db;
  embeddingService = initConfig.embeddingService;
  console.log('✅ Memory Manager Initialized.');
}

/**
 * يحفظ رسالة مستخدم كنقطة ذاكرة دلالية جديدة.
 * @param {string} userId - معرّف المستخدم.
 * @param {string} text - نص الرسالة المراد حفظها.
 * @returns {Promise<void>}
 */
async function saveMemoryChunk(userId, text) {
  if (!userId || !text || text.trim().length < 10) { // نتجاهل الرسائل القصيرة جدًا
    return;
  }

  try {
    // 1. إنشاء متجه من النص
    const embedding = await embeddingService.generateEmbedding(text);
    if (embedding.length === 0) return;

    // 2. حفظ الوثيقة في Firestore
    await db.collection(COLLECTION_NAME).add({
      userId: userId,
      originalText: text,
      embedding: embedding,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error(`[Memory Manager] Failed to save memory for user ${userId}:`, error.message);
    // لا نرمي الخطأ للأعلى لأن هذه عملية خلفية
  }
}

module.exports = {
  init,
  saveMemoryChunk,
};
