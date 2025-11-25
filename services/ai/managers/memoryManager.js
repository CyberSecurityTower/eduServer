
// services/ai/managers/memoryManager.js
'use strict';

const { getFirestoreInstance, admin } = require('../../data/firestore');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const supabase = require('../../data/supabase'); 
const { toSnakeCase, nowISO } = require('../../data/dbUtils');
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
// ✅ 1. تحديث وظيفة حفظ الذاكرة المتجهة (لتخزين المحادثة كاملة)

async function saveMemoryChunk(userId, userMessage, aiReply) {
  const combinedText = `User: ${userMessage}\nAI: ${aiReply}`;
  const embedding = await embeddingServiceRef.generateEmbedding(combinedText);
  if (!embedding.length) return;

  // ✅ Native Supabase Insert
  await supabase.from('user_memory_embeddings').insert({
      user_id: userId,
      original_text: combinedText,
      embedding: embedding, // pgvector يفهم المصفوفة مباشرة
      timestamp: nowISO(),
      type: 'conversation_exchange'
  });
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
     **TARGET INFORMATION:**
     
    **1. ACTIVE MISSIONS (Look for answers to these):**
    ${pendingMysteries || "No active mysteries."}

    **2. GOALS:**
    - If user answered a mission above, add it to "completedMissions".
    - Extract new "facts" (Permanent Info).
    - If a NEW mystery appears (e.g., user mentions "Her" but no name), add to "newMissions . or missing information".
    1. **Names & Relationships:** Friends (e.g., Anis), Family, Teachers.
    2. **Identity:** Name, Age, Location, Dream Job (e.g., Billionaire).
    3. **Preferences:** Music type, specific hobbies.
    4. **Current Status:** Exams, sickness, travel.
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
      "noteToSelf": "Check on his mood next time.",
      "facts": {
        "friend": "أنيس (صديق مقرب)", 
        "dream": "مشروع EduApp ليصبح ملياردير",
        "age": "17 سنة"
      },  If no *new* solid facts appear, return "facts": {}.
    }
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'DeepMemory' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data) {
     // ✅ هنا التغيير الكبير: التعامل مع التحديثات
     
     // 1. جلب البيانات الحالية أولاً
     const { data: userRecord } = await supabase.from('users').select('user_profile_data, ai_discovery_missions').eq('id', userId).single();
     
     let currentProfile = userRecord?.user_profile_data || { facts: {} };
     let currentMissions = userRecord?.ai_discovery_missions || [];

     // 2. تحديث الحقائق (Merge Logic)
     if (data.facts) {
        currentProfile.facts = { ...currentProfile.facts, ...data.facts };
     }

     // 3. تحديث المهام (Filter & Push)
     if (data.completedMissions) {
        currentMissions = currentMissions.filter(m => !data.completedMissions.includes(m));
     }
     if (data.newMissions) {
        data.newMissions.forEach(m => {
            if (!currentMissions.includes(m)) currentMissions.push(m);
        });
     }

     // 4. حفظ التغييرات دفعة واحدة
     await supabase.from('users').update({
        user_profile_data: currentProfile,
        ai_discovery_missions: currentMissions
     }).eq('id', userId);
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
