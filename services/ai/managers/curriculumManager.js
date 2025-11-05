
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
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (questionEmbedding.length === 0) return '';

    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      'curriculumEmbeddings',
      3
    );

    if (similarChunks.length === 0) {
      return '';
    }

    const topContexts = similarChunks.map(chunk => chunk.chunkText);

    const contextReport = `The user's question appears to be highly related to these specific parts of the curriculum:
---
${topContexts.join('\n---\n')}
---`;

    return contextReport;

  } catch (error) {
    logger.error(`CurriculumAgent failed for user ${userId}:`, error.message);
    return '';
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent,
};
