
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');
const { safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');

let embeddingServiceRef = null;
let generateWithFailoverRef = null;

const COLLECTION_NAME = 'user_memory_embeddings';

function initMemoryManager(initConfig = {}) {
  if (!initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires embeddingService and generateWithFailover.');
  }
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;
  logger.info('Memory Manager Initialized (Supabase Native).');
}

// 1. Vector Memory
async function saveMemoryChunk(userId, userMessage, aiReply) {
  try {
    if (!embeddingServiceRef) return;

    const combinedText = `User: ${userMessage}\nAI: ${aiReply}`;
    const embedding = await embeddingServiceRef.generateEmbedding(combinedText);

    if (!embedding || embedding.length === 0) return;

    // Supabase Insert
    const { error } = await supabase.from(COLLECTION_NAME).insert({
      user_id: userId,
      original_text: combinedText,
      embedding: embedding, // Supabase pgvector accepts array directly
      timestamp: nowISO(),
      type: 'conversation_exchange'
    });

    if (error) logger.warn(`[Memory] Insert failed: ${error.message}`);
  } catch (err) {
    logger.error(`[Memory] saveMemoryChunk error: ${err.message}`);
  }
}

async function runMemoryAgent(userId, userMessage, topK = 4) {
  try {
    if (!embeddingServiceRef) return '';

    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding.length) return '';

    // RPC Call for Vector Search
    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding,
      COLLECTION_NAME,
      topK,
      userId
    );

    if (!similar || similar.length === 0) return '';

    const formatted = similar.map((m, i) => {
      return `[Memory ${i + 1}]: ${safeSnippet(m.originalText, 300)}`;
    }).join('\n');

    return `🧠 **RELEVANT MEMORIES:**\n${formatted}`;
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// 2. Structured Memory (Wrapper around helper)
async function analyzeAndSaveMemory(userId, history, activeMissions) {
   // تم نقل المنطق الرئيسي إلى helpers.js لتفادي التكرار والتعقيد الدوري
   // ولكن نبقي هذه الدالة كواجهة (Interface) للمتحكمات
   const { analyzeAndSaveMemory: helperAnalyze } = require('../../data/helpers');
   return helperAnalyze(userId, history);
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory
};
