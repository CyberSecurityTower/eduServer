
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

    // توجيه الطلب للدالة الصحيحة
    if (type === 'curriculum') {
      rpcName = 'match_curriculum';
      params.filter_path_id = filterId; // هنا نمرر pathId
    } else if (type === 'memory') {
      rpcName = 'match_user_memory';
      params.filter_user_id = filterId; // هنا نمرر userId
    } else {
      throw new Error(`Unknown embedding type: ${type}`);
    }

    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) throw error;

    return data.map(doc => ({
      text: doc.content,
      metadata: doc.metadata || {}, // للمنهج فقط
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
