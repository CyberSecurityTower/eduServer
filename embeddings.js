
// services/embeddings.js
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getFirestoreInstance } = require('./data/firestore'); // Import Firestore instance
const logger = require('../utils/logger'); // Add logger

let db;
let CONFIG;
let googleAiClient;

/**
 * يقوم بتهيئة الخدمة وتمرير الإعدادات وقاعدة البيانات من الملف الرئيسي.
 * @param {object} initConfig - كائن يحتوي على db و CONFIG.
 */
function init(initConfig) {
  if (!initConfig.db || !initConfig.CONFIG) {
    throw new Error('Embedding service requires db and CONFIG for initialization.');
  }
  db = initConfig.db; // Use the injected db instance
  CONFIG = initConfig.CONFIG;

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY_1;
  if (!apiKey) {
    throw new Error('No Google API Key found for Embedding service.');
  }
  googleAiClient = new GoogleGenerativeAI(apiKey);
  logger.success('Embedding Service Initialized.');
}

async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    logger.warn('generateEmbedding called with empty or invalid text.');
    return [];
  }
  try {
    const model = googleAiClient.getGenerativeModel({ model: CONFIG.MODEL.embedding });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    logger.error(`[Embedding Service] Failed to generate embedding for text: "${text.substring(0, 50)}..."`, err.message);
    throw err;
  }
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

async function findSimilarEmbeddings(queryEmbedding, collectionName, topN = 3, userId = null) {
  try {
    const dbInstance = getFirestoreInstance(); // Ensure db is initialized
    let query = dbInstance.collection(collectionName);
    if (userId) {
      query = query.where('userId', '==', userId);
    }

    const snapshot = await query.limit(500).get();
    if (snapshot.empty) return [];

    const similarities = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.embedding && Array.isArray(data.embedding)) {
        const similarity = cosineSimilarity(queryEmbedding, data.embedding);
        similarities.push({ ...data, score: similarity });
      }
    });

    similarities.sort((a, b) => b.score - a.score);
    return similarities.slice(0, topN);

  } catch (error) {
    logger.error(`[Embedding Service] Error finding similar embeddings in "${collectionName}":`, error.message);
    return [];
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
