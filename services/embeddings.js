
// services/embeddings.js
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getFirestoreInstance } = require('./data/firestore');
const logger = require('../utils/logger');

let db;
let CONFIG;
let googleAiClient;

function init(initConfig) {
  db = initConfig.db;
  CONFIG = initConfig.CONFIG;
  const apiKey = process.env.GOOGLE_API_KEY;
  googleAiClient = new GoogleGenerativeAI(apiKey);
}

async function generateEmbedding(text) {
  try {
    if (!text) return [];
    const model = googleAiClient.getGenerativeModel({ model: CONFIG.MODEL.embedding });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    logger.error('Embedding generation failed:', err.message);
    return [];
  }
}

// دالة حساب التشابه الرياضية
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

/**
 * ✅ النسخة المحسنة: البحث الدقيق
 * @param {number} minScore - أقل نسبة تشابه مقبولة (0.0 - 1.0)
 */

/**
 * ✅ النسخة المحسنة: البحث الدقيق والمرن
 * تم تعديل minScore ليصبح 0.55 بدلاً من 0.70 لالتقاط المعاني الضمنية بشكل أفضل
 */
async function findSimilarEmbeddings(queryEmbedding, collectionName, topN = 5, userId = null, minScore = 0.55) {
  try {
    const dbInstance = getFirestoreInstance();
    let query = dbInstance.collection(collectionName);
    
    if (userId) {
      // نبحث في آخر 300 ذكرى (بدلاً من 200) لزيادة المدى
      query = query.where('userId', '==', userId).orderBy('timestamp', 'desc').limit(400); 
    } else {
      query = query.limit(500); 
    }

    const snapshot = await query.get();
    if (snapshot.empty) return [];

    const similarities = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.embedding) {
        const score = cosineSimilarity(queryEmbedding, data.embedding);
        
        // إذا وجدنا تطابقاً
        if (score >= minScore) {
            similarities.push({ ...data, score });
        }
      }
    });

    // ترتيب تنازلي حسب الأفضل
    similarities.sort((a, b) => b.score - a.score);
    
    // إرجاع أفضل النتائج
    return similarities.slice(0, topN);

  } catch (error) {
    logger.error(`Similarity search failed in ${collectionName}:`, error.message);
    return [];
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
