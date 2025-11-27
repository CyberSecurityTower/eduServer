
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
async function findSimilarEmbeddings(queryEmbedding, collectionName, topN = 5, filterId = null, minScore = 0.50) {
  try {
    let rpcFunctionName;
    let params = {
      query_embedding: queryEmbedding,
      match_threshold: minScore,
      match_count: topN
    };

    // تحديد الدالة المناسبة بناءً على اسم الجدول
    if (collectionName === 'user_memory_embeddings') {
      rpcFunctionName = 'match_user_memory';
      params.filter_user_id = filterId; // هنا نمرر userId
    } else if (collectionName === 'curriculum_embeddings') {
      rpcFunctionName = 'match_curriculum';
      // params.filter_path_id = filterId; // يمكن تفعيلها إذا أردت فلترة المنهج
    } else {
      throw new Error(`Unknown collection for vector search: ${collectionName}`);
    }

    // استدعاء الدالة في Supabase
    const { data: documents, error } = await supabase.rpc(rpcFunctionName, params);

    if (error) throw error;

    // توحيد شكل المخرجات
    return documents.map(doc => ({
      originalText: doc.original_text || doc.chunk_text, // التعامل مع اختلاف أسماء الأعمدة
      lessonTitle: doc.lesson_title || null,
      score: doc.similarity
    }));

  } catch (error) {
    logger.error(`Supabase Vector Search Error (${collectionName}):`, error.message);
    return [];
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
