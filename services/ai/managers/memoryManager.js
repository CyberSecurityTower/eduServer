
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

    // 1. جلب الحقائق الحالية
    const profile = await getProfile(userId); // تأكد أن هذه الدالة تجلب الـ facts
    const currentFacts = profile.facts || {};

    // 2. تحضير الشات
    const recentChat = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

    // 3. استدعاء الـ AI
    const prompt = PROMPTS.managers.memoryExtractor(currentFacts, recentChat);
    
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtraction' });
    const text = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(text, 'analysis');

    if (!result) return;

    let hasChanges = false;
    let finalFacts = { ...currentFacts };

    // A. حذف المفاتيح القديمة أو الخاطئة
    if (result.deleteKeys && Array.isArray(result.deleteKeys)) {
        result.deleteKeys.forEach(key => {
            if (finalFacts[key]) {
                delete finalFacts[key];
                hasChanges = true;
                logger.info(`🗑️ Memory: Deleted key '${key}' for user ${userId}`);
            }
        });
    }

    // B. إضافة/تحديث الحقائق الجديدة
    if (result.newFacts && Object.keys(result.newFacts).length > 0) {
        finalFacts = { ...finalFacts, ...result.newFacts };
        hasChanges = true;
        logger.success(`💾 Memory: Added/Updated facts for ${userId}`, result.newFacts);
    }

    // 4. الحفظ فقط إذا كان هناك تغيير
    if (hasChanges) {
        const { error } = await supabase.from('ai_memory_profiles').upsert({
            user_id: userId,
            facts: finalFacts,
            last_analyzed_at: nowISO()
        });
        
        if (!error) {
            // تفريغ الكاش لكي يقرأ التحديثات فوراً
            const { cacheDel } = require('../../data/helpers');
            await cacheDel('profile', userId); 
        }
    }

    // 5. التعامل مع القصص (Vector Embeddings) - كما كان سابقاً
    if (result.vectorContent && result.vectorContent.length > 10) {
        await saveMemoryChunk(userId, result.vectorContent, "User Story");
    }

  } catch (err) {
    logger.error(`[Memory] Analysis Failed: ${err.message}`);
  }
}

/**
 * 🧠 دالة تنظيف الذاكرة (Memory Garbage Collector)
 * تقوم بدمج الحقائق المتكررة وحذف التناقضات
 */
async function consolidateUserFacts(userId) {
  try {
    // 1. جلب الحقائق الحالية
    const { data } = await supabase
        .from('ai_memory_profiles')
        .select('facts')
        .eq('user_id', userId)
        .single();

    const currentFacts = data?.facts || {};
    const keys = Object.keys(currentFacts);

    // إذا كانت الحقائق قليلة، لا داعي للدمج
    if (keys.length < 5) return;

    logger.info(`🧹 Consolidating memory for user ${userId}...`);

    // 2. البرومبت الذكي
    const prompt = `
    You are a Database Optimizer. I have a JSON of user facts that might contain duplicates or outdated info.
    
    Current JSON: ${JSON.stringify(currentFacts)}
    
    Task:
    1. Merge related keys (e.g., "fav_subject": "Math" and "likes": "Mathematics" -> "favorite_subject": "Math").
    2. Remove redundant or weak facts.
    3. Keep the keys in English (snake_case).
    4. Output ONLY the cleaned JSON.
    `;

    // نستخدم موديل ذكي (Pro) لهذه العملية الدقيقة
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryConsolidation' });
    const text = await extractTextFromResult(res);
    const cleanedFacts = await ensureJsonOrRepair(text, 'analysis');

    if (cleanedFacts && Object.keys(cleanedFacts).length > 0) {
        // 3. تحديث القاعدة
        await supabase
            .from('ai_memory_profiles')
            .update({ 
                facts: cleanedFacts,
                last_optimized_at: new Date().toISOString()
            })
            .eq('user_id', userId);
            
        logger.success(`✨ Memory optimized for ${userId}. Keys reduced from ${keys.length} to ${Object.keys(cleanedFacts).length}.`);
    }

  } catch (err) {
    logger.error('Memory Consolidation Error:', err.message);
  }
}
/**
 * 🧠 دالة تنظيف الذاكرة (Memory Garbage Collector)
 * تقوم بدمج الحقائق المتكررة وحذف التناقضات
 */
async function consolidateUserFacts(userId) {
  try {
    // 1. جلب الحقائق الحالية
    const { data } = await supabase
        .from('ai_memory_profiles')
        .select('facts')
        .eq('user_id', userId)
        .single();

    const currentFacts = data?.facts || {};
    const keys = Object.keys(currentFacts);

    // إذا كانت الحقائق قليلة، لا داعي للدمج
    if (keys.length < 5) return;

    logger.info(`🧹 Consolidating memory for user ${userId}...`);

    // 2. البرومبت الذكي
    const prompt = `
    You are a Database Optimizer. I have a JSON of user facts that might contain duplicates or outdated info.
    
    Current JSON: ${JSON.stringify(currentFacts)}
    
    Task:
    1. Merge related keys (e.g., "fav_subject": "Math" and "likes": "Mathematics" -> "favorite_subject": "Math").
    2. Remove redundant or weak facts.
    3. Keep the keys in English (snake_case).
    4. Output ONLY the cleaned JSON.
    `;

    // نستخدم موديل ذكي (Pro) لهذه العملية الدقيقة
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryConsolidation' });
    const text = await extractTextFromResult(res);
    const cleanedFacts = await ensureJsonOrRepair(text, 'analysis');

    if (cleanedFacts && Object.keys(cleanedFacts).length > 0) {
        // 3. تحديث القاعدة
        await supabase
            .from('ai_memory_profiles')
            .update({ 
                facts: cleanedFacts,
                last_optimized_at: new Date().toISOString()
            })
            .eq('user_id', userId);
            
        logger.success(`✨ Memory optimized for ${userId}. Keys reduced from ${keys.length} to ${Object.keys(cleanedFacts).length}.`);
    }

  } catch (err) {
    logger.error('Memory Consolidation Error:', err.message);
  }
}

module.exports = {
  initMemoryManager,
  saveMemoryChunk,
  runMemoryAgent,
  analyzeAndSaveMemory,
  consolidateUserFacts
  
};
