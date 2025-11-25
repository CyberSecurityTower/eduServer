
'use strict';

/**
 * services/ai/managers/memoryManager.js
 * Supabase Native Version
 */

const supabase = require('../../data/supabase');
const { toSnakeCase, nowISO } = require('../../data/dbUtils'); // تأكد من وجود هذا الملف
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let embeddingServiceRef = null;
let generateWithFailoverRef = null;

const COLLECTION_NAME = 'user_memory_embeddings'; // اسم الجدول في Supabase

// -------------------------
// Initialization
// -------------------------
function initMemoryManager(initConfig = {}) {
  if (!initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires embeddingService and generateWithFailover.');
  }

  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;

  logger.success('Memory Manager Initialized (Supabase Native).');
}

// ============================================================================
// 1. Vector Memory
// ============================================================================

async function saveMemoryChunk(userId, userMessage, aiReply) {
  try {
    if (!embeddingServiceRef) return;

    const combinedText = `User: ${userMessage}\nAI: ${aiReply}`;
    // توليد الفيكتور
    const embedding = await embeddingServiceRef.generateEmbedding(combinedText);

    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) return;

    // Supabase Insert (pgvector)
    const { error } = await supabase.from(COLLECTION_NAME).insert({
      user_id: userId,
      original_text: combinedText,
      embedding: embedding, // Supabase يقبل المصفوفة مباشرة لحقل vector
      timestamp: nowISO(),
      type: 'conversation_exchange'
    });

    if (error) logger.warn(`[Memory] Insert failed: ${error.message}`);
  } catch (err) {
    logger.error(`[Memory] saveMemoryChunk error: ${err.message}`);
  }
}

async function runMemoryAgent(userId, userMessage, topK = 4) {
  try {
    if (!embeddingServiceRef) return '';

    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding || !queryEmbedding.length) return '';

    // استدعاء دالة البحث (RPC)
    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding,
      COLLECTION_NAME,
      topK,
      userId
    );

    if (!similar || similar.length === 0) return '';

    // تنسيق النتائج
    const formatted = similar.map((m, i) => {
      return `[Memory ${i + 1}]: ${safeSnippet(m.originalText, 300)}`;
    }).join('\n');

    return `🧠 **RELEVANT MEMORIES FOUND:**\n${formatted}\n(Use these memories to answer if the user asks about the past).`;
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// ============================================================================
// 2. Structured Memory (Facts & Missions)
// ============================================================================

async function analyzeAndSaveMemory(userId, history = [], activeMissions = []) {
  try {
    if (!generateWithFailoverRef) return;

    const recentChat = history.slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');

    const prompt = `
    Analyze conversation for facts & missions.
    Active Missions: ${activeMissions.join(', ')}
    
    Transcript:
    ${recentChat}
    
    Output JSON ONLY:
    { "facts": {"key": "value"}, "newMissions": [], "completedMissions": [] }
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'DeepMemory' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (!data) return;

    // 1. جلب بيانات المستخدم الحالية
    const { data: userRecord, error } = await supabase
      .from('users')
      .select('user_profile_data, ai_discovery_missions')
      .eq('id', userId)
      .single();

    if (error || !userRecord) return;

    let currentProfile = userRecord.user_profile_data || { facts: {} };
    let currentMissions = userRecord.ai_discovery_missions || [];

    let hasChanges = false;

    // 2. دمج الحقائق
    if (data.facts && Object.keys(data.facts).length > 0) {
      currentProfile.facts = { ...(currentProfile.facts || {}), ...data.facts };
      hasChanges = true;
    }

    // 3. تحديث المهام (حذف المنجزة وإضافة الجديدة)
    if (data.completedMissions && data.completedMissions.length > 0) {
      currentMissions = currentMissions.filter(m => !data.completedMissions.includes(m));
      hasChanges = true;
    }
    if (data.newMissions && data.newMissions.length > 0) {
      data.newMissions.forEach(m => {
        if (!currentMissions.includes(m)) currentMissions.push(m);
      });
      hasChanges = true;
    }

    // 4. حفظ التغييرات
    if (hasChanges) {
      await supabase.from('users').update({
        user_profile_data: currentProfile,
        ai_discovery_missions: currentMissions
      }).eq('id', userId);
    }

  } catch (error) {
    logger.error(`[Memory] Analysis failed: ${error.message}`);
  }
}

// ============================================================================
// 3. Exit Context
// ============================================================================

async function saveLastInteractionContext(userId, userMessage, aiReply) {
  try {
    const prompt = `Analyze exit intent. User: "${userMessage}". Return JSON: { "exitState": "reason" }`;
    
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'ExitContext' });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.exitState) {
      // تحديث مباشر في Supabase
      await supabase.from('users').update({
        last_exit_context: {
          state: parsed.exitState,
          timestamp: nowISO()
        }
      }).eq('id', userId);
      
      logger.log(`[Memory] Exit context saved: ${parsed.exitState}`);
    }
  } catch (error) {
    logger.warn(`[Memory] Exit context failed: ${error.message}`);
  }
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory,
  saveLastInteractionContext
};
