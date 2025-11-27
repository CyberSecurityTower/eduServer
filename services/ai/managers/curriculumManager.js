
// services/ai/managers/curriculumManager.js
'use strict';

const logger = require('../../../utils/logger');

let embeddingServiceRef; // Injected dependency

function initCurriculumManager(dependencies) {
  if (!dependencies.embeddingService) {
    throw new Error('Curriculum Manager requires embeddingService for initialization.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  logger.info('Curriculum Manager initialized.');
}

async function runCurriculumAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) {
      logger.error('runCurriculumAgent: embeddingService is not set.');
      return '';
    }

    // 1. Generate Embedding
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);

    if (!questionEmbedding || questionEmbedding.length === 0) {
      return '';
    }

    // 2. Define Search Parameters
    // TODO: Retrieve pathId dynamically from user profile instead of hardcoding if needed
    const pathId = 'UAlger3_L1_ITCF'; 
    const collectionName = 'curriculum_embeddings'; // Standardized collection name
    const limit = 3;

    // 3. Find Similar Chunks
    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      collectionName,
      limit,
      pathId // Pass pathId as filter
    );

    if (!similarChunks || similarChunks.length === 0) {
      return '';
    }

    // 4. Format Results
    const topContexts = similarChunks.map(chunk => {
      // Handle metadata differences safely
      const title = chunk.metadata?.lesson_title || chunk.lessonTitle || 'درس';
      const content = chunk.text || chunk.content || chunk.chunkText || '';
      return `[المصدر: ${title}]\n${content}`;
    });

    const contextReport = `The user's question appears to be highly related to these specific parts of the curriculum:
---
${topContexts.join('\n---\n')}
---`;

    return contextReport;

  } catch (error) {
    logger.error(`CurriculumAgent failed for user ${userId}:`, error.message);
    return ''; // Return empty string on failure so chat flow doesn't break
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent,
};
