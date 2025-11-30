
'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const { getAlgiersTimeContext, extractTextFromResult, ensureJsonOrRepair } = require('../utils');

// Helpers
const {
  getProfile, 
  getProgress, 
  formatProgressForAI,
  saveChatSession, 
  fetchUserWeaknesses, 
  updateAiAgenda 
} = require('../services/data/helpers');

// AI Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');

// ✅ EduNexus
const { getNexusMemory, updateNexusKnowledge } = require('../services/ai/eduNexus');

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Identity Injection Mode 🚀).');
}

// ==========================================
// 3. Helper Handlers
// ==========================================
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('Error generating suggestions:', error);
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما هي خطتي اليوم؟"] });
  }
}

// ==========================================
// 4. Main Logic: Chat Interactive
// ==========================================
async function chatInteractive(req, res) {
  let { userId, message, history = [], sessionId } = req.body;

  if (!Array.isArray(history)) history = [];
  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // ---------------------------------------------------------
    // A. Data Aggregation (Identity First)
    // ---------------------------------------------------------
    const { data: userRaw, error: userError } = await supabase.from('users').select('*, group_id, role').eq('id', userId).single();
    
    if (userError || !userRaw) {
        return res.status(404).json({ reply: "عذراً، لم أتمكن من العثور على حسابك." });
    }

    let userData = toCamelCase(userRaw);

    // --- GROUP ENFORCEMENT ---
    if (!userData.groupId) {
        const groupMatch = message.match(/(?:فوج|group|groupe|g)\s*(\d+)/i);
        if (groupMatch) {
            const groupNum = groupMatch[1]; 
            const pathId = userData.selectedPathId || 'UAlger3_L1_ITCF'; 
            const newGroupId = `${pathId}_G${groupNum}`;
            
            try {
                await supabase.from('study_groups').upsert({ 
                    id: newGroupId, 
                    path_id: pathId,
                    name: `Group ${groupNum}`
                }, { onConflict: 'id' });

                await supabase.from('users').update({ group_id: newGroupId }).eq('id', userId);
                
                return res.status(200).json({ 
                    reply: `تم! ✅ راك مسجل ضروك في الفوج ${groupNum}.`,
                    sessionId, mood: 'excited'
                });
            } catch (err) {
                return res.status(200).json({ reply: "حدث خطأ تقني.", sessionId });
            }
        } else {
            return res.status(200).json({ reply: "مرحبا! 👋 واش من فوج (Groupe) راك تقرا فيه؟ (اكتب: فوج 1)", sessionId });
        }
    }
    // --- END ENFORCEMENT ---

    // Fetch Context Data
    const [rawProfile, memoryReport, curriculumReport, weaknessesRaw, formattedProgress] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''), 
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => '')
    ]);

    const aiProfileData = rawProfile || {}; 
    const groupId = userData.groupId;

    // 🔥 FIX: دمج البيانات الأساسية بقوة لضمان معرفة الـ AI بالمستخدم
    const fullUserProfile = { 
        userId: userId,
        firstName: userData.firstName || 'Student', // الاسم من جدول المستخدمين
        lastName: userData.lastName || '',
        group: groupId,
        role: userData.role || 'student',
        ...aiProfileData, // بيانات الذاكرة (قد تكون فارغة)
        facts: {
            ...(aiProfileData.facts || {}),
            // نؤكد على الاسم هنا أيضاً
            userName: userData.firstName || 'Student',
            userGroup: groupId
        }
    };

    // ---------------------------------------------------------
    // B. Context Preparation
    // ---------------------------------------------------------
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    const allAgenda = Array.isArray(aiProfileData.aiAgenda) ? aiProfileData.aiAgenda : [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending');

    // EduNexus
    let sharedContext = "";
    if (groupId) {
        try {
            const nexusMemory = await getNexusMemory(groupId);
            if (nexusMemory && nexusMemory.exams) {
                sharedContext = "🏫 **HIVE MIND:**\n";
                Object.entries(nexusMemory.exams).forEach(([subject, data]) => {
                    sharedContext += `- ${subject}: ${data.confirmed_value}\n`;
                });
            }
        } catch (e) { /* ignore */ }
    }

    // 🔥 FIX: حقن الهوية مباشرة في سياق النظام (System Context)
    // هذا يضمن أن الـ AI يقرأ الاسم والفوج حتى لو تجاهل البروفايل
    const identityContext = `User Identity: Name=${fullUserProfile.firstName}, Group=${groupId}, Role=${fullUserProfile.role}.`;
    const systemContextCombined = `${identityContext}\n${getAlgiersTimeContext().contextSummary}\n${sharedContext}`;

    // ---------------------------------------------------------
    // C. AI Generation
    // ---------------------------------------------------------
    const safeHistoryStr = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n') || '';
    const safeWeaknesses = Array.isArray(weaknessesRaw) ? weaknessesRaw : [];

    const finalPrompt = PROMPTS.chat.interactiveChat(
      message || '', 
      memoryReport || '', 
      curriculumReport || '', 
      safeHistoryStr, 
      safeHistoryStr, 
      formattedProgress || '', 
      safeWeaknesses, 
      currentEmotionalState, 
      fullUserProfile, // البروفايل المعزز
      systemContextCombined || '', // السياق المعزز بالهوية
      null, 
      activeAgenda
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'MasterChat', timeoutMs: CONFIG.TIMEOUTS.chat });
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // ---------------------------------------------------------
    // D. Action Layer
    // ---------------------------------------------------------
    if (parsedResponse.memory_update && groupId) {
        const action = parsedResponse.memory_update;
        if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
            updateNexusKnowledge(groupId, userId, 'exams', action.subject, action.new_date).catch(e => logger.error(e));
        }
    }

    if (parsedResponse.agenda_actions && Array.isArray(parsedResponse.agenda_actions)) {
        // ... (Agenda logic same as before)
    }

    if (parsedResponse.newMood) {
        supabase.from('ai_memory_profiles').update({ 
            emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
            last_updated_at: nowISO()
        }).eq('user_id', userId).then();
    }

    // ---------------------------------------------------------
    // E. Response
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood 
    });

    setImmediate(() => {
        const updatedHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }];
        saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory).catch(e => logger.error(e));
        analyzeAndSaveMemory(userId, updatedHistory).catch(e => logger.error(e));
    });

  } catch (err) {
    logger.error('Chat Controller Error:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ تقني." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
