
'use strict';
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const {
  getProfile, 
  getProgress, 
  formatProgressForAI,
  saveChatSession, 
  getCachedEducationalPathById,
  fetchUserWeaknesses, 
  updateAiAgenda 
} = require('../services/data/helpers');
const { getAlgiersTimeContext, extractTextFromResult, ensureJsonOrRepair } = require('../utils'); 
const crypto = require('crypto');

// Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
// ✅ إضافة Group Manager
const { getGroupMemory, updateGroupKnowledge } = require('../services/ai/managers/groupManager');

const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef;

function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (One-Shot Architecture with Group Intelligence).');
}

// ✅ 1. General Question Handler (Worker)
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// ✅ 2. Suggestion Generator (Frontend)
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    
    // Use the manager or fallback
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('Error generating suggestions:', error);
    // Fast Fallback
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما التالي؟"] });
  }
}

// ✅ 3. Main Logic (The Master Logic)
async function chatInteractive(req, res) {
  let { userId, message, history = [], sessionId, context = {} } = req.body;

  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // 1. Data Aggregation
    const [
      memoryReport,
      curriculumReport,
      userRes,
      rawProfile,
      rawProgress,
      weaknesses,
      formattedProgress 
    ] = await Promise.all([
      runMemoryAgent(userId, message),
      runCurriculumAgent(userId, message), 
      supabase.from('users').select('*').eq('id', userId).single(),
      getProfile(userId),  
      getProgress(userId),
      fetchUserWeaknesses(userId),
      formatProgressForAI(userId)
    ]);

    // Prepare raw data
    let userData = userRes.data ? toCamelCase(userRes.data) : {};
    const aiProfileData = rawProfile || {}; 
    
    // ✅ 1.1 معالجة بيانات الفوج والذاكرة المشتركة
    const groupId = userData.groupId; // تأكد من وجود هذا الحقل في قاعدة البيانات
    let sharedContext = "";

    if (groupId) {
        try {
            const groupMemory = await getGroupMemory(groupId);
            if (groupMemory && groupMemory.exams) {
                sharedContext = "🏫 **SHARED CLASS MEMORY (What other students said):**\n";
                Object.entries(groupMemory.exams).forEach(([subject, data]) => {
                    sharedContext += `- ${subject} Exam: Most say ${data.confirmed_value} (Confidence: ${data.confidence_score} votes).`;
                    if (data.has_conflict) sharedContext += ` ⚠️ CONFLICT: Some students disagree! Verify this.`;
                    sharedContext += "\n";
                });
            }
        } catch (groupErr) {
            logger.warn(`Failed to load group memory for group ${groupId}:`, groupErr);
        }
    }
    
    // 🔥 DATA MERGING FIX 🔥
    const fullUserProfile = {
        ...userData,           
        ...aiProfileData,      
        facts: aiProfileData.facts || {}, 
        userName: aiProfileData.facts?.userName || userData.firstName || 'Student'
    };

    // Debug Log
    console.log("🧠 Loaded Facts for AI:", Object.keys(fullUserProfile.facts).length > 0 ? fullUserProfile.facts : "NO FACTS FOUND");

    // Current Emotional State
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };

    // Exam Context Calculation
    let examContext = null;
    if (userData.nextExamDate) {
        const examDate = new Date(userData.nextExamDate);
        const today = new Date();
        const diffTime = examDate - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 30) {
            examContext = { daysUntilExam: diffDays, subject: userData.nextExamSubject || 'الدراسة' };
        }
    }

    // تحضير سجل المحادثة كنص
    const historyString = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n');

    // دمج سياق النظام مع الذاكرة المشتركة
    const systemContextCombined = getAlgiersTimeContext().contextSummary + (sharedContext ? `\n\n${sharedContext}` : "");

    // 2. AI Invocation (The One Shot)
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,                                // 1. message
      memoryReport,                           // 2. memoryReport
      curriculumReport,                       // 3. curriculumReport
      historyString,                          // 4. conversationReport
      historyString,                          // 5. history
      formattedProgress,                      // 6. formattedProgress
      weaknesses,                             // 7. weaknesses
      currentEmotionalState,                  // 8. currentEmotionalState
      fullUserProfile,                        // 9. userProfileData
      systemContextCombined,                  // 10. systemContext (الآن يحتوي على Shared Context)
      examContext                             // 11. examContext
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'MasterChat', 
      timeoutMs: CONFIG.TIMEOUTS.chat 
    });

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // 3. Post-Processing

    // ✅ A) Update Emotions
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

    // ✅ B) Record External Learning
    if (parsedResponse.externalLearning && parsedResponse.externalLearning.detected) {
        const { topic, source } = parsedResponse.externalLearning;
        logger.info(`🕵️ External Learning Detected: ${topic} via ${source}`);
        saveMemoryChunk(userId, `User claims to have learned "${topic}" from ${source} outside the app.`, "External Learning");
    }

    // ✅ C) Update Group Knowledge (الذكاء الجماعي)
    if (parsedResponse.new_facts && parsedResponse.new_facts.examDate && groupId) {
        try {
            const { subject, date } = parsedResponse.new_facts.examDate;
            logger.info(`🏫 Group Intelligence: Detecting exam info for ${subject} on ${date}`);
            
            const result = await updateGroupKnowledge(groupId, 'exams', subject, date);
            
            // إذا كان هناك تضارب، يمكن إضافته للملاحظات (أو يتم التعامل معه في الرد القادم للذكاء الاصطناعي)
            if (result.conflictDetected) {
                logger.info(`⚠️ Conflict detected in group knowledge for ${subject}`);
            }
        } catch (groupUpdateErr) {
            logger.error('Error updating group knowledge:', groupUpdateErr);
        }
    }

    // D) Send Response
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood 
    });

    // Background Tasks
    saveChatSession(sessionId, userId, message.substring(0, 20), [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }]);
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }]);

  } catch (err) {
    logger.error('Chat Controller Error:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ غير متوقع." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
