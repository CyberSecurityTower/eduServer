
// services/ai/managers/curriculumManager.js
'use strict';
const logger = require('../../../utils/logger');
let embeddingServiceRef;

function initCurriculumManager(dependencies) {
  embeddingServiceRef = dependencies.embeddingService;
}

// ✅ فقط وظيفة البحث (RAG) بقيت هنا
async function runCurriculumAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) return '';
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!questionEmbedding.length) return '';

    // البحث في المنهج
    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      'curriculum_embeddings',
      3,
      'UAlger3_L1_ITCF' // يمكن جعله ديناميكياً لاحقاً
    );

    if (!similarChunks.length) return '';

    return `Curriculum Context:\n${similarChunks.map(c => c.text).join('\n---\n')}`;
  } catch (error) {
    logger.error('CurriculumAgent error:', error.message);
    return '';
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent
};
