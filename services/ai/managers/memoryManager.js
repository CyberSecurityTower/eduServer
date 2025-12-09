// services/ai/managers/memoryManager.js
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');
const PROMPTS = require('../../../config/ai-prompts');
// ✅ Added completeDiscoveryMission to imports
const { getProfile, completeDiscoveryMission } = require('../../data/helpers');

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

// Helper function to save vector embeddings
async function saveMemoryChunk(userId, content, type = "General") {
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

// 2. Smart Save Function (Structured Memory + Discovery Missions)
async function analyzeAndSaveMemory(userId, history) {
  try {
    if (!generateWithFailoverRef) return;

    // 1. Fetch Current Facts + Active Missions in parallel
    // ✅ Using Promise.all for better performance
    const [profile, userDoc] = await Promise.all([
        getProfile(userId),
        supabase.from('users').select('ai_discovery_missions').eq('id', userId).single()
    ]);

    const currentFacts = profile.facts || {};
    // ✅ Extract active missions safely
    const activeMissions = userDoc.data?.ai_discovery_missions || [];

    // 2. Prepare Chat Context
    const recentChat = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

    // 3. Call AI (Passing activeMissions to the prompt)
    // ✅ Updated Prompt Call
    const prompt = PROMPTS.managers.memoryExtractor(currentFacts, recentChat, activeMissions);
    
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryExtraction' });
    const text = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(text, 'analysis');

    if (!result) return;

    let hasChanges = false;
    let finalFacts = { ...currentFacts };

    // A. Delete old or incorrect keys
    if (result.deleteKeys && Array.isArray(result.deleteKeys)) {
        result.deleteKeys.forEach(key => {
            if (finalFacts[key]) {
                delete finalFacts[key];
                hasChanges = true;
                logger.info(`🗑️ Memory: Deleted key '${key}' for user ${userId}`);
            }
        });
    }

    // B. Add/Update new facts
    // ✅ Fixed brace nesting: This block is now correctly outside the deleteKeys block
    if (result.newFacts && Object.keys(result.newFacts).length > 0) {
        finalFacts = { ...finalFacts, ...result.newFacts };
        hasChanges = true;
        logger.success(`💾 Memory: Added/Updated facts for ${userId}`, result.newFacts);
    }

    // C. Handle Completed Missions
    // ✅ Iterate and complete missions if returned by AI
    if (result.completedMissions && Array.isArray(result.completedMissions)) {
        for (const missionContent of result.completedMissions) {
            try {
                await completeDiscoveryMission(userId, missionContent);
                logger.success(`🕵️‍♂️ Mission Accomplished: "${missionContent}" for user ${userId}`);
            } catch (missionErr) {
                logger.error(`❌ Failed to complete mission: ${missionContent}`, missionErr);
            }
        }
    }

    // 4. Save only if facts changed
    if (hasChanges) {
        const { error } = await supabase.from('ai_memory_profiles').upsert({
            user_id: userId,
            facts: finalFacts,
            last_analyzed_at: nowISO()
        });
        
        if (!error) {
            // Clear cache to read updates immediately
            const { cacheDel } = require('../../data/helpers');
            await cacheDel('profile', userId); 
        }
    }

    // 5. Handle User Stories (Vector Embeddings)
    if (result.vectorContent && result.vectorContent.length > 10) {
        await saveMemoryChunk(userId, result.vectorContent, "User Story");
    }

  } catch (err) {
    logger.error(`[Memory] Analysis Failed: ${err.message}`);
  }
}

/**
 * 🧠 Memory Garbage Collector
 * Consolidates duplicate facts and removes contradictions
 */
async function consolidateUserFacts(userId) {
  try {
    // 1. Fetch current facts
    const { data } = await supabase
        .from('ai_memory_profiles')
        .select('facts')
        .eq('user_id', userId)
        .single();

    const currentFacts = data?.facts || {};
    const keys = Object.keys(currentFacts);

    // If facts are few, no need to consolidate
    if (keys.length < 5) return;

    logger.info(`🧹 Consolidating memory for user ${userId}...`);

    // 2. Optimization Prompt
    const prompt = `
    You are a Database Optimizer. I have a JSON of user facts that might contain duplicates or outdated info.
    
    Current JSON: ${JSON.stringify(currentFacts)}
    
    Task:
    1. Merge related keys (e.g., "fav_subject": "Math" and "likes": "Mathematics" -> "favorite_subject": "Math").
    2. Remove redundant or weak facts.
    3. Keep the keys in English (snake_case).
    4. Output ONLY the cleaned JSON.
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryConsolidation' });
    const text = await extractTextFromResult(res);
    const cleanedFacts = await ensureJsonOrRepair(text, 'analysis');

    if (cleanedFacts && Object.keys(cleanedFacts).length > 0) {
        // 3. Update Database
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
