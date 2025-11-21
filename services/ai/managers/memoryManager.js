
// services/ai/managers/memoryManager.js
'use strict';

const { getFirestoreInstance, admin } = require('../../data/firestore');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let db;
let embeddingServiceRef;
let generateWithFailoverRef;

const COLLECTION_NAME = 'userMemoryEmbeddings';

// ✅ تهيئة المدير مع التبعيات اللازمة
function initMemoryManager(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires db, embeddingService, and generateWithFailover.');
  }
  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;
  logger.success('Memory Manager Initialized (Vector + Temporal Structured).');
}

// 1. الذاكرة المتجهة (Vector Memory) - للبحث العام في الأرشيف
async function saveMemoryChunk(userId, text) {
  if (!userId || !text || text.trim().length < 10) return;
  try {
    if (!embeddingServiceRef) return;
    const embedding = await embeddingServiceRef.generateEmbedding(text);
    if (!embedding.length) return;

    await db.collection(COLLECTION_NAME).add({
      userId,
      originalText: text,
      embedding,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[Memory] Vector Save failed: ${error.message}`);
  }
}

// 2. استرجاع الذاكرة المتجهة (للسياق العام)
async function runMemoryAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) return '';
    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding.length) return '';

    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding, COLLECTION_NAME, 3, userId
    );

    if (!similar.length) return '';

    return `Relevant Past Context:\n` +
      similar.map(m => `- "${safeSnippet(m.originalText, 100)}"`).join('\n');
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// 3. ✅ الذاكرة الهيكلية الزمنية (Temporal Structured Memory)
// تستخرج الحقائق والمشاعر وتربطها بوقت حدوثها
async function analyzeAndSaveMemory(userId, history) {
  try {
    // نأخذ آخر جزء من المحادثة للتحليل
    const recentChat = history.slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');
    
    const prompt = `
    Analyze the conversation deeply. Extract TIMED FACTS about the user.
    
    **Categories:**
    1. **emotions**: Current mood (Sad, Excited, Angry, Stressed).
    2. **romance**: Crushes, relationships, heartbreaks.
    3. **preferences**: Fav music (e.g., Rai, Rap), food, hobbies.
    4. **family**: Parents, siblings, friends.
    5. **struggles**: Academic or personal problems.

    **Also:** Write a "Note to Self" (optional) for the next conversation.

    **Input Transcript:**
    ${recentChat}

    **Output JSON ONLY:**
    {
      "newFacts": [
        { "category": "emotions", "text": "Feeling down because of a fight with dad" },
        { "category": "preferences", "text": "Loves eating Mahjouba" }
      ],
      "noteToSelf": "Ask him if he made up with his dad next time."
    }
    `;

    // نستخدم نموذج التحليل (Flash أو Pro حسب التوفر)
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtractor' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data && data.newFacts && Array.isArray(data.newFacts) && data.newFacts.length > 0) {
      const updates = {};
      const now = new Date().toISOString(); // ⏰ الوقت الحالي للسيرفر

      // معالجة كل حقيقة وإضافة الزمن لها
      data.newFacts.forEach(fact => {
        if (fact.category && fact.text) {
          const memoryObject = {
            value: fact.text,   // المعلومة
            timestamp: now      // 🕒 متى عرفنا هذه المعلومة
          };
          
          // نستخدم arrayUnion لإضافتها للقائمة المناسبة في وثيقة المستخدم
          // مثال: memory.emotions, memory.romance
          updates[`memory.${fact.category}`] = admin.firestore.FieldValue.arrayUnion(memoryObject);
          
          logger.info(`[Memory] Learned (${fact.category}): "${fact.text}" at ${now}`);
        }
      });

      // تحديث الملاحظة المستقبلية
      if (data.noteToSelf) {
        updates['aiNoteToSelf'] = data.noteToSelf;
      }

      // الحفظ في وثيقة المستخدم الرئيسية
      await db.collection('users').doc(userId).set(updates, { merge: true });
    }

  } catch (error) {
    logger.error(`[Memory] Structured Analysis failed: ${error.message}`);
  }
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory
};
