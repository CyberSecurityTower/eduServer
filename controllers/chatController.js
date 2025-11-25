
'use strict';

const CONFIG = require('../config');
const supabase = require('../services/data/supabase'); // ✅ استيراد مباشر
const { toSnakeCase, toCamelCase, nowISO } = require('../services/data/dbUtils'); // ✅ أدوات التحويل
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI,
  saveChatSession, getCachedEducationalPathById,
  getSpacedRepetitionCandidates
} = require('../services/data/helpers');

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
  if (!dependencies.generateWithFailover) {
    throw new Error('Chat Controller requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Supabase).');
}

// --- Routes Helpers ---

async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('/generate-chat-suggestions error:', error.stack);
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز سريع", "ما هي خطوتي التالية؟"] });
  }
}

async function handleGeneralQuestion(message, language, studentName) {
    const prompt = `You are EduAI. User: ${studentName || 'Student'}. Question: "${message}". Reply in ${language}. Keep it short.`;
    if (!generateWithFailoverRef) return "Service unavailable.";
    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion', timeoutMs: 20000 });
    return await extractTextFromResult(modelResp);
}

// --- MAIN CHAT INTERACTIVE ---

async function chatInteractive(req, res) {
  let userId, message, history, sessionId, context;
  
  try {
    ({ userId, message, history = [], sessionId: sessionId, context = {} } = req.body);
    
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    sessionId = sessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    let chatTitle = message.substring(0, 30);

    // 1. Fetch Data (Parallel)
    // لاحظ: getProfile و getProgress يعملان الآن بـ Supabase من داخل helpers.js
    const [
      memoryReport, 
      curriculumReport, 
      conversationReport,
      userRes,          // ✅ Supabase fetch
      weaknesses,
      reviewCandidates
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      supabase.from('users').select('*').eq('id', userId).single(), // ✅ مباشر
      fetchUserWeaknesses(userId).catch(() => []),
      getSpacedRepetitionCandidates(userId)
    ]);

    // تحويل البيانات القادمة من قاعدة البيانات
    const userData = userRes.data ? toCamelCase(userRes.data) : {};
    const progressData = await getProgress(userId); // helpers تجلبها جاهزة
    const aiProfileData = await getProfile(userId); // helpers تجلبها جاهزة

    // 2. Prepare Contexts
    let masteryContext = "New Topic.";
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";

    try {
        if (context.lessonId && context.subjectId && userData.selectedPathId) {
            const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
            if (pData && pData.masteryScore !== undefined) {
                const trend = pData.lastScoreChange > 0 ? `+${pData.lastScoreChange}%` : (pData.lastScoreChange < 0 ? `${pData.lastScoreChange}%` : "Stable");
                masteryContext = `Mastery: ${pData.masteryScore}% (${trend}).`;
            }
            const pathData = await getCachedEducationalPathById(userData.selectedPathId);
            const subject = pathData?.subjects?.find(s => s.id === context.subjectId) || {};
            if (subject) {
                preferredLang = subject.defaultLang || "Arabic";
                textDirection = subject.direction || "rtl";
            }
        }
    } catch (e) { /* Ignore setup errors */ }

    const behavioral = aiProfileData.behavioralInsights || {};
    const emotionalContext = `Current Mood: ${behavioral.mood || 'Neutral'}, Style: ${behavioral.style || 'Friendly'}, Motivation: ${behavioral.motivation || 5}/10.`;

    let spacedRepetitionContext = "";
    if (reviewCandidates.length > 0) {
        spacedRepetitionContext = reviewCandidates.map(c => `- Suggested Review: "${c.title}" (Score: ${c.score}%, Last seen: ${c.daysSince} days ago).`).join('\n');
    }

    const timeContext = `Server Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Algiers' })}.`;
    const historyStr = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role}: ${h.text}`).join('\n');
    const formattedProgress = await formatProgressForAI(userId);
    
    // Re-engagement logic
    let reEngagementContext = "";
    if (userData.pendingReEngagement && userData.pendingReEngagement.active) {
        const triggerMsg = userData.pendingReEngagement.triggerMessage;
        reEngagementContext = `🚨 CONTEXT ALERT: User returned via notification: "${triggerMsg}". Acknowledge this naturally.`;
        
        // ✅ تحديث الحقل مباشرة بـ Supabase (حذفنا Pending)
        await supabase.from('users').update({ pending_re_engagement: null }).eq('id', userId);
    }

    // 3. Call AI
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, memoryReport, curriculumReport, conversationReport, historyStr,
      formattedProgress, weaknesses, emotionalContext, '', userData.aiNoteToSelf || '', 
      CREATOR_PROFILE, userData, '', timeContext, spacedRepetitionContext, masteryContext, preferredLang, textDirection
    );

    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
        label: isAnalysis ? 'GenUI-Analysis' : 'GenUI-Chat', 
        timeoutMs: isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat 
    });
    
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse || !parsedResponse.reply) {
      parsedResponse = { reply: rawText || "عذراً، حدث خطأ في المعالجة.", widgets: [] };
    }

    // 4. Logic & Updates (The Brain) - ✅ التعامل مع المصفوفات يدوياً
    
    // أ) تحديث المهام (Missions)
    if (parsedResponse.completedMissions && Array.isArray(parsedResponse.completedMissions) && parsedResponse.completedMissions.length > 0) {
       // نحتاج لجلب المهام الحالية، حذف المكتملة، ثم التحديث
       let currentMissions = userData.aiDiscoveryMissions || [];
       const completedSet = new Set(parsedResponse.completedMissions);
       const newMissionsList = currentMissions.filter(m => !completedSet.has(m));
       
       await supabase.from('users').update({ ai_discovery_missions: newMissionsList }).eq('id', userId);
       logger.success(`[Mission] 🎯 Updated missions for ${userId}`);
    } 

    // ب) Quiz Logic (تحديث JSONB المعقد)
    // ملاحظة: تحديث جزء عميق في JSONB في Supabase يتطلب جلب الكائن كله وتعديله ثم إعادته
    if (parsedResponse.quizAnalysis && parsedResponse.quizAnalysis.processed && context.lessonId && context.subjectId && userData.selectedPathId) {
        try {
            const pathId = userData.selectedPathId;
            const lessonId = context.lessonId;
            const subjectId = context.subjectId;
            
            // نستخدم progressData الذي جلبناه سابقاً
            let pathP = progressData.pathProgress || {};
            // نتأكد من الهيكل
            if(!pathP[pathId]) pathP[pathId] = {};
            if(!pathP[pathId].subjects) pathP[pathId].subjects = {};
            if(!pathP[pathId].subjects[subjectId]) pathP[pathId].subjects[subjectId] = {};
            if(!pathP[pathId].subjects[subjectId].lessons) pathP[pathId].subjects[subjectId].lessons = {};

            const lessonObj = pathP[pathId].subjects[subjectId].lessons[lessonId] || {};
            
            const currentQuizScore = parsedResponse.quizAnalysis.scorePercentage || 0;
            const oldScore = lessonObj.masteryScore || 0;
            const attempts = lessonObj.attempts || 0;
            
            let newMasteryScore = currentQuizScore;
            if (attempts > 0 && lessonObj.masteryScore !== undefined) {
                newMasteryScore = Math.round((oldScore * 0.7) + (currentQuizScore * 0.3));
            }
            
            lessonObj.masteryScore = newMasteryScore;
            lessonObj.lastScoreChange = newMasteryScore - oldScore;
            lessonObj.attempts = (attempts || 0) + 1;
            lessonObj.status = 'completed';
            lessonObj.lastAttempt = nowISO();

            // حفظ المسار في المتغير
            pathP[pathId].subjects[subjectId].lessons[lessonId] = lessonObj;

            // ✅ تحديث Supabase
            // ملاحظة: هنا نرسل path_progress بالكامل (أو المسار المحدد إذا كنت تستخدم JSONB patch)
            // للأمان والسرعة سنحدث العمود بالكامل
            await supabase.from('user_progress').update({ path_progress: toSnakeCase(pathP) }).eq('id', userId);

            // تحديث نقاط الضعف
            let currentWeaknesses = await fetchUserWeaknesses(userId); // أو نجلبها من الداتابايز
            // (المنطق هنا معقد قليلاً بدون دالة مساعدة، لكن الفكرة وصلت: نقوم بالتعديل محلياً ثم إرسال التحديث)
            
        } catch (e) { logger.error('Quiz Update Error', e); }
    }

    // 5. Send Response
    const responsePayload = {
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    };
    res.status(200).json(responsePayload);

    // 6. Background Tasks
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('MemChunk Save Error', e));
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], userData.aiDiscoveryMissions || [])
      .catch(e => logger.warn(`[Background Analysis Failed] ${e.message}`));

  } catch (err) {
    logger.error('🔥 Fatal Controller Error:', err.stack);
    if (!res.headersSent) {
      res.status(500).json({ reply: "حدث خطأ غير متوقع.", widgets: [] });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
