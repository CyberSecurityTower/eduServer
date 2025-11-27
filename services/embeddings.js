
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabase = require('./data/supabase');
const logger = require('../utils/logger');

let CONFIG;
let googleAiClient;

function init(initConfig) {
  CONFIG = initConfig.CONFIG;
  googleAiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
}

async function generateEmbedding(text) {
  try {
    if (!text) return [];
    // تنظيف النص قليلاً قبل التضمين
    const cleanText = text.replace(/\n/g, ' ');
    const model = googleAiClient.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(cleanText);
    return result.embedding.values;
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

    // ✅ التعديل هنا: نقبل الاسم القصير أو اسم الجدول الكامل
    if (type === 'curriculum' || type === 'curriculum_embeddings') {
      rpcName = 'match_curriculum';
      params.filter_path_id = filterId;
    } else if (type === 'memory' || type === 'user_memory_embeddings') {
      rpcName = 'match_user_memory';
      params.filter_user_id = filterId;
    } else {
      throw new Error(`Unknown embedding type: ${type}`);
    }

    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) throw error;

    return data.map(doc => ({
      text: doc.content, // تأكدنا في SQL أن العمود اسمه content
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
