
// services/ai/managers/memoryManager.js
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');
const PROMPTS = require('../../../config/ai-prompts');
const { getProfile } = require('../../data/helpers');

let embeddingServiceRef = null;
let generateWithFailoverRef = null;

const COLLECTION_NAME = 'user_memory_embeddings';

function initMemoryManager(initConfig = {}) {
  if (!initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires embeddingService and generateWithFailover.');
  }
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;
  logger.info('Memory Manager Initialized (Smart Hybrid Mode).');
}

// دالة مساعدة لحفظ الفيكتور
async function saveMemoryChunk(userId, content, type="General") {
  try {
    if (!embeddingServiceRef) return;
    const embedding = await embeddingServiceRef.generateEmbedding(content);
    if (!embedding || embedding.length === 0) return;

    await supabase.from('user_memory_embeddings').insert({
      user_id: userId,
      content: content,
      embedding: embedding,
      metadata: { type: type, source: 'smart_extractor' },
      created_at: nowISO()
    });
  } catch (err) {
    logger.error(`[Memory] Vector Save Error: ${err.message}`);
  }
}

async function runMemoryAgent(userId, userMessage, topK = 4) {
  try {
    if (!embeddingServiceRef) return '';

    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding.length) return '';

    // RPC Call for Vector Search
    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding,
      COLLECTION_NAME,
      topK,
      userId
    );

    if (!similar || similar.length === 0) return '';

    const formatted = similar.map((m, i) => {
      return `[Memory ${i + 1}]: ${safeSnippet(m.originalText, 300)}`;
    }).join('\n');

    return `🧠 **RELEVANT MEMORIES:**\n${formatted}`;
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// 2. Structured Memory (Wrapper around helper)
// 2. دالة الحفظ الذكية (هنا التغيير الجوهري)
async function analyzeAndSaveMemory(userId, history) {
  try {
    if (!generateWithFailoverRef) return;

    // 1. جلب الحقائق الحالية لنقارن بها (منع التكرار)
    const profile = await getProfile(userId);
    const currentFacts = profile.facts || {};

    // 2. تحضير الشات (آخر 10 رسائل تكفي للاستخلاص)
    const recentChat = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

    // 3. استدعاء الـ AI (The Architect)
    const prompt = PROMPTS.managers.memoryExtractor(currentFacts, recentChat);
    
    // نستخدم موديل ذكي (gemini-pro) لأن هذه العملية حساسة
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtraction' });
    const text = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(text, 'analysis');

    if (!result) return;

    // 4. التعامل مع الحقائق (Facts)
    if (result.newFacts && Object.keys(result.newFacts).length > 0) {
      const updatedFacts = { ...currentFacts, ...result.newFacts };
      
      // تحديث Supabase (JSONB update)
      const { error } = await supabase.from('ai_memory_profiles').upsert({
        user_id: userId,
        facts: updatedFacts,
        last_analyzed_at: nowISO()
      });
      
      if (!error) {
        logger.success(`[Memory] Saved NEW Facts for ${userId}:`, result.newFacts);
        // *مهم*: تحديث الكاش المحلي إذا كنت تستخدمه في helpers.js
        const { cacheDel } = require('../../data/helpers');
        await cacheDel('profile', userId); 
      }
    }

    // 5. التعامل مع القصص (Vector Embeddings)
    if (result.vectorContent && typeof result.vectorContent === 'string' && result.vectorContent.length > 10) {
      // نتأكد أن القصة تستحق الحفظ
      logger.info(`[Memory] New Story Detected: "${safeSnippet(result.vectorContent, 50)}"`);
      
      // نقوم بتوليد Embeddings للنص الملخص الذي كتبه الـ AI (وليس الشات الخام)
      // هذا يضمن جودة بحث أعلى
      await saveMemoryChunk(userId, result.vectorContent, "User Story");
    }

  } catch (err) {
    logger.error(`[Memory] Analysis Failed: ${err.message}`);
  }
}


module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory
};
