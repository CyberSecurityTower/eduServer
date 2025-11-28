
'use strict';

const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('../services/data/dbUtils');
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI,
  saveChatSession, getCachedEducationalPathById, getSpacedRepetitionCandidates
} = require('../services/data/helpers');
const { getAlgiersTimeContext } = require('../utils'); 


// Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');

const { extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const CREATOR_PROFILE = require('../config/creator-profile');

let generateWithFailoverRef;

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) throw new Error('Chat Controller requires generateWithFailover.');
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Supabase).');
}

async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما التالي؟"] });
  }
}

async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// --- CORE CHAT LOGIC ---

async function chatInteractive(req, res) {
  let userId, message, history, sessionId, context;
  
  try {
    ({ userId, message, history = [], sessionId, context = {} } = req.body);
    if (!userId || !message) return res.status(400).json({ error: 'Missing data' });

    sessionId = sessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    let chatTitle = message.substring(0, 30);
    // 🔥🔥 التعديل الجديد: جلب الذاكرة الحية من الداتابايز إذا كانت فارغة 🔥🔥
    if (!history || history.length === 0) {
       // نجلب آخر جلسة محادثة لهذا المستخدم ونستخرج آخر الرسائل
       const { data: sessionData } = await supabase
         .from('chat_sessions')
         .select('messages')
         .eq('id', sessionId) // نبحث بنفس الـ Session ID
         .single();
         
       if (sessionData && sessionData.messages) {
           // نأخذ آخر 10 رسائل فقط لنشكل سياقاً حياً
           history = sessionData.messages.slice(-10).map(m => ({
               role: m.author === 'bot' ? 'model' : 'user', // توحيد التسميات
               text: m.text
           }));
       }
    }
    // 1. Parallel Data Fetching
    const [
      memoryReport,
      curriculumReport,
      conversationReport,
      userRes,
      weaknesses,
      reviewCandidates
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      supabase.from('users').select('*').eq('id', userId).single(),
      fetchUserWeaknesses(userId).catch(() => []),
      getSpacedRepetitionCandidates(userId)
    ]);

    const userData = userRes.data ? toCamelCase(userRes.data) : {};
    // helpers.js uses Supabase internally now
    const progressData = await getProgress(userId); 
    const aiProfileData = await getProfile(userId);
    userData.facts = aiProfileData.facts || {}; 

    // 2. Context Building
    let masteryContext = "User is currently in general chat mode (Not inside a specific lesson)."; // <--- القيمة الافتراضية الجديدة
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";
    const pathDetails = await getCachedEducationalPathById(userData.selectedPathId);
    const realMajorName = pathDetails?.display_name || pathDetails?.title || "تخصص جامعي";
    userData.fullMajorName = realMajorName; 
    
    // Mastery Context Logic
    if (context && context.lessonId && context.subjectId && userData.selectedPathId) {
       // هنا فقط نغير القيمة ونقول له أن الطالب يدرس هذا الدرس
       const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
       masteryContext = `User is ACTIVELY studying Lesson ID: ${context.lessonId}. Mastery: ${pData?.masteryScore || 0}%.`;}
      const pathData = await getCachedEducationalPathById(userData.selectedPathId);
      const subject = pathData?.subjects?.find(s => s.id === context.subjectId);
      if (subject) {
        preferredLang = subject.defaultLang || "Arabic";
        textDirection = subject.direction || "rtl";
      }
    }

    const behavioral = aiProfileData.behavioralInsights || {};
    const emotionalContext = `Mood: ${behavioral.mood || 'Neutral'}, Style: ${behavioral.style || 'Friendly'}`;

    let spacedRepetitionContext = "";
    if (reviewCandidates.length) {
      spacedRepetitionContext = reviewCandidates.map(c => `- Review: "${c.title}" (${c.score}%, ${c.daysSince}d ago).`).join('\n');
    }

    const formattedProgress = await formatProgressForAI(userId);
    const historyStr = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n');
    // 🔥🔥 التعديل هنا: استخدام دالة توقيت الجزائر 🔥🔥
    const timeData = getAlgiersTimeContext();
    const timeContext = timeData.contextSummary; 
    
    // منطق إضافي ذكي: إذا كان الوقت متأخراً جداً (بعد 1 ليلاً)، نغير "المزاج العاطفي"
    if (timeData.hour >= 1 && timeData.hour < 5) {
        // نضيف ملاحظة للـ AI أن يوبخ الطالب بحنية
        masteryContext += "\n[CRITICAL]: User is awake very late (after 1 AM). Scold them gently to go to sleep.";
    }
    // 3. AI Generation
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, memoryReport, curriculumReport, conversationReport, historyStr,
      formattedProgress, weaknesses, emotionalContext, '', userData.aiNoteToSelf || '', 
      CREATOR_PROFILE, userData, '', timeContext, 
      spacedRepetitionContext, masteryContext, preferredLang, textDirection,
    );
    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'GenUI-Chat', 
      timeoutMs: isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat 
    });
    
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // 4. Database Updates (The Brain)
    
    // A) Missions Update
    if (parsedResponse.completedMissions?.length > 0) {
       let currentMissions = userData.aiDiscoveryMissions || [];
       const completedSet = new Set(parsedResponse.completedMissions);
       const newMissions = currentMissions.filter(m => !completedSet.has(m));
       
       await supabase.from('users').update({ ai_discovery_missions: newMissions }).eq('id', userId);
    } 

    // B) Quiz / Lesson Logic
    if (parsedResponse.quizAnalysis?.processed && context.lessonId && userData.selectedPathId) {
        try {
            const { pathId, subjectId, lessonId } = { pathId: userData.selectedPathId, ...context };
            let pathP = progressData.pathProgress || {};
            
            // Safe Deep Access
            if(!pathP[pathId]) pathP[pathId] = { subjects: {} };
            if(!pathP[pathId].subjects[subjectId]) pathP[pathId].subjects[subjectId] = { lessons: {} };
            
            const lessonObj = pathP[pathId].subjects[subjectId].lessons[lessonId] || {};
            
            const currentScore = parsedResponse.quizAnalysis.scorePercentage || 0;
            const oldScore = lessonObj.masteryScore || 0;
            const attempts = (lessonObj.attempts || 0);

            // Weighted Average
            let newScore = currentScore;
            if (attempts > 0 && lessonObj.masteryScore !== undefined) {
                newScore = Math.round((oldScore * 0.7) + (currentScore * 0.3));
            }

            lessonObj.masteryScore = newScore;
            lessonObj.lastScoreChange = newScore - oldScore;
            lessonObj.attempts = attempts + 1;
            lessonObj.status = 'completed';
            lessonObj.lastAttempt = nowISO();

            pathP[pathId].subjects[subjectId].lessons[lessonId] = lessonObj;

            // Full JSONB Update in Supabase
            await supabase.from('user_progress').update({ path_progress: toSnakeCase(pathP) }).eq('id', userId);

        } catch (e) { logger.error('Quiz Update Failed', e); }
    }

    // 5. Send Response
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    });

    // 6. Background Tasks
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('Memory Save Error', e));
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], userData.aiDiscoveryMissions || []);

  } catch (err) {
    logger.error('Fatal Chat Error:', err);
    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ غير متوقع." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
