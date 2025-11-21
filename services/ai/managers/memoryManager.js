
// services/ai/managers/memoryManager.js
'use strict';

const { getFirestoreInstance, admin } = require('../../data/firestore');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let db;
let embeddingServiceRef;
let generateWithFailoverRef; // ✅ نحتاج هذا لتحليل النصوص واستخراج المعلومات
const COLLECTION_NAME = 'userMemoryEmbeddings';

// ✅ التحديث: استقبال generateWithFailover
function initMemoryManager(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires db, embeddingService, and generateWithFailover.');
  }
  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;
  logger.success('Memory Manager Initialized (Vector + Structured).');
}

// 1. الذاكرة المتجهة (Vector Memory) - للبحث العام
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

// 2. استرجاع الذاكرة المتجهة
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

// 3. ✅ (الجديد) الذاكرة الهيكلية - لاستخراج الحقائق والمشاعر
async function analyzeAndSaveMemory(userId, history) {
  try {
    // نأخذ آخر جزء من المحادثة للتحليل
    const recentChat = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
    
    const prompt = `
    Analyze this conversation segment. Extract specific FACTS about the user and organize them.
    
    **Categories:**
    - **emotions**: Current mood (stressed, confident, happy).
    - **family**: Mentions of parents, siblings, names.
    - **preferences**: Favorite music, food, subject, hobbies.
    - **goals**: Academic or personal goals.
    
    **Also:** Write a short "Note to Self" for the AI to use in the NEXT conversation (e.g., "Ask about the math test result").

    **Conversation:**
    ${recentChat}

    **Output JSON ONLY:**
    {
      "facts": {
        "emotions": ["..."],
        "family": ["..."],
        "preferences": ["..."],
        "goals": ["..."]
      },
      "noteToSelf": "..."
    }
    Return {} if nothing significant found.
    `;

    // نستخدم نموذج التحليل
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtractor' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data) {
      const updates = {};
      let hasUpdates = false;

      // تحديث الحقائق (باستخدام arrayUnion لعدم تكرار البيانات)
      if (data.facts) {
        for (const [category, items] of Object.entries(data.facts)) {
          if (Array.isArray(items) && items.length > 0) {
            // نخزنها في حقل: memory.preferences, memory.family ...
            updates[`memory.${category}`] = admin.firestore.FieldValue.arrayUnion(...items);
            hasUpdates = true;
            logger.info(`[Memory] Learned ${category}: ${items.join(', ')}`);
          }
        }
      }

      // تحديث الملاحظة للمستقبل
      if (data.noteToSelf) {
        updates['aiNoteToSelf'] = data.noteToSelf;
        hasUpdates = true;
      }

      // الحفظ في وثيقة المستخدم
      if (hasUpdates) {
        await db.collection('users').doc(userId).set(updates, { merge: true });
      }
    }

  } catch (error) {
    logger.error(`[Memory] Structured Analysis failed: ${error.message}`);
  }
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory // ✅ الآن موجودة ومصدرة
};
