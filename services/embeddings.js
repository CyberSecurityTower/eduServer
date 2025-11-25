
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabase = require('./data/supabase'); // Supabase client
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
    const model = googleAiClient.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    logger.error('Embedding generation failed:', err.message);
    return [];
  }
}

/**
 * دالة البحث عن الفيكتور في Supabase
 * تتطلب وجود دالة في قاعدة البيانات (Postgres Function) اسمها 'match_memory'
 */
async function findSimilarEmbeddings(queryEmbedding, collectionName, topN = 5, userId = null, minScore = 0.55) {
  try {
    // استدعاء دالة RPC في Supabase
    // match_memory هي دالة PL/pgSQL يجب أن تكون قد أنشأتها في لوحة تحكم Supabase
    const { data: documents, error } = await supabase.rpc('match_memory', {
      query_embedding: queryEmbedding,
      match_threshold: minScore,
      match_count: topN,
      filter_user_id: userId
    });

    if (error) throw error;

    return documents.map(doc => ({
      originalText: doc.original_text, // تأكد من اسم العمود في جدولك
      score: doc.similarity
    }));

  } catch (error) {
    logger.error('Supabase Vector Search Error:', error.message);
    return [];
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
