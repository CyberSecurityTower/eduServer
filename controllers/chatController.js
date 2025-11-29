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
const { getGroupMemory, updateGroupKnowledge } = require('../services/ai/managers/groupManager'); // ✅ Group Manager

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Integrated Architecture: One-Shot + Hive Mind + Agenda).');
}

// ==========================================
// 3. Helper Handlers (Worker & Suggestions)
// ==========================================

// Worker Handler for simple Q&A
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// Frontend Suggestion Generator
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
    // A. Data Aggregation (Parallel Fetching)
    // ---------------------------------------------------------
    const [
      memoryReport,
      curriculumReport,
      userRes,
      rawProfile,
      rawProgress, // قد نحتاجه مستقبلاً للحسابات الخام
      weaknesses,
      formattedProgress
    ] = await Promise.all([
      runMemoryAgent(userId, message),
      runCurriculumAgent(userId, message), 
      supabase.from('users').select('*, group_id, role').eq('id', userId).single(),
      getProfile(userId),  
      getProgress(userId),
      fetchUserWeaknesses(userId),
      formatProgressForAI(userId)
    ]);

    // Prepare User Data
    let userData = userRes.data ? toCamelCase(userRes.data) : {};
    const aiProfileData = rawProfile || {}; 
    const groupId = userData.groupId;

    const fullUserProfile = {
        ...userData,           
        ...aiProfileData,      
        facts: aiProfileData.facts || {}, 
        userName: aiProfileData.facts?.userName || userData.firstName || 'Student'
    };

    // ---------------------------------------------------------
    // B. Context Preparation
    // ---------------------------------------------------------

    // 1. Emotional State
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };

    // 2. Exam Context
    let examContext = null;
    if (userData.nextExamDate) {
        const diffDays = Math.ceil((new Date(userData.nextExamDate) - new Date()) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 30) {
            examContext = { daysUntilExam: diffDays, subject: userData.nextExamSubject || 'General' };
        }
    }

    // 3. Agenda Management (Filter active tasks)
    const allAgenda = aiProfileData.aiAgenda || [];
    const now = new Date();
    // جلب المهام المعلقة التي حان وقتها أو ليس لها وقت محدد
    const activeAgenda = allAgenda.filter(t => 
        t.status === 'pending' && (!t.trigger_date || new Date(t.trigger_date) <= now)
    );

    // 4. Group Intelligence (Hive Mind)
    let sharedContext = "";
    if (groupId) {
        try {
            const groupMemory = await getGroupMemory(groupId);
            if (groupMemory && groupMemory.exams) {
                sharedContext = "🏫 **SHARED CLASS KNOWLEDGE (Hive Mind):**\n";
                Object.entries(groupMemory.exams).forEach(([subject, data]) => {
                    sharedContext += `- ${subject} Exam: "${data.confirmed_value}" (Confidence: ${data.confidence_score})`;
                    if (data.is_verified) sharedContext += " [VERIFIED ✅]";
                    else if (data.confidence_score < 3) sharedContext += " [Uncertain ⚠️]";
                    if (data.has_conflict) sharedContext += " [CONFLICT DETECTED!]";
                    sharedContext += "\n";
                });
            }
        } catch (groupErr) {
            logger.warn(`Failed to load group memory for group ${groupId}:`, groupErr);
        }
    }

    // 5. System Context Assembly
    const historyString = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n');
    const systemContextCombined = getAlgiersTimeContext().contextSummary + (sharedContext ? `\n\n${sharedContext}` : "");

    // ---------------------------------------------------------
    // C. AI Generation (The One-Shot)
    // ---------------------------------------------------------
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,                                // 1. message
      memoryReport,                           // 2. memoryReport
      curriculumReport,                       // 3. curriculumReport
      historyString,                          // 4. conversationReport (summary/last msgs)
      historyString,                          // 5. history (raw)
      formattedProgress,                      // 6. formattedProgress
      weaknesses,                             // 7. weaknesses
      currentEmotionalState,                  // 8. emotions
      fullUserProfile,                        // 9. profile
      systemContextCombined,                  // 10. context (Time + Shared Memory)
      examContext,                            // 11. exam info
      activeAgenda                            // 12. active tasks (للتذكير بها)
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'MasterChat', 
      timeoutMs: CONFIG.TIMEOUTS.chat 
    });

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // Fallback if parsing fails totally
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error processing request.", widgets: [] };

    // ---------------------------------------------------------
    // D. Post-Processing & Actions (Side Effects)
    // ---------------------------------------------------------

    // 1. Update Agenda (Snooze/Complete)
    if (parsedResponse.agenda_actions && Array.isArray(parsedResponse.agenda_actions) && parsedResponse.agenda_actions.length > 0) {
        let currentAgenda = [...allAgenda];
        let agendaUpdated = false;

        for (const action of parsedResponse.agenda_actions) {
             const idx = currentAgenda.findIndex(t => t.id === action.id);
             if (idx !== -1) {
                 agendaUpdated = true;
                 if (action.action === 'complete') {
                     currentAgenda[idx].status = 'completed';
                     currentAgenda[idx].completed_at = nowISO();
                     logger.info(`✅ Task completed: ${currentAgenda[idx].title}`);
                 } else if (action.action === 'snooze') {
                     // Snooze until provided date or +24h default
                     const until = action.until ? new Date(action.until) : new Date(Date.now() + 86400000);
                     currentAgenda[idx].trigger_date = until.toISOString();
                     logger.info(`zzz Task snoozed: ${currentAgenda[idx].title} until ${until}`);
                 }
             }
        }
        if (agendaUpdated) {
            await updateAiAgenda(userId, currentAgenda);
        }
    }

    // 2. Update Emotions
    if (parsedResponse.newMood || parsedResponse.newAnger !== undefined) {
        const newMood = parsedResponse.newMood || currentEmotionalState.mood;
        const newAnger = parsedResponse.newAnger !== undefined ? parsedResponse.newAnger : currentEmotionalState.angerLevel;
        
        if (newMood !== currentEmotionalState.mood || Math.abs(newAnger - currentEmotionalState.angerLevel) > 5) {
            await supabase.from('ai_memory_profiles')
                .update({ 
                    emotional_state: { mood: newMood, angerLevel: newAnger, reason: parsedResponse.moodReason || 'Chat interaction' },
                    last_updated_at: nowISO()
                })
                .eq('user_id', userId);
        }
    }

    // 3. Update Group Knowledge (Hive Mind Input)
    if (parsedResponse.new_facts && parsedResponse.new_facts.examDate && groupId) {
        try {
            const { subject, date } = parsedResponse.new_facts.examDate;
            logger.info(`🏫 Group Intelligence: User ${userId} reporting exam for ${subject} on ${date}`);
            
            // تمرير userId لزيادة الموثوقية بناءً على سمعة الطالب
            const result = await updateGroupKnowledge(groupId, userId, 'exams', subject, date);
            
            if (result.conflictDetected) {
                logger.warn(`⚠️ Conflict detected in group knowledge for ${subject}. Needs verification.`);
            }
        } catch (groupUpdateErr) {
            logger.error('Error updating group knowledge:', groupUpdateErr);
        }
    }

    // 4. External Learning Logging
    if (parsedResponse.externalLearning && parsedResponse.externalLearning.detected) {
        const { topic, source } = parsedResponse.externalLearning;
        saveMemoryChunk(userId, `User claims to have learned "${topic}" from ${source} outside the app.`, "External Learning");
    }

    // ---------------------------------------------------------
    // E. Response & Background Tasks
    // ---------------------------------------------------------
    
    // Send Response
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood 
    });

    // Background: Save Chat & Memory Analysis
    // نضيف الرد للسجل ونحفظه
    const updatedHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }];
    
    setImmediate(() => {
        saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory).catch(e => logger.error('Bg Save Chat Error', e));
        analyzeAndSaveMemory(userId, updatedHistory).catch(e => logger.error('Bg Memory Analysis Error', e));
    });

  } catch (err) {
    logger.error('Chat Controller Critical Error:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ غير متوقع أثناء المعالجة، يرجى المحاولة لاحقاً." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
