
// services/embeddings.js
'use strict';

// 👇 استخدام المكتبة الجديدة (Google GenAI SDK v1.0+)
const { GoogleGenAI } = require('@google/genai');
const supabase = require('./data/supabase');
const logger = require('../utils/logger');

let CONFIG;
let googleAiClient;

/**
 * تهيئة خدمة التضمين وإعداد عميل Google AI
 * @param {Object} initConfig - كائن الإعدادات الذي يحتوي على CONFIG
 */
function init(initConfig) {
  CONFIG = initConfig.CONFIG;

  if (!process.env.GOOGLE_API_KEY) {
    logger.error('Embeddings Service: Missing GOOGLE_API_KEY in environment variables.');
    return;
  }

  try {
    // تهيئة العميل بالمفتاح الأساسي
    googleAiClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    // logger.info('Google GenAI Client initialized successfully.');
  } catch (error) {
    logger.error('Embeddings Service: Failed to initialize Google GenAI client:', error.message);
  }
}

/**
 * توليد Embedding لنص معين باستخدام نموذج text-embedding-004
 * @param {string} text - النص المراد تحويله
 * @returns {Promise<number[]>} - مصفوفة الأرقام التي تمثل التضمين
 */
async function generateEmbedding(text) {
  try {
    if (!googleAiClient) {
      throw new Error('Google AI Client is not initialized. Call init() first.');
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return [];
    }

    // تنظيف النص: استبدال الأسطر الجديدة بمسافات لتحسين دقة النموذج
    const cleanText = text.replace(/\n/g, ' ');

    // 👇 الاستدعاء باستخدام هيكلية المكتبة الجديدة
    const result = await googleAiClient.models.embedContent({
      model: 'text-embedding-004',
      content: {
        parts: [{ text: cleanText }]
      }
    });

    // التحقق من وجود القيم وإرجاعها
    if (result && result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    
    return [];

  } catch (err) {
    logger.error('Embedding generation failed:', err.message);
    return [];
  }
}

/**
 * البحث عن نصوص مشابهة في قاعدة البيانات (Supabase Vector Search)
 * @param {number[]} queryEmbedding - متجه البحث
 * @param {string} type - نوع البحث (curriculum أو memory)
 * @param {number} topN - عدد النتائج المطلوبة
 * @param {string|number} filterId - معرف للتصفية (path_id أو user_id)
 * @param {number} minScore - أقل نسبة تشابه مقبولة
 */
async function findSimilarEmbeddings(queryEmbedding, type, topN = 5, filterId = null, minScore = 0.50) {
  try {
    let rpcName;
    let params = {
      query_embedding: queryEmbedding,
      match_threshold: minScore,
      match_count: topN
    };

    // تحديد الدالة والمعاملات بناءً على النوع (يدعم الاسم القصير واسم الجدول)
    if (type === 'curriculum' || type === 'curriculum_embeddings') {
      rpcName = 'match_curriculum';
      // نمرر filter_path_id فقط إذا كان له قيمة
      params.filter_path_id = filterId; 
    } else if (type === 'memory' || type === 'user_memory_embeddings') {
      rpcName = 'match_user_memory';
      // نمرر filter_user_id فقط إذا كان له قيمة
      params.filter_user_id = filterId;
    } else {
      throw new Error(`Unknown embedding type provided: ${type}`);
    }

    // استدعاء دالة RPC في Supabase
    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) throw error;

    if (!data || data.length === 0) return [];

    // تنسيق النتائج
    return data.map(doc => ({
      text: doc.content, // التأكد من أن العمود في قاعدة البيانات اسمه content
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
