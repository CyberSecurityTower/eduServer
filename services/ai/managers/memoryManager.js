
// services/ai/managers/memoryManager.js
'use strict';

const { getFirestoreInstance, admin } = require('../../data/firestore');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let db;
let embeddingServiceRef;
let generateWithFailoverRef;

const COLLECTION_NAME = 'userMemoryEmbeddings';

// ✅ تهيئة المدير
function initMemoryManager(initConfig) {
  if (!initConfig.db || !initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires db, embeddingService, and generateWithFailover.');
  }
  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;
  logger.success('Memory Manager Initialized (Vector + Structured + Context).');
}

// ============================================================================
// 1. الذاكرة المتجهة (Vector Memory) - للبحث العام
// ============================================================================

/**
 * نقوم الآن بحفظ "تبادل كامل" (User + AI) لضمان ترابط المعنى
 */
async function saveMemoryChunk(userId, userMessage, aiReply) {
  // دمج السؤال والجواب يعطي الـ Embedding قوة أكبر في الربط المستقبلي
  const combinedText = `User: ${userMessage}\nAI: ${aiReply}`;
  
  if (!userId || !combinedText || combinedText.length < 15) return;

  try {
    if (!embeddingServiceRef) return;
    
    // توليد المتجه للنص المدمج
    const embedding = await embeddingServiceRef.generateEmbedding(combinedText);
    if (!embedding.length) return;

    await db.collection(COLLECTION_NAME).add({
      userId,
      originalText: combinedText, // نحفظ النص الكامل
      userQuery: userMessage,     // نحفظ السؤال للتصنيف (اختياري)
      embedding,
      timestamp: new Date().toISOString(),
      type: 'conversation_history' 
    });
    
    logger.success(`[Memory] Saved Contextual Chunk for user ${userId}`);
  } catch (error) {
    logger.error(`[Memory] Vector Save failed: ${error.message}`);
  }
}

// استرجاع الذاكرة (تم تحسين العرض في الـ Prompt)
async function runMemoryAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) return '';
    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding.length) return '';

    // نبحث عن أقوى 4 ذكريات مرتبطة
    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding, COLLECTION_NAME, 4, userId
    );

    if (!similar.length) return '';

    // تنسيق الذكريات ليفهمها الـ AI بوضوح
    return `🧠 **RELEVANT MEMORIES FOUND:**\n` +
      similar.map((m, i) => `[Memory ${i+1}]: ${safeSnippet(m.originalText, 300)}`).join('\n') + 
      `\n(Use these memories to answer if the user asks about the past).`;
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// ============================================================================
// 2. الذاكرة الهيكلية الزمنية (Temporal Structured Memory)
// ============================================================================
async function analyzeAndSaveMemory(userId, history, activeMissions = []) {
  try {
    // نأخذ آخر جزء من المحادثة للتحليل
    const recentChat = history.slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');
    
    const prompt = `
    Analyze the conversation deeply. 
    
    **GOAL 1: Extract TIMED FACTS:**
    - **emotions**: Current mood (Sad, Excited, Angry, Stressed).
    - **romance**: Crushes, relationships.
    - **preferences**: Fav music, food, hobbies.
    - **family**: Parents, siblings.
    - **struggles**: Academic or personal problems.

    **GOAL 2: DETECT MYSTERIES (Discovery Missions):**
    - Did the user mention an event/emotion WITHOUT explaining "Why"? 
    - Current Active Missions: ${JSON.stringify(activeMissions)}
    - If a mission is SOLVED by this chat, add to "completedMissions".
    - If a NEW mystery appears, add to "newMissions".

    **Input Transcript:**
    ${recentChat}

    **Output JSON ONLY:**
    {
      "newFacts": [
        { "category": "emotions", "text": "Feeling down because of fight with dad" }
      ],
      "newMissions": ["Find out why he fought with dad"],
      "completedMissions": [],
      "noteToSelf": "Check on his mood next time."
    }
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtractor' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data) {
      const updates = {};
      const now = new Date().toISOString();
      let hasUpdates = false;

      // 1. حفظ الحقائق مع الزمن
      if (data.newFacts && Array.isArray(data.newFacts) && data.newFacts.length > 0) {
        data.newFacts.forEach(fact => {
          if (fact.category && fact.text) {
            const memoryObject = { value: fact.text, timestamp: now };
            updates[`memory.${fact.category}`] = admin.firestore.FieldValue.arrayUnion(memoryObject);
            logger.info(`[Memory] Learned (${fact.category}): "${fact.text}"`);
            hasUpdates = true;
          }
        });
      }

      // 2. إدارة المهام السرية (Missions)
      if (data.newMissions && data.newMissions.length > 0) {
        updates['aiDiscoveryMissions'] = admin.firestore.FieldValue.arrayUnion(...data.newMissions);
        hasUpdates = true;
      }
      if (data.completedMissions && data.completedMissions.length > 0) {
        updates['aiDiscoveryMissions'] = admin.firestore.FieldValue.arrayRemove(...data.completedMissions);
        hasUpdates = true;
      }

      // 3. الملاحظة المستقبلية
      if (data.noteToSelf) {
        updates['aiNoteToSelf'] = data.noteToSelf;
        hasUpdates = true;
      }

      if (hasUpdates) {
        await db.collection('users').doc(userId).set(updates, { merge: true });
      }
    }
  } catch (error) {
    logger.error(`[Memory] Analysis failed: ${error.message}`);
  }
}

// ============================================================================
// 3. سياق الخروج (The Gap/Contradiction Detector)
// ============================================================================
async function saveLastInteractionContext(userId, userMessage, aiReply) {
  try {
    const prompt = `
    Analyze the END of this chat.
    User said: "${userMessage}"
    AI replied: "${aiReply}"
    
    Summarize the user's current state/intent for leaving.
    Examples: "Going to sleep", "Going to exam", "Battery dying", "Guests arrived", "Just bored".
    
    Return JSON: { "exitState": "string description" }
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'ExitContext' });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');
  
    if (parsed && parsed.exitState) {
       await db.collection('users').doc(userId).update({
         lastExitContext: {
           state: parsed.exitState,
           timestamp: new Date().toISOString()
         }
       });
       logger.log(`[Memory] Exit context saved: ${parsed.exitState}`);
    }
  } catch (error) {
    logger.warn(`[Memory] Failed to save exit context: ${error.message}`);
  }
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory,
  saveLastInteractionContext // ✅ تم تصديرها الآن
};
