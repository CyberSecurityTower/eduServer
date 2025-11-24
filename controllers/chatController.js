
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore'); // ✅ تأكد من وجود admin هنا
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI,
  saveChatSession, getCachedEducationalPathById 
} = require('../services/data/helpers');

// Managers
const { runMemoryAgent, saveMemoryChunk } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { getOptimalStudyTime } = require('../services/data/helpers');
const { extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const CREATOR_PROFILE = require('../config/creator-profile');
const { analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
let generateWithFailoverRef;

// ✅ دالة الاقتراحات (كانت ناقصة في التحديث الأخير)
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    // نستخدم المدير المخصص أو دالة بسيطة
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('/generate-chat-suggestions error:', error.stack);
    // Fallback suggestions
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز سريع", "اشرح لي المفهوم الأساسي"] });
  }
}

// ✅ دالة الأسئلة العامة (للخلفية)
async function handleGeneralQuestion(message, language, history = [], userProfile, userProgress, weaknesses, formattedProgress, studentName) {
    // ... (منطق بسيط للرد في الخلفية)
    const prompt = `You are EduAI.
    User: ${studentName || 'Student'}
    Context: ${formattedProgress}
    Question: "${message}"
    Reply in ${language}. Keep it short and helpful.`;

    if (!generateWithFailoverRef) return "Service unavailable.";
    
    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion', timeoutMs: 20000 });
    return await extractTextFromResult(modelResp);
}
function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Chat Controller requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized.');
}

const db = getFirestoreInstance();

async function chatInteractive(req, res) {
  try {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    let sessionId = clientSessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    let chatTitle = message.substring(0, 30);

    // 1. Fetch Data Parallel
    const [
      memoryReport, curriculumReport, conversationReport,
      userDocSnapshot, progressDocSnapshot, weaknesses
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      db.collection('users').doc(userId).get(),
      db.collection('userProgress').doc(userId).get(),
      fetchUserWeaknesses(userId).catch(() => [])
    ]);

    const userData = userDocSnapshot.exists ? userDocSnapshot.data() : {};
    const progressData = progressDocSnapshot.exists ? progressDocSnapshot.data() : {};
    
    // 2. Prepare Mastery & Delta (Safety Checked)
    let masteryContext = "New Topic (No prior data).";
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";

    try {
        if (context.lessonId && context.subjectId && userData.selectedPathId) {
            const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
            
            if (pData && pData.masteryScore !== undefined) {
                const score = pData.masteryScore;
                const lastDelta = pData.lastScoreChange || 0;
                let trend = lastDelta > 0 ? `IMPROVED +${lastDelta}%` : lastDelta < 0 ? `DROPPED ${lastDelta}%` : "Stable";
                masteryContext = `Current Mastery: ${score}% (${trend}).`;
            }

            // Language & Direction Logic
            const pathData = await getCachedEducationalPathById(userData.selectedPathId);
            const subject = pathData?.subjects?.find(s => s.id === context.subjectId);
            if (subject) {
                if (subject.defaultLang) preferredLang = subject.defaultLang;
                if (subject.direction) textDirection = subject.direction;
            }
        }
    } catch (prepError) {
        logger.warn('Error preparing context details (non-fatal):', prepError.message);
    }

    // 3. Contexts
    const now = new Date();
    const algiersHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Algiers', hour: 'numeric', hour12: false }).format(now));
    const timeContext = `Algiers Hour: ${algiersHour}.`;
    const historyStr = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role}: ${h.text}`).join('\n');
    const formattedProgress = await formatProgressForAI(userId);

    // 4. Construct Prompt
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, memoryReport, curriculumReport, conversationReport, historyStr,
      formattedProgress, weaknesses, '', '', 
      userData.aiNoteToSelf || '', CREATOR_PROFILE, userData, '',
      timeContext, '', 
      masteryContext, preferredLang, textDirection
    );

    // 5. Call AI (With Long Timeout for Analysis)
    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const timeoutSetting = isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat;

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
        label: isAnalysis ? 'GenUI-Analysis' : 'GenUI-Chat', 
        timeoutMs: timeoutSetting 
    });
    
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // 6. 🔥 Logic: Weighted Average Algorithm (Wrapped in Try/Catch)
    if (parsedResponse.quizAnalysis && parsedResponse.quizAnalysis.processed) {
        try {
            const analysis = parsedResponse.quizAnalysis;
            const lessonId = context.lessonId;
            const subjectId = context.subjectId;
            const pathId = userData.selectedPathId;

            if (lessonId && subjectId && pathId) {
                const lessonPath = `pathProgress.${pathId}.subjects.${subjectId}.lessons.${lessonId}`;
                
                // Safe Access to Old Data
                const pathP = progressData.pathProgress || {};
                const pathObj = pathP[pathId] || {};
                const subObj = pathObj.subjects || {};
                const subj = subObj[subjectId] || {};
                const lessonsObj = subj.lessons || {};
                const oldLessonData = lessonsObj[lessonId] || {};

                const oldScore = oldLessonData.masteryScore || 0;
                const currentQuizScore = analysis.scorePercentage || 0;

                // Math Logic
                let newMasteryScore = currentQuizScore;
                const attempts = oldLessonData.attempts || 0;
                
                if (attempts > 0 && oldLessonData.masteryScore !== undefined) {
                    newMasteryScore = Math.round((oldScore * 0.7) + (currentQuizScore * 0.3));
                }

                const scoreDelta = newMasteryScore - oldScore;

                // Updates Object
                const updates = {
                    [`${lessonPath}.masteryScore`]: newMasteryScore,
                    [`${lessonPath}.lastScoreChange`]: scoreDelta,
                    [`${lessonPath}.status`]: 'completed',
                    [`${lessonPath}.lastAttempt`]: new Date().toISOString(),
                    [`${lessonPath}.attempts`]: admin.firestore.FieldValue.increment(1) // ✅ تأكد أن admin معرف
                };

                // Weaknesses
                if (analysis.passed === false) {
                    updates['weaknesses'] = admin.firestore.FieldValue.arrayUnion(lessonId);
                } else {
                    updates['weaknesses'] = admin.firestore.FieldValue.arrayRemove(lessonId);
                }

                // Save
                await db.collection('userProgress').doc(userId).set(updates, { merge: true });
                logger.success(`[Algorithm] Updated Score: ${oldScore} -> ${newMasteryScore}`);
            }
        } catch (mathError) {
            logger.error('❌ Critical Logic Error in Quiz Update:', mathError);
            // لا نوقف الرد، فقط نسجل الخطأ
        }
    }

    // Fallback
    if (!parsedResponse || !parsedResponse.reply) {
      parsedResponse = { reply: rawText || "خطأ في المعالجة.", widgets: [] };
    }

    // 7. Response
    const responsePayload = {
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    };

    // حفظ الجلسة في قاعدة البيانات العادية (للعرض في التطبيق)
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    
    // 🔥 التغيير هنا: نرسل رسالة المستخدم + رد الذكاء الاصطناعي ليتم حفظهما ككتلة واحدة في الذاكرة المتجهة
    saveMemoryChunk(userId, message, parsedResponse.reply);
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }]);
    res.status(200).json(responsePayload);

  } catch (err) {
    // ✅ إرسال الخطأ الحقيقي للفرونت إند لنراه في الـ LOG
    logger.error('🔥 Fatal Controller Error:', err.stack);
    res.status(500).json({ 
        error: `Server Error: ${err.message}`, // إرسال نص الخطأ للتتبع
        reply: "حدث خطأ داخلي في الخادم.", 
        widgets: [] 
    });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion: async () => "Service Unavailable" // Placeholder needed for exports consistency
};
