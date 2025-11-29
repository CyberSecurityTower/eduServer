
// controllers/chatController.js
'use strict';

const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const CREATOR_PROFILE = require('../config/creator-profile');

// Utilities & Helpers
const { toCamelCase, toSnakeCase, nowISO } = require('../services/data/dbUtils');
const { getAlgiersTimeContext, extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const {
  getProfile, 
  getProgress, 
  fetchUserWeaknesses, 
  formatProgressForAI,
  saveChatSession, 
  getCachedEducationalPathById, 
  getSpacedRepetitionCandidates,
  scheduleSpacedRepetition
} = require('../services/data/helpers');

// AI Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { analyzeEmotionalShift } = require('../services/ai/managers/emotionalManager');

let generateWithFailoverRef;

/**
 * تهيئة المتحكم وحقن التبعيات
 */
function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) throw new Error('Chat Controller requires generateWithFailover.');
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Merged & Optimized V3).');
}

/**
 * دالة خفيفة لاكتشاف التعلم الخارجي محلياً لتجنب استدعاءات AI زائدة
 */
async function detectExternalLearning(userId, message) {
    const lowerMsg = message.toLowerCase();
    // كلمات مفتاحية تدل على أن الطالب تعلم شيئاً خارج المنصة
    if (lowerMsg.includes('درست') || lowerMsg.includes('تعلمت') || lowerMsg.includes('learned') || lowerMsg.includes('قريت')) {
        return {
            lessonTitle: "Unknown Topic",
            suspectedSource: "self/external",
            isExternal: true
        };
    }
    return null;
}

/**
 * توليد اقتراحات للمحادثة (Quick Replies)
 */
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

/**
 * معالجة الأسئلة العامة البسيطة (Fast Path)
 */
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Keep it short and helpful.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// =================================================================================
// 🔥 CORE CHAT LOGIC
// =================================================================================

async function chatInteractive(req, res) {
  let { userId, message, history = [], sessionId, context = {} } = req.body;

  // 1. إدارة الجلسة (Session Management)
  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    if (!userId || !message) return res.status(400).json({ error: 'Missing userId or message' });

    // استرجاع التاريخ من قاعدة البيانات إذا لم يتم إرساله (Failover)
    if (!history || history.length === 0) {
       const { data: sessionData } = await supabase
         .from('chat_sessions')
         .select('messages')
         .eq('id', sessionId)
         .single();
       if (sessionData?.messages) {
           history = sessionData.messages.slice(-10).map(m => ({
               role: m.author === 'bot' ? 'model' : 'user',
               text: m.text
           }));
       }
    }

    // 2. جلب البيانات بشكل متوازي (Parallel Data Fetching)
    // نجمع كل ما نحتاجه في استدعاء واحد لتقليل وقت الانتظار
    const [
      memoryReport,
      curriculumReport,
      conversationReport,
      userRes,
      weaknesses,
      reviewCandidates,
      rawProfile,
      rawProgress
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(e => { logger.warn('Memory Agent Error', e); return ''; }),
      runCurriculumAgent(userId, message).catch(e => { logger.warn('Curriculum Agent Error', e); return ''; }),
      runConversationAgent(userId, message).catch(e => { logger.warn('Conversation Agent Error', e); return ''; }),
      supabase.from('users').select('*').eq('id', userId).single(),
      fetchUserWeaknesses(userId).catch(() => []),
      getSpacedRepetitionCandidates(userId).catch(() => []),
      getProfile(userId),  
      getProgress(userId)
    ]);

    // تجهيز البيانات الأساسية
    const aiProfileData = rawProfile || {}; 
    const progressData = rawProgress || {}; 
    let userData = userRes.data ? toCamelCase(userRes.data) : {};

    // تعيين القيم الافتراضية
    userData.name = userData.firstName || userData.name || 'Student';
    userData.selectedPathId = userData.selectedPathId || 'General_Path'; 
    userData.facts = { ...rawProfile.facts, name: userData.name, gender: userData.gender || 'male' };
    userData.aiAgenda = rawProfile.aiAgenda || [];
    userData.aiDiscoveryMissions = userData.aiDiscoveryMissions || [];

    // 3. التحليل المسبق (Pre-Processing Logic)

    // أ) اكتشاف التعلم الخارجي
    const externalLearning = await detectExternalLearning(userId, message);
    let externalContext = "";
    if (externalLearning) {
        logger.info(`External Learning Detected: ${externalLearning.lessonTitle}`);
        externalContext = `[SYSTEM EVENT]: User claims they learned "${externalLearning.lessonTitle}" externally. Acknowledge this and update your mental model.`;
    }

    // ب) المحرك العاطفي (Emotional Engine)
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    let emotionalPromptContext = "";
    
    try {
        const emotionalShift = await analyzeEmotionalShift(message, currentEmotionalState, userData, externalLearning);
        
        // تحديث الحالة إذا تغيرت
        if (emotionalShift.newMood !== currentEmotionalState.mood || emotionalShift.deltaAnger !== 0) {
            const newAnger = Math.max(0, Math.min(100, (currentEmotionalState.angerLevel || 0) + (emotionalShift.deltaAnger || 0)));
            
            // حفظ الحالة الجديدة في الخلفية
            supabase.from('ai_memory_profiles')
                .update({ emotional_state: { mood: emotionalShift.newMood, angerLevel: newAnger, reason: emotionalShift.reason } })
                .eq('user_id', userId)
                .then(() => logger.info(`Mood updated: ${emotionalShift.newMood}`));

            // بناء سياق التوجيه للموديل (System Instruction)
            if (newAnger > 50) {
                emotionalPromptContext = `[SYSTEM: ANGRY/STRICT MODE 😠]. Level: ${newAnger}%. Reason: ${emotionalShift.reason}. Be strict, short, and less helpful until they apologize or study.`;
            } else if (emotionalShift.newMood === 'disappointed') {
                emotionalPromptContext = `[SYSTEM: DISAPPOINTED MODE 😔]. Reason: ${emotionalShift.reason}. Express disappointment in their lack of progress.`;
            } else {
                emotionalPromptContext = `[SYSTEM: HAPPY MODE 🌟]. Mood: ${emotionalShift.newMood}. Be energetic and supportive.`;
            }
        }
    } catch (err) {
        logger.warn('Emotional Engine failed, falling back to neutral.', err);
    }

    // ج) سياق الوقت والاتقان (Context Building)
    const timeData = getAlgiersTimeContext();
    let masteryContext = "User is in general chat.";
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";

    // إذا كان الطالب داخل درس معين
    if (context.lessonId && context.subjectId && userData.selectedPathId) {
       const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
       masteryContext = `User is studying Lesson ID: ${context.lessonId}. Current Mastery: ${pData?.masteryScore || 0}%.`;
       
       // محاولة جلب لغة المادة
       const pathDetails = await getCachedEducationalPathById(userData.selectedPathId);
       const subject = pathDetails?.subjects?.find(s => s.id === context.subjectId);
       if (subject) {
           preferredLang = subject.defaultLang || "Arabic";
           textDirection = subject.direction || "rtl";
       }
    }

    // 4. بناء البرومبت النهائي (The Master Prompt)
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,                      
      memoryReport,                 
      curriculumReport,             
      conversationReport,           
      history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n'),
      await formatProgressForAI(userId),            
      weaknesses,                   
      externalContext,              
      emotionalPromptContext,       
      '', // Romance context (disabled)
      userData.aiNoteToSelf || '',  
      CREATOR_PROFILE,              
      userData,                     
      '', // Gap context
      timeData.contextSummary,      
      masteryContext,               
      textDirection,                
      preferredLang,                
      emotionalPromptContext
    );

    // 5. استدعاء الذكاء الاصطناعي (AI Generation)
    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'MasterChat', 
      timeoutMs: isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat 
    });

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "عذراً، حدث خطأ في المعالجة.", widgets: [] };

    // =================================================================================
    // 🔥 معالجة ما بعد الاستجابة (Post-Processing & Updates)
    // =================================================================================

    // A) تحديث المهام (Missions)
    if (parsedResponse.completedMissions?.length > 0) {
       const currentMissions = userData.aiDiscoveryMissions || [];
       const newMissions = currentMissions.filter(m => !parsedResponse.completedMissions.includes(m));
       await supabase.from('users').update({ ai_discovery_missions: newMissions }).eq('id', userId);
    }

    // B) تحديث الأجندة (Agenda)
    if (parsedResponse.completedMissionIds?.length > 0) {
        const currentAgenda = aiProfileData.ai_agenda || [];
        const updatedAgenda = currentAgenda.map(task => {
            if (parsedResponse.completedMissionIds.includes(task.id)) {
                return { ...task, status: 'completed', completedAt: nowISO() };
            }
            return task;
        });
        await supabase.from('ai_memory_profiles').update({ ai_agenda: updatedAgenda }).eq('user_id', userId);
    }

    // C) جدولة التكرار المتباعد (Spaced Repetition)
    if (parsedResponse.scheduleSpacedRepetition?.topic) {
        scheduleSpacedRepetition(userId, parsedResponse.scheduleSpacedRepetition.topic, 1)
            .catch(e => logger.warn('Spaced Repetition Error', e));
    }

    // D) تحديث نتائج الكويز (Quiz & Progress)
    if (parsedResponse.quizAnalysis?.processed && context.lessonId) {
        try {
            const { pathId, subjectId, lessonId } = { pathId: userData.selectedPathId, ...context };
            let pathP = progressData.pathProgress || {};
            
            // ضمان وجود الهيكل
            if(!pathP[pathId]) pathP[pathId] = { subjects: {} };
            if(!pathP[pathId].subjects[subjectId]) pathP[pathId].subjects[subjectId] = { lessons: {} };
            
            const lessonObj = pathP[pathId].subjects[subjectId].lessons[lessonId] || {};
            const currentScore = parsedResponse.quizAnalysis.scorePercentage || 0;
            
            // حساب الدرجة الجديدة (Weighted Average)
            let newScore = currentScore;
            if (lessonObj.attempts > 0) {
                newScore = Math.round((lessonObj.masteryScore * 0.7) + (currentScore * 0.3));
            }

            lessonObj.masteryScore = newScore;
            lessonObj.attempts = (lessonObj.attempts || 0) + 1;
            lessonObj.status = 'completed';
            lessonObj.lastAttempt = nowISO();

            pathP[pathId].subjects[subjectId].lessons[lessonId] = lessonObj;

            await supabase.from('user_progress').update({ path_progress: toSnakeCase(pathP) }).eq('id', userId);
            logger.info(`Progress updated for lesson ${lessonId}: ${newScore}%`);

        } catch (e) { logger.error('Quiz Update Failed', e); }
    }

    // 6. إرسال الرد للعميل
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood, // لإظهار أنيميشن في الواجهة
      direction: parsedResponse.direction || textDirection
    });

    // 7. مهام الخلفية (Fire & Forget)
    const chatTitle = message.substring(0, 30);
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    
    // حفظ الذاكرة (Memory)
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('Memory Save Error', e));
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], userData.aiDiscoveryMissions || []);

  } catch (err) {
    logger.error('🔥🔥🔥 FATAL ERROR IN CHAT CONTROLLER:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ تقني غير متوقع، يرجى المحاولة لاحقاً." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
