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

// ✅ EduNexus (Hive Mind Manager)
const { getNexusMemory, updateNexusKnowledge } = require('../services/ai/eduNexus');

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (EduNexus Agent Mode Activated 🚀).');
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

  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // ---------------------------------------------------------
    // A. Data Aggregation & Onboarding Check
    // ---------------------------------------------------------
    const { data: userRaw, error: userError } = await supabase.from('users').select('*, group_id, role').eq('id', userId).single();
    
    if (userError || !userRaw) {
        return res.status(404).json({ reply: "عذراً، لم أتمكن من العثور على حسابك." });
    }

    let userData = toCamelCase(userRaw);

    // =========================================================
    // 🛑 STRICT ONBOARDING GATE (بوابة الانضمام الصارمة)
    // =========================================================
    if (!userData.groupId) {
        // Regex لاستخراج الرقم فقط (يدعم العربية واللاتينية)
        const groupMatch = message.match(/(?:فوج|group|groupe|g)\s*(\d+)/i);
        
        if (groupMatch) {
            const groupNum = groupMatch[1]; 
            const pathId = userData.selectedPathId || 'General'; 
            const newGroupId = `${pathId}_G${groupNum}`;
            
            logger.info(`👥 Onboarding: User ${userId} joining ${newGroupId}`);

            try {
                // 1. إنشاء الفوج إذا لم يكن موجوداً (Upsert) لمنع أخطاء الربط
                await supabase.from('study_groups').upsert({ 
                    id: newGroupId, 
                    path_id: pathId,
                    name: `Group ${groupNum}`,
                    created_at: nowISO()
                }, { onConflict: 'id' });

                // 2. تحديث المستخدم
                await supabase.from('users').update({ group_id: newGroupId }).eq('id', userId);
                
                return res.status(200).json({ 
                    reply: `تم! ✅ راك مسجل ضروك في الفوج ${groupNum}. EduNexus راهو يجمع في المعلومات من صحابك باش يعاونك. واش حاب تقرا اليوم؟`,
                    sessionId, 
                    mood: 'excited'
                });

            } catch (err) {
                logger.error('Onboarding Error:', err);
                return res.status(200).json({ reply: "حدث خطأ تقني أثناء التسجيل، حاول مرة أخرى.", sessionId });
            }
        } else {
            // ⛔ BLOCKING STATE: نطلب الفوج ولا نكمل المعالجة
            return res.status(200).json({ 
                reply: "مرحبا! 👋 باش نقدر نعاونك بذكاء المجموعة، لازم تقولي واش من فوج (Groupe) راك تقرا فيه؟\n(اكتب مثلاً: **فوج 1**)", 
                sessionId,
                mood: 'curious'
            });
        }
    }
    // =========================================================
    // END ONBOARDING
    // =========================================================

    // Fetch Context Data (Parallel)
    const [rawProfile, memoryReport, curriculumReport, weaknesses, formattedProgress] = await Promise.all([
      getProfile(userId),
      runMemoryAgent(userId, message),
      runCurriculumAgent(userId, message), 
      fetchUserWeaknesses(userId),
      formatProgressForAI(userId)
    ]);

    const aiProfileData = rawProfile || {}; 
    const groupId = userData.groupId;
    const fullUserProfile = { ...userData, ...aiProfileData, facts: aiProfileData.facts || {}, userName: aiProfileData.facts?.userName || userData.firstName || 'Student' };

    // ---------------------------------------------------------
    // B. Context Preparation
    // ---------------------------------------------------------
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    
    // Agenda Filtering
    const allAgenda = aiProfileData.aiAgenda || [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending' && (!t.trigger_date || new Date(t.trigger_date) <= new Date()));

    // 🏫 EduNexus Context (The Hive Mind)
    let sharedContext = "";
    if (groupId) {
        try {
            const nexusMemory = await getNexusMemory(groupId);
            if (nexusMemory && nexusMemory.exams) {
                sharedContext = "🏫 **HIVE MIND (EduNexus Knowledge):**\n";
                Object.entries(nexusMemory.exams).forEach(([subject, data]) => {
                    sharedContext += `- ${subject}: "${data.confirmed_value}" (Confidence: ${data.confidence_score})`;
                    if (data.is_verified) sharedContext += " [ADMIN VERIFIED ✅]";
                    else if (data.confidence_score < 3) sharedContext += " [Uncertain ⚠️]";
                    if (data.has_conflict) sharedContext += " [CONFLICT!]";
                    sharedContext += "\n";
                });
            }
        } catch (e) { logger.warn('Nexus Load Error', e); }
    }

    const systemContextCombined = getAlgiersTimeContext().contextSummary + (sharedContext ? `\n\n${sharedContext}` : "");

    // ---------------------------------------------------------
    // C. AI Generation
    // ---------------------------------------------------------
    // نمرر الوسائط بالترتيب الصحيح المتوقع في PROMPTS.chat.interactiveChat
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, 
      memoryReport, 
      curriculumReport, 
      history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n'), // conversationReport
      history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n'), // history
      formattedProgress, 
      weaknesses, 
      currentEmotionalState, 
      fullUserProfile, 
      systemContextCombined, 
      null, // examContext (يمكن حسابه إذا لزم الأمر)
      activeAgenda
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'MasterChat', timeoutMs: CONFIG.TIMEOUTS.chat });
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error processing request.", widgets: [] };

    // ---------------------------------------------------------
    // D. ACTION LAYER (تنفيذ الأوامر) ⚡
    // ---------------------------------------------------------

    // 1. Handle "Memory Updates" (EduNexus Updates)
    // إذا قرر الـ AI أن المستخدم قدم معلومة جديدة تستحق التحديث
    if (parsedResponse.memory_update && groupId) {
        const action = parsedResponse.memory_update;
        
        if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
            logger.info(`⚡ ACTION: User ${userId} updating exam for ${action.subject}`);
            try {
                const result = await updateNexusKnowledge(
                    groupId, 
                    userId, 
                    'exams', 
                    action.subject, 
                    action.new_date
                );

                if (result.blocked) {
                    logger.warn(`🛡️ Action Blocked: User ${userId} tried to overwrite Admin verified data.`);
                } else if (result.success) {
                    logger.success(`✅ EduNexus Updated: ${action.subject} -> ${action.new_date}`);
                }
            } catch (err) {
                logger.error('Failed to execute UPDATE_EXAM:', err);
            }
        }
    }

    // 2. Handle Agenda Actions (Snooze/Complete)
    if (parsedResponse.agenda_actions && parsedResponse.agenda_actions.length > 0) {
        let currentAgenda = [...allAgenda];
        let agendaUpdated = false;
        for (const act of parsedResponse.agenda_actions) {
             const idx = currentAgenda.findIndex(t => t.id === act.id);
             if (idx !== -1) {
                 agendaUpdated = true;
                 if (act.action === 'complete') {
                     currentAgenda[idx].status = 'completed';
                     currentAgenda[idx].completed_at = nowISO();
                 } else if (act.action === 'snooze') {
                     const until = act.until ? new Date(act.until) : new Date(Date.now() + 86400000);
                     currentAgenda[idx].trigger_date = until.toISOString();
                 }
             }
        }
        if (agendaUpdated) await updateAiAgenda(userId, currentAgenda);
    }

    // 3. Update Emotions
    if (parsedResponse.newMood) {
        await supabase.from('ai_memory_profiles').update({ 
            emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
            last_updated_at: nowISO()
        }).eq('user_id', userId);
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

    // Background Tasks (Fire & Forget)
    setImmediate(() => {
        const updatedHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }];
        saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory).catch(e => logger.error('Bg Save Error', e));
        analyzeAndSaveMemory(userId, updatedHistory).catch(e => logger.error('Bg Memory Error', e));
    });

  } catch (err) {
    logger.error('Chat Controller Critical Error:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ تقني غير متوقع." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
