
// services/embeddings.js
'use strict';

const { GoogleGenAI } = require('@google/genai');
const supabase = require('./data/supabase'); // تأكد من المسار الصحيح حسب هيكلتك
const logger = require('../utils/logger');

let CONFIG;
let googleAiClient;

function init(initConfig) {
  CONFIG = initConfig.CONFIG;

  if (!process.env.GOOGLE_API_KEY) {
    logger.error('Embeddings Service: Missing GOOGLE_API_KEY in environment variables.');
    return;
  }

  try {
    googleAiClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  } catch (error) {
    logger.error('Embeddings Service: Failed to initialize Google GenAI client:', error.message);
  }
}

async function generateEmbedding(text) {
  try {
    if (!googleAiClient) {
      throw new Error('Google AI Client is not initialized. Call init() first.');
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return [];
    }

    const cleanText = text.replace(/\n/g, ' ');

    // 🔥 التعديل هنا: استخدام contents (مصفوفة) بدلاً من content (كائن)
    const result = await googleAiClient.models.embedContent({
      model: 'text-embedding-004',
      contents: [
        {
          parts: [{ text: cleanText }]
        }
      ]
    });

    if (result && result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    
    return [];

  } catch (err) {
    logger.error('Embedding generation failed:', err.message);
    return [];
  }
}

async function findSimilarEmbeddings(queryEmbedding, type, topN = 5, filterId = null, minScore = 0.50) {
  try {
    let rpcName;
    let params = {
      query_embedding: queryEmbedding,
      match_threshold: minScore,
      match_count: topN
    };

    if (type === 'curriculum' || type === 'curriculum_embeddings') {
      rpcName = 'match_curriculum';
      params.filter_path_id = filterId; 
    } else if (type === 'memory' || type === 'user_memory_embeddings') {
      rpcName = 'match_user_memory';
      params.filter_user_id = filterId;
    } else {
      throw new Error(`Unknown embedding type provided: ${type}`);
    }

    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) throw error;

    if (!data || data.length === 0) return [];

    return data.map(doc => ({
      text: doc.content,
      metadata: doc.metadata || {},
      score: doc.similarity
    }));

  } catch (error) {
    logger.error(`Vector Search Error (${type}):`, error.message);
    return [];
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
