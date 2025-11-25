'use strict';

/**
 * services/ai/managers/memoryManager.js
 * Clean, fixed and robust rewrite of the memory manager.
 */

const { getFirestoreInstance, admin } = require('../../data/firestore'); // kept for possible future use
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const supabase = require('../../data/supabase');
const { toSnakeCase, nowISO } = require('../../data/dbUtils');
const logger = require('../../../utils/logger');

let db = null;
let embeddingServiceRef = null;
let generateWithFailoverRef = null;

const COLLECTION_NAME = 'userMemoryEmbeddings';

// -------------------------
// Initialization
// -------------------------
function initMemoryManager(initConfig = {}) {
  if (!initConfig.db || !initConfig.embeddingService || !initConfig.generateWithFailover) {
    throw new Error('Memory Manager requires db, embeddingService, and generateWithFailover.');
  }

  db = initConfig.db;
  embeddingServiceRef = initConfig.embeddingService;
  generateWithFailoverRef = initConfig.generateWithFailover;

  logger.success('Memory Manager Initialized (Vector + Structured + Context).');
}

// ============================================================================
// 1. Vector Memory (conversation-level embeddings)
// ============================================================================

/**
 * Save a conversation exchange (user + AI) as a single embedding row.
 * Uses native Supabase insert (pgvector-compatible array for `embedding`).
 */
async function saveMemoryChunk(userId, userMessage, aiReply) {
  try {
    if (!embeddingServiceRef) throw new Error('Embedding service not initialized');

    const combinedText = `User: ${userMessage}\nAI: ${aiReply}`;
    const embedding = await embeddingServiceRef.generateEmbedding(combinedText);

    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      logger.warn('[Memory] No embedding returned — skipping save.');
      return;
    }

    const { error } = await supabase.from('user_memory_embeddings').insert({
      user_id: userId,
      original_text: combinedText,
      embedding: embedding,
      timestamp: nowISO(),
      type: 'conversation_exchange'
    });

    if (error) logger.warn('[Memory] Supabase insert failed:', error.message || error);
  } catch (err) {
    logger.error(`[Memory] saveMemoryChunk failed: ${err.message}`);
  }
}

/**
 * Return a formatted block of the top N relevant memories for a query.
 */
async function runMemoryAgent(userId, userMessage, topK = 4) {
  try {
    if (!embeddingServiceRef) return '';

    const queryEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!queryEmbedding || !queryEmbedding.length) return '';

    const similar = await embeddingServiceRef.findSimilarEmbeddings(
      queryEmbedding,
      COLLECTION_NAME,
      topK,
      userId
    );

    if (!similar || similar.length === 0) return '';

    const formatted = similar.map((m, i) => {
      // Support different property names depending on embedding service shape
      const originalText = m.original_text || m.originalText || m.text || m.original || '';
      return `[Memory ${i + 1}]: ${safeSnippet(originalText, 300)}`;
    }).join('\n');

    return `🧠 **RELEVANT MEMORIES FOUND:**\n${formatted}\n(Use these memories to answer if the user asks about the past).`;
  } catch (error) {
    logger.error(`[Memory] Agent failed: ${error.message}`);
    return '';
  }
}

// ============================================================================
// 2. Temporal / Structured Memory (extract facts, missions, etc.)
// ============================================================================

/**
 * Analyze a recent portion of the conversation and persist structured facts & missions.
 * - history: array of { role, text }
 * - activeMissions: array of strings representing currently open discovery missions
 */
async function analyzeAndSaveMemory(userId, history = [], activeMissions = []) {
  try {
    if (!generateWithFailoverRef) throw new Error('Generation service not initialized');

    const recentChat = history.slice(-15).map(m => `${m.role}: ${m.text}`).join('\n');

    const prompt = `
Analyze the conversation deeply.

**TARGET INFORMATION:**

**1. ACTIVE MISSIONS (Look for answers to these):**
${(activeMissions && activeMissions.length) ? activeMissions.join(', ') : 'No active mysteries.'}

**2. GOALS:**
- If user answered a mission above, add it to "completedMissions".
- Extract new "facts" (Permanent Info).
- If a NEW mystery appears (e.g., user mentions "Her" but no name), add to "newMissions".

1. **Names & Relationships:** Friends, Family, Teachers.
2. **Identity:** Name, Age, Location, Dream Job.
3. **Preferences:** Music type, specific hobbies.
4. **Current Status:** Exams, sickness, travel.

**GOAL 1: Extract TIMED FACTS:**
- emotions: Current mood (Sad, Excited, Angry, Stressed).
- romance: Crushes, relationships.
- preferences: Fav music, food, hobbies.
- family: Parents, siblings.
- struggles: Academic or personal problems.

**GOAL 2: DETECT MYSTERIES (Discovery Missions):**
- Did the user mention an event/emotion WITHOUT explaining "Why"?
- Current Active Missions: ${JSON.stringify(activeMissions)}
- If a mission is SOLVED by this chat, add to "completedMissions".
- If a NEW mystery appears, add to "newMissions".

**Input Transcript:**
${recentChat}

**Output JSON ONLY:**
{
  "newFacts": [],
  "newMissions": [],
  "completedMissions": [],
  "noteToSelf": "",
  "facts": {}
}
`;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'DeepMemory' });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (!data) {
      logger.warn('[Memory] No structured data returned from analysis.');
      return;
    }

    // Fetch current user profile & missions from DB
    const { data: userRecord, error: fetchErr } = await supabase
      .from('users')
      .select('user_profile_data, ai_discovery_missions')
      .eq('id', userId)
      .single();

    if (fetchErr) {
      logger.warn('[Memory] Failed to fetch user record:', fetchErr.message || fetchErr);
    }

    const currentProfile = (userRecord && userRecord.user_profile_data) ? userRecord.user_profile_data : { facts: {} };
    let currentMissions = (userRecord && Array.isArray(userRecord.ai_discovery_missions)) ? userRecord.ai_discovery_missions : [];

    // Merge facts (defensive checks)
    if (data.facts && typeof data.facts === 'object') {
      currentProfile.facts = { ...(currentProfile.facts || {}), ...data.facts };
    }

    // Remove completed missions if provided
    if (Array.isArray(data.completedMissions) && data.completedMissions.length) {
      currentMissions = currentMissions.filter(m => !data.completedMissions.includes(m));
    }

    // Add new missions (avoid duplicates)
    if (Array.isArray(data.newMissions) && data.newMissions.length) {
      data.newMissions.forEach(m => {
        if (!currentMissions.includes(m)) currentMissions.push(m);
      });
    }

    // Persist updates
    const { error: updateErr } = await supabase
      .from('users')
      .update({
        user_profile_data: currentProfile,
        ai_discovery_missions: currentMissions
      })
      .eq('id', userId);

    if (updateErr) logger.warn('[Memory] Failed to update user record:', updateErr.message || updateErr);
  } catch (error) {
    logger.error(`[Memory] Structured memory failed: ${error.message}`);
  }
}

// ============================================================================
// 3. Exit / Gap detector
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

    if (parsed && parsed.exitState && db) {
      // If db is a Firestore instance, update there; otherwise try to update via supabase as fallback
      try {
        if (db.collection && typeof db.collection === 'function') {
          await db.collection('users').doc(userId).update({
            lastExitContext: {
              state: parsed.exitState,
              timestamp: new Date().toISOString()
            }
          });
          logger.log(`[Memory] Exit context saved to Firestore: ${parsed.exitState}`);
        } else {
          const { error } = await supabase.from('users').update({
            lastExitContext: {
              state: parsed.exitState,
              timestamp: new Date().toISOString()
            }
          }).eq('id', userId);

          if (error) {
            logger.warn('[Memory] Failed to save exit context to Supabase:', error.message || error);
          } else {
            logger.log(`[Memory] Exit context saved to Supabase: ${parsed.exitState}`);
          }
        }
      } catch (err) {
        logger.warn('[Memory] Could not persist exit context:', err.message || err);
      }
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
  saveLastInteractionContext
};
