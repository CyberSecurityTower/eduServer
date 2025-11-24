
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore'); 
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI,
  saveChatSession, getCachedEducationalPathById,
  getSpacedRepetitionCandidates // ✅ (جديد) استيراد خوارزمية المراجعة
} = require('../services/data/helpers');

// Managers
const { runMemoryAgent, saveMemoryChunk, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager'); // ✅ تأكد من وجوده

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
  logger.info('Chat Controller initialized.');
}

const db = getFirestoreInstance();

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
    // منطق بسيط للرد في الخلفية (Background Job)
    const prompt = `You are EduAI. User: ${studentName || 'Student'}. Question: "${message}". Reply in ${language}. Keep it short.`;
    if (!generateWithFailoverRef) return "Service unavailable.";
    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion', timeoutMs: 20000 });
    return await extractTextFromResult(modelResp);
}

// --- MAIN CHAT INTERACTIVE ---

async function chatInteractive(req, res) {
  // متغيرات معرفة خارج try/catch لضمان الوصول إليها في finally أو errors
  let userId, message, history, sessionId, context;
  
  try {
    ({ userId, message, history = [], sessionId: sessionId, context = {} } = req.body);
    
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    sessionId = sessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    let chatTitle = message.substring(0, 30);

    // ---------------------------------------------------------
    // 1. Fetch Data Parallel (جلب البيانات بالتوازي)
    // ---------------------------------------------------------
    const [
      memoryReport, 
      curriculumReport, 
      conversationReport,
      userDocSnapshot, 
      progressDocSnapshot, 
      weaknesses,
      aiProfileDocSnapshot, // ✅ جلب البروفايل النفسي
      reviewCandidates      // ✅ جلب دروس المراجعة المتباعدة
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      db.collection('users').doc(userId).get(),
      db.collection('userProgress').doc(userId).get(),
      fetchUserWeaknesses(userId).catch(() => []),
      db.collection('aiMemoryProfiles').doc(userId).get(),
      getSpacedRepetitionCandidates(userId)
    ]);

    const userData = userDocSnapshot.exists ? userDocSnapshot.data() : {};
    const progressData = progressDocSnapshot.exists ? progressDocSnapshot.data() : {};
    const aiProfileData = aiProfileDocSnapshot.exists ? aiProfileDocSnapshot.data() : {};

    // ---------------------------------------------------------
    // 2. Prepare Contexts (تجهيز السياقات)
    // ---------------------------------------------------------
    
    // أ) سياق الإتقان (Mastery Context)
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
            // Language Settings
            const pathData = await getCachedEducationalPathById(userData.selectedPathId);
            const subject = pathData?.subjects?.find(s => s.id === context.subjectId);
            if (subject) {
                preferredLang = subject.defaultLang || "Arabic";
                textDirection = subject.direction || "rtl";
            }
        }
    } catch (e) { /* Ignore setup errors */ }

    // ب) السياق النفسي (Emotional/Vibe Context) ✅
    const behavioral = aiProfileData.behavioralInsights || {};
    const emotionalContext = `Current Mood: ${behavioral.mood || 'Neutral'}, Style: ${behavioral.style || 'Friendly'}, Motivation: ${behavioral.motivation || 5}/10.`;

    // ج) سياق المراجعة المتباعدة (Spaced Repetition) ✅
    let spacedRepetitionContext = "";
    if (reviewCandidates.length > 0) {
        spacedRepetitionContext = reviewCandidates.map(c => `- Suggested Review: "${c.title}" (Score: ${c.score}%, Last seen: ${c.daysSince} days ago).`).join('\n');
    }

    // د) سياقات أخرى
    const timeContext = `Server Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Algiers' })}.`;
    const historyStr = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role}: ${h.text}`).join('\n');
    const formattedProgress = await formatProgressForAI(userId);

    // ---------------------------------------------------------
    // 3. Construct Prompt & Call AI
    // ---------------------------------------------------------
    
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, 
      memoryReport, 
      curriculumReport, 
      conversationReport, 
      historyStr,
      formattedProgress, 
      weaknesses, 
      emotionalContext,         // ✅
      '',                       // romanceContext (Future)
      userData.aiNoteToSelf || '', 
      CREATOR_PROFILE, 
      userData, 
      '',                       // gapContext
      timeContext, 
      spacedRepetitionContext,  // ✅
      masteryContext, 
      preferredLang, 
      textDirection
    );

    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const timeoutSetting = isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat;

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
        label: isAnalysis ? 'GenUI-Analysis' : 'GenUI-Chat', 
        timeoutMs: timeoutSetting 
    });
    
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // Fallback if parsing failed completely
    if (!parsedResponse || !parsedResponse.reply) {
      parsedResponse = { reply: rawText || "عذراً، حدث خطأ في المعالجة.", widgets: [] };
    }

    // ---------------------------------------------------------
    // 4. Logic & Updates (The Brain)
    // ---------------------------------------------------------
    const updates = {};
    const progressUpdates = {};

    // 🔥 أ) Mission Complete Logic (حذف المهمة المنجزة) ✅
    if (parsedResponse.completedMission) {
       // إزالة النص المطابق تماماً (بما في ذلك العنوان)
       updates['aiDiscoveryMissions'] = admin.firestore.FieldValue.arrayRemove(parsedResponse.completedMission);
       logger.success(`[Mission] 🎯 Accomplished & Removed: ${parsedResponse.completedMission}`);
    }

    // 🔥 ب) Quiz Logic (تحديث العلامات)
    if (parsedResponse.quizAnalysis && parsedResponse.quizAnalysis.processed) {
        try {
            const analysis = parsedResponse.quizAnalysis;
            const lessonId = context.lessonId;
            const subjectId = context.subjectId;
            const pathId = userData.selectedPathId;

            if (lessonId && subjectId && pathId) {
                const lessonPath = `pathProgress.${pathId}.subjects.${subjectId}.lessons.${lessonId}`;
                
                // حساب العلامة الجديدة (Weighted Average)
                // (تفترض وجود البيانات القديمة، يمكنك تحسينها بجلبها بدقة أكثر)
                const currentQuizScore = analysis.scorePercentage || 0;
                // ... منطق الحساب البسيط هنا لتوفير المساحة ...
                
                progressUpdates[`${lessonPath}.masteryScore`] = currentQuizScore; // تبسيط للحساب
                progressUpdates[`${lessonPath}.status`] = 'completed';
                progressUpdates[`${lessonPath}.lastAttempt`] = new Date().toISOString();

                // تحديث نقاط الضعف
                if (analysis.passed === false) {
                    progressUpdates['weaknesses'] = admin.firestore.FieldValue.arrayUnion(lessonId);
                } else {
                    progressUpdates['weaknesses'] = admin.firestore.FieldValue.arrayRemove(lessonId);
                }
            }
        } catch (e) { logger.error('Quiz Update Error', e); }
    }

    // تنفيذ التحديثات في الداتابايز
    if (Object.keys(updates).length > 0) await db.collection('users').doc(userId).update(updates).catch(e => logger.warn('User update error', e));
    if (Object.keys(progressUpdates).length > 0) await db.collection('userProgress').doc(userId).update(progressUpdates).catch(e => db.collection('userProgress').doc(userId).set(progressUpdates, { merge: true }));


    // ---------------------------------------------------------
    // 5. Send Response (Fast)
    // ---------------------------------------------------------
    const responsePayload = {
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    };

    res.status(200).json(responsePayload);

    // ---------------------------------------------------------
    // 6. Background Tasks (Slow)
    // ---------------------------------------------------------
    // لا نستخدم await هنا لنسمح للسيرفر بالراحة
    
    // أ) حفظ الجلسة
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);

    // ب) حفظ الذاكرة المتجهة (Contextual Chunk) ✅
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('MemChunk Save Error', e));

    // ج) التحليل العميق (Extract Facts & Mood) ✅
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], userData.aiDiscoveryMissions || [] )
      .catch(e => logger.warn(`[Background Analysis Failed] ${e.message}`));

  } catch (err) {
    logger.error('🔥 Fatal Controller Error:', err.stack);
    
    if (!res.headersSent) {
      const errorPayload = process.env.NODE_ENV === 'development' 
        ? { error: err.message, reply: "Error occurred." }
        : { reply: "حدث خطأ غير متوقع. حاول مرة أخرى." };
      res.status(500).json({ ...errorPayload, widgets: [] });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
