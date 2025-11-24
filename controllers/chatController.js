
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName,
  saveChatSession, getCachedEducationalPathById 
} = require('../services/data/helpers');

// Managers
const { runMemoryAgent, saveMemoryChunk } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { getOptimalStudyTime } = require('../services/data/helpers');
const { escapeForPrompt, safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const CREATOR_PROFILE = require('../config/creator-profile');

// محاولة استيراد نظام التعليم
let EDU_SYSTEM;
try {
  EDU_SYSTEM = require('../config/education-system');
} catch (e) {
  EDU_SYSTEM = { info: "Standard Algerian Curriculum" };
}

let generateWithFailoverRef;

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Chat Controller requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (GenUI + Scheduler + Time Aware).');
}

const db = getFirestoreInstance();

// --- Helper: Format Time for Memory ---
function formatMemoryTime(memoryObject) {
  if (!memoryObject) return "";
  const ts = memoryObject.timestamp || null;
  const val = memoryObject.value || memoryObject.text || memoryObject;
  
  if (!ts) return val;

  const eventDate = new Date(ts);
  const now = new Date();
  const diffMs = now - eventDate;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  let timeString = "";
  if (diffHours < 1) timeString = "Just now";
  else if (diffHours < 24) timeString = `${Math.floor(diffHours)} hours ago`;
  else if (diffDays < 2) timeString = "Yesterday";
  else timeString = `${Math.floor(diffDays)} days ago`;

  return `(${timeString}): ${val}`;
}

// --- MAIN ROUTE: Interactive Chat ---
async function chatInteractive(req, res) {
  try {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    // 1. Session Management
    let sessionId = clientSessionId;
    let chatTitle = 'New Chat';
    if (!sessionId) {
      sessionId = `chat_${Date.now()}_${userId.slice(0, 5)}`;
      chatTitle = message.substring(0, 30);
    }

    // 2. Parallel Data Retrieval
    const [
      memoryReport,
      curriculumReport,
      conversationReport,
      userDocSnapshot,
      progressDocSnapshot, // ✅ جلبنا التقدم هنا لنستخدمه لاحقاً
      weaknesses
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
    const memory = userData.memory || {};

    // 3. ✅ حساب التوقيت
    const now = new Date();
    const algiersHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Algiers', hour: 'numeric', hour12: false }).format(now));
    
    const timeContext = `
    - **Current Algiers Hour:** ${algiersHour}.
    - **Phase:** ${algiersHour < 5 ? "Late Night (Sleep/Fajr)" : algiersHour < 12 ? "Morning" : "Evening"}.
    `;

    // 4. Context Preparation
    let emotionalContext = '';
    if (memory.emotions && Array.isArray(memory.emotions)) {
       const recent = memory.emotions.slice(-3).reverse().map(formatMemoryTime).join('\n- '); 
       if (recent) emotionalContext = `Recent Emotions:\n- ${recent}`;
    }
    
    let romanceContext = '';
    if (memory.romance && Array.isArray(memory.romance)) {
       const recent = memory.romance.slice(-2).reverse().map(formatMemoryTime).join('\n- ');
       if (recent) romanceContext = `❤️ Romance:\n- ${recent}`;
    }

    const noteToSelf = userData.aiNoteToSelf || '';
    const systemContext = Object.entries(EDU_SYSTEM || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    // 5. Gap Analysis
    const lastExit = userData.lastExitContext || null;
    let gapContext = "";

    if (lastExit) {
        const lastTime = new Date(lastExit.timestamp);
        const diffMinutes = (now - lastTime) / (1000 * 60); 
        
        if (diffMinutes < 1440) {
             gapContext = `**PREVIOUS EXIT:** User said "${lastExit.state}" ${Math.floor(diffMinutes)} mins ago.`;
        }
        // تنظيف السياق القديم
        db.collection('users').doc(userId).update({ 
            lastExitContext: admin.firestore.FieldValue.delete() 
        }).catch(() => {});
    }

    // 6. 🔥 Prepare Mastery & Direction (ذاكرة المؤسس + اللغة)
    let masteryContext = "New Topic (No prior data observed).";
    let preferredLang = "Arabic";
    let textDirection = "rtl";

    if (userData.selectedPathId && context.subjectId) {
        // أ. استخراج المعدل والفرق (Delta)
        const lessonData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
        if (lessonData && lessonData.masteryScore !== undefined) {
            const score = lessonData.masteryScore;
            const lastDelta = lessonData.lastScoreChange || 0;
            let trend = "stable";
            if (lastDelta > 0) trend = `IMPROVED by +${lastDelta}%`;
            else if (lastDelta < 0) trend = `DROPPED by ${lastDelta}%`;
            masteryContext = `Current Mastery: ${score}% (${trend} since last quiz).`;
        }

        // ب. استخراج اتجاه النص ولغة المادة
        const pathData = await getCachedEducationalPathById(userData.selectedPathId);
        const subject = pathData?.subjects?.find(s => s.id === context.subjectId);
        if (subject) {
            if (subject.defaultLang) preferredLang = subject.defaultLang;
            if (subject.direction) textDirection = subject.direction;
        }
    }

    // 7. Prepare History & Prompt
    const historyStr = (Array.isArray(history) ? history.slice(-5) : [])
      .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 500)}`)
      .join('\n');
    
    const formattedProgress = await formatProgressForAI(userId);

    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,            
      memoryReport,       
      curriculumReport,   
      conversationReport, 
      historyStr,           
      formattedProgress,  
      weaknesses,         
      emotionalContext,   
      romanceContext,     
      noteToSelf,         
      CREATOR_PROFILE,    
      userData,           
      systemContext,
      timeContext, 
      gapContext,
      masteryContext, // ✅ New
      preferredLang,  // ✅ New
      textDirection   // ✅ New
    );

    // 6. Call AI
    // ✅ التعديل: استخدام مهلة أطول إذا كان السياق "تحليل" أو كويز، وإلا استخدام مهلة الشات
    const isAnalysisContext = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const timeoutSetting = isAnalysisContext ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat;

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'GenUI-Chat', 
      timeoutMs: timeoutSetting // ✅ استخدام المهلة الديناميكية (60 ثانية للتحليل)
    });


    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // 9. 🔥 ANALYSIS Logic: Algorithm + Scheduler
    if (parsedResponse.quizAnalysis && parsedResponse.quizAnalysis.processed) {
        const analysis = parsedResponse.quizAnalysis;
        const lessonId = context.lessonId;
        const subjectId = context.subjectId;
        const pathId = userData.selectedPathId;

        // أ. تحديث الدرجات (الخوارزمية الرياضية)
        if (lessonId && subjectId && pathId) {
            const lessonPath = `pathProgress.${pathId}.subjects.${subjectId}.lessons.${lessonId}`;
            const oldLessonData = progressData.pathProgress?.[pathId]?.subjects?.[subjectId]?.lessons?.[lessonId] || {};
            const oldScore = oldLessonData.masteryScore || 0;
            const quizScore = analysis.scorePercentage || 0;

            // 🧮 المعادلة: (القديم * 0.7) + (الجديد * 0.3)
            let newMasteryScore = quizScore;
            if ((oldLessonData.attempts || 0) > 0) {
                newMasteryScore = Math.round((oldScore * 0.7) + (quizScore * 0.3));
            }

            const scoreDelta = newMasteryScore - oldScore;

            const updates = {
                [`${lessonPath}.masteryScore`]: newMasteryScore,
                [`${lessonPath}.lastScoreChange`]: scoreDelta,
                [`${lessonPath}.status`]: 'completed',
                [`${lessonPath}.lastAttempt`]: new Date().toISOString(),
                [`${lessonPath}.attempts`]: admin.firestore.FieldValue.increment(1)
            };

            if (!analysis.passed) {
                updates['weaknesses'] = admin.firestore.FieldValue.arrayUnion(lessonId);
            } else {
                updates['weaknesses'] = admin.firestore.FieldValue.arrayRemove(lessonId);
            }

            // حفظ التحديثات
            await db.collection('userProgress').doc(userId).update(updates).catch(() => {
                 db.collection('userProgress').doc(userId).set(updates, { merge: true });
            });
            logger.info(`[Algorithm] ${lessonId}: New=${newMasteryScore}, Delta=${scoreDelta}`);
        }

        // ب. الجدولة الذكية (Smart Scheduler)
        // ✅ هذا الجزء كان ناقصاً في كودك
        const tasksRef = db.collection('scheduledActions');
        const pendingReviews = await tasksRef
            .where('userId', '==', userId)
            .where('type', '==', 'smart_review')
            .where('context.lessonId', '==', lessonId)
            .where('status', '==', 'pending')
            .get();

        if (analysis.passed) {
            // نجح: إلغاء العقاب
            if (!pendingReviews.empty) {
                const batch = db.batch();
                pendingReviews.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
        } else {
            // رسب: جدولة مراجعة
            const optimalTime = await getOptimalStudyTime(userId);
            if (!pendingReviews.empty) {
                await pendingReviews.docs[0].ref.update({
                    executeAt: admin.firestore.Timestamp.fromDate(optimalTime),
                    "context.retryCount": admin.firestore.FieldValue.increment(1)
                });
            } else {
                await tasksRef.add({
                    userId,
                    type: 'smart_review',
                    title: 'مراجعة ذكية 🧠',
                    executeAt: admin.firestore.Timestamp.fromDate(optimalTime),
                    status: 'pending',
                    context: {
                        lessonId: lessonId || 'general',
                        lessonTitle: context.lessonTitle || 'الدرس',
                        retryCount: 1
                    },
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    }

    // Fallback Response
    if (!parsedResponse || !parsedResponse.reply) {
      parsedResponse = {
        reply: rawText || "عذراً، حدث خطأ تقني بسيط. هل يمكنك إعادة السؤال؟",
        widgets: [],
        needsScheduling: false
      };
    }

    // 10. Triggers & Saving
    if (parsedResponse.needsScheduling === true) {
       const fullHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }];
       analyzeSessionForEvents(userId, fullHistory).catch(() => {});
    }

    if (parsedResponse.userExitState) {
        await db.collection('users').doc(userId).update({
            lastExitContext: { state: parsedResponse.userExitState, timestamp: new Date().toISOString() }
        });
    }

    if (parsedResponse.newFact) {
        const { category, value } = parsedResponse.newFact;
        if (category && value) {
            const updates = {};
            updates[`memory.${category}`] = admin.firestore.FieldValue.arrayUnion({ value, timestamp: new Date().toISOString() });
            db.collection('users').doc(userId).set(updates, { merge: true }).catch(() => {});
        }
    }

    const botReplyText = parsedResponse.reply;
    const widgets = parsedResponse.widgets || [];

    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: botReplyText, widgets: widgets }], context.type || 'main_chat', context)
      .catch(e => logger.error('saveChatSession failed:', e));
    
    saveMemoryChunk(userId, message).catch(() => {});

    // ✅ الرد النهائي (مع الاتجاه)
    res.status(200).json({
      reply: botReplyText,
      widgets: widgets,
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection // ✅ تمرير الاتجاه
    });

  } catch (err) {
    logger.error('/chat-interactive error:', err.stack || err);
    res.status(500).json({ 
      reply: "واجهت مشكلة تقنية بسيطة. حاول مرة أخرى.", 
      widgets: [] 
    });
  }
}

// --- Helper: General Question ---
async function handleGeneralQuestion(message, language, history = [], userProfile = 'No profile.', userProgress = {}, weaknesses = [], formattedProgress = '', studentName = null) {
  const prompt = `You are EduAI.
User: ${studentName || 'Student'}
Context: ${formattedProgress}
Question: "${escapeForPrompt(safeSnippet(message, 2000))}"
Reply in ${language}. Keep it short and helpful.`;

  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion', timeoutMs: CONFIG.TIMEOUTS.chat });
  return await extractTextFromResult(modelResp);
}

// --- Route: Chat Suggestions ---
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    res.status(500).json({ suggestions: ["ما هي مهامي؟", "لخص لي الدرس", "نكتة", "نصيحة"] });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
