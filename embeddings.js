
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// متغيرات سيتم تهيئتها من الملف الرئيسي
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
  db = initConfig.db;
  CONFIG = initConfig.CONFIG;

  // نستخدم أول مفتاح API متاح لتهيئة العميل الخاص بالتضمين
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY_1;
  if (!apiKey) {
    throw new Error('No Google API Key found for Embedding service.');
  }
  googleAiClient = new GoogleGenerativeAI(apiKey);
  console.log('✅ Embedding Service Initialized.');
}

/**
 * يحول نصًا إلى متجه تضمين (embedding vector).
 * @param {string} text - النص المراد تحويله.
 * @returns {Promise<number[]>} - مصفوفة من الأرقام تمثل المتجه.
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.warn('generateEmbedding called with empty or invalid text.');
    return []; // أرجع مصفوفة فارغة لتجنب الأخطاء
  }
  try {
    const model = googleAiClient.getGenerativeModel({ model: CONFIG.MODEL.embedding });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    console.error(`[Embedding Service] Failed to generate embedding for text: "${text.substring(0, 50)}..."`, err.message);
    throw err; // أعد رمي الخطأ ليتم التعامل معه في المستوى الأعلى
  }
}

/**
 * يحسب التشابه بين متجهين باستخدام تشابه جيب التمام (Cosine Similarity).
 * @param {number[]} vecA - المتجه الأول.
 * @param {number[]} vecB - المتجه الثاني.
 * @returns {number} - درجة التشابه بين 0 و 1.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

/**
 * يبحث في مجموعة Firestore عن الوثائق الأكثر تشابهًا مع متجه معين.
 * @param {number[]} queryEmbedding - المتجه الخاص بسؤال المستخدم.
 * @param {string} collectionName - اسم المجموعة التي تحتوي على المتجهات (مثل 'curriculumEmbeddings').
 * @param {number} topN - عدد النتائج المراد إرجاعها (مثلاً، أفضل 3).
 * @param {string} [userId] - (اختياري) معرّف المستخدم للفلترة (مفيد للبحث في ذاكرة المستخدم).
 * @returns {Promise<object[]>} - مصفوفة من الوثائق الأكثر تشابهًا.
 */
async function findSimilarEmbeddings(queryEmbedding, collectionName, topN = 3, userId = null) {
  try {
    let query = db.collection(collectionName);
    if (userId) {
      query = query.where('userId', '==', userId);
    }

    // ملاحظة: هذا يجلب كل الوثائق ويقارنها. للإنتاج، قد تحتاج إلى حل أكثر تقدماً.
    // لكن للبداية، هذا الحل يعمل بشكل جيد مع مجموعات بيانات صغيرة إلى متوسطة.
    const snapshot = await query.limit(500).get(); // نضع حداً لتجنب قراءة ملايين الوثائق
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
    console.error(`[Embedding Service] Error finding similar embeddings in "${collectionName}":`, error.message);
    return []; // أرجع مصفوفة فارغة في حالة الفشل
  }
}

module.exports = {
  init,
  generateEmbedding,
  findSimilarEmbeddings,
};
