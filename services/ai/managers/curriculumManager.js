
// services/ai/managers/curriculumManager.js
'use strict';

const logger = require('../../../utils/logger');

let embeddingServiceRef; // Injected dependency

/**
 * تهيئة مدير المناهج وحقن التبعيات اللازمة
 * @param {Object} dependencies 
 */
function initCurriculumManager(dependencies) {
  if (!dependencies.embeddingService) {
    throw new Error('Curriculum Manager requires embeddingService for initialization.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  logger.info('Curriculum Manager initialized.');
}

/**
 * البحث في المنهج الدراسي عن سياق ذي صلة برسالة المستخدم
 * @param {string} userId - معرف المستخدم
 * @param {string} userMessage - رسالة المستخدم
 * @param {Object} [userContext] - سياق المستخدم (اختياري لتحديد المسار الدراسي)
 * @returns {Promise<string>} - النص السياقي من المنهج أو نص فارغ
 */
async function runCurriculumAgent(userId, userMessage, userContext = {}) {
  try {
    // 1. Validation checks
    if (!embeddingServiceRef) {
      logger.warn('runCurriculumAgent: embeddingService is not initialized.');
      return '';
    }

    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return '';
    }

    // 2. Generate Embedding for the query
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);

    if (!questionEmbedding || questionEmbedding.length === 0) {
      return '';
    }

    // 3. Define Search Parameters
    // TODO: Retrieve pathId dynamically from user profile/context. Using default for now.
    const pathId = userContext.pathId || 'UAlger3_L1_ITCF'; 
    const collectionName = 'curriculum_embeddings';
    const limit = 3;

    // 4. Find Similar Chunks (Vector Search)
    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      collectionName,
      limit,
      pathId // Filter by educational path
    );

    if (!similarChunks || similarChunks.length === 0) {
      return '';
    }

    // 5. Format Results for the AI
    // ندمج العنوان مع المحتوى ليعرف الـ AI من أي درس جاءت المعلومة
    const formattedContext = similarChunks.map((chunk, index) => {
      const title = chunk.metadata?.lesson_title || chunk.lessonTitle || 'General Topic';
      const content = chunk.text || chunk.content || '';
      return `[Source ${index + 1}: ${title}]\n${content}`;
    }).join('\n\n---\n\n');

    return `Relevant Curriculum Context:\n${formattedContext}`;

  } catch (error) {
    // نسجل الخطأ ولكن لا نوقف المحادثة، نرجع نصاً فارغاً فقط
    logger.error(`CurriculumAgent failed for user ${userId}: ${error.message}`);
    return ''; 
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent
};
