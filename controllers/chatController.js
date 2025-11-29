
// controllers/chatController.js
'use strict';
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const {
  getProfile, 
  getProgress, 
  formatProgressForAI,
  saveChatSession, 
  getCachedEducationalPathById
} = require('../services/data/helpers');
const { getAlgiersTimeContext, extractTextFromResult, ensureJsonOrRepair } = require('../utils'); 
const crypto = require('crypto');

// Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');

const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef;

function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (One-Shot Architecture).');
}

// ✅ 1. معالجة الأسئلة العامة (للـ Worker)
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// ✅ 2. توليد الاقتراحات (للـ Frontend)
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    
    // نستخدم المدير الموجود أو نرجع قيم افتراضية
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('Error generating suggestions:', error);
    // Fallback سريع
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما التالي؟"] });
  }
}

// ✅ 3. الدالة الرئيسية (The Master Logic)
async function chatInteractive(req, res) {
  let { userId, message, history = [], sessionId, context = {} } = req.body;

  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // 1. تجميع البيانات (Data Aggregation)
    const [
      memoryReport,
      curriculumReport,
      userRes,
      rawProfile,
      rawProgress
    ] = await Promise.all([
      runMemoryAgent(userId, message),
      runCurriculumAgent(userId, message), 
      supabase.from('users').select('*').eq('id', userId).single(),
      getProfile(userId),  
      getProgress(userId)
    ]);

    let userData = userRes.data ? toCamelCase(userRes.data) : {};
    const aiProfileData = rawProfile || {}; 
    
    // 🔥 دمج البيانات (The Fix) 🔥
    // ندمج بيانات المستخدم الأساسية مع بيانات الذاكرة العميقة لضمان وجود facts
    const fullUserProfile = {
        ...userData,           // (users table): id, email, first_name, selected_path_id
        ...aiProfileData,      // (ai_memory_profiles table): facts, profile_summary, ai_agenda
        facts: aiProfileData.facts || {} // تأكيد وجود الحقائق
    };

    // لوغ للتأكد (Debug)
    console.log("🧠 Loaded Facts for AI:", Object.keys(fullUserProfile.facts).length > 0 ? fullUserProfile.facts : "NO FACTS FOUND");

    // الحالة العاطفية الحالية
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };

    // حساب سياق الامتحان
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

    // 2. استدعاء الـ AI (The One Shot)
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,
      memoryReport,
      curriculumReport,
      history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n'),
      await formatProgressForAI(userId),
      currentEmotionalState, 
      fullUserProfile, // ✅ تم تمرير الكائن المدمج بدلاً من userData فقط
      getAlgiersTimeContext().contextSummary,
      examContext 
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'MasterChat', 
      timeoutMs: CONFIG.TIMEOUTS.chat 
    });

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // 3. ما بعد المعالجة (Post-Processing)

    // A) تحديث المشاعر
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

    // B) تسجيل التعلم الخارجي
    if (parsedResponse.externalLearning && parsedResponse.externalLearning.detected) {
        const { topic, source } = parsedResponse.externalLearning;
        logger.info(`🕵️ External Learning Detected: ${topic} via ${source}`);
        saveMemoryChunk(userId, `User claims to have learned "${topic}" from ${source} outside the app.`, "External Learning");
    }

    // C) الرد على العميل
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood 
    });

    // مهام الخلفية
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
