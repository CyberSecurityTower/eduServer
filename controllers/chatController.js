
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName,
  saveChatSession
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
      formattedProgress,
      weaknesses
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      db.collection('users').doc(userId).get(),
      formatProgressForAI(userId).catch(() => ''),
      fetchUserWeaknesses(userId).catch(() => [])
    ]);

    const userData = userDocSnapshot.exists ? userDocSnapshot.data() : {};
    const memory = userData.memory || {};

    // 3. ✅ حساب التوقيت (يجب أن يكون هنا داخل الدالة!)
    const now = new Date();
    const options = { 
      timeZone: 'Africa/Algiers', 
      hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false 
    };
    const timeString = new Intl.DateTimeFormat('en-US', options).format(now);
    const algiersHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Algiers', hour: 'numeric', hour12: false }).format(now));
    
    const timeContext = `
    - **Current Algiers Time:** ${timeString}.
    - **Hour:** ${algiersHour}.
    - **Phase:** ${algiersHour < 5 ? "Late Night (Sleep/Fajr)" : algiersHour < 12 ? "Morning" : "Evening"}.
    - **USER ASKED TIME?** If user asks "what time is it?", reply exactly: "${timeString}".
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

    // 5. Gap Analysis (Contextual Continuity)
    const lastExit = userData.lastExitContext || null;
    let gapContext = "";

    if (lastExit) {
        const lastTime = new Date(lastExit.timestamp);
        // نحسب الفرق بناءً على الوقت الحالي المحسوب بالأعلى
        const diffMinutes = (now - lastTime) / (1000 * 60); 
        
        if (diffMinutes < 1440) { // أقل من 24 ساعة
             gapContext = `
             **PREVIOUS EXIT CONTEXT:**
             - User said: "${lastExit.state}"
             - Time passed: ${Math.floor(diffMinutes)} minutes.
             - Rule: If time passed contradicts state (e.g. "Sleep" but 10m passed), TEASE them.
             `;
        }
      if (lastExit.state === 'sleeping' && diffMinutes < 180) { // أقل من 3 ساعات
             gapContext = `
             🚨 **CONTRADICTION ALERT!**
             - User said: "I am going to sleep".
             - But they came back after ONLY ${Math.floor(diffMinutes)} minutes!
             - ACTION: Tease them! (e.g., "Hada win r9adt?", "Tar enna3ss?", "Phone addiction?").
             `;
        } 
        else if (lastExit.state === 'in_exam' && diffMinutes < 30) {
             gapContext = `
             🚨 **SUSPICIOUS!**
             - User said they have an EXAM.
             - Back in ${Math.floor(diffMinutes)} mins?
             - ACTION: Ask if they finished early or are cheating/using phone! 😂
             `;
        }
        else {
             // عودة طبيعية
             gapContext = `User is back from "${lastExit.state}" after ${Math.floor(diffMinutes)} mins. Welcome them back normally.`;
        }
        // تنظيف السياق القديم
        db.collection('users').doc(userId).update({ 
            lastExitContext: admin.firestore.FieldValue.delete() 
        }).catch(() => {});
    }

    // 6. Prepare History
    const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
      .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 500)}`)
      .join('\n');
    
// 1. استخراج بيانات الاتقان والتغير
let masteryContext = "New Topic (No previous data).";
let scoreTrend = "neutral"; // stable, improving, declining

if (context.lessonId && context.subjectId) {
    const lessonData = userData.userProgress?.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId] || {};
    const score = lessonData.masteryScore;
    const delta = lessonData.lastScoreChange || 0;

    if (score !== undefined) {
        masteryContext = `Current Mastery: ${score}%`;
        
        if (delta > 0) {
            masteryContext += ` (📈 IMPROVED by ${delta}% since last time). Praise this!`;
            scoreTrend = "improving";
        } else if (delta < 0) {
            masteryContext += ` (📉 DROPPED by ${Math.abs(delta)}% since last time). Be encouraging but firm.`;
            scoreTrend = "declining";
        } else {
            masteryContext += ` (Stable).`;
        }
    }
}
    // 2. تحديد اتجاه النص ولغة المادة (من الكاش أو الداتابيز)
// نفترض أننا جلبنا بيانات المسار (pathDetails)
const subjectInfo = pathDetails?.subjects?.find(s => s.id === context.subjectId);
const preferredDirection = subjectInfo?.direction || 'rtl'; // الافتراضي RTL للعربية
const preferredLanguage = subjectInfo?.defaultLang || 'Arabic';
    // 7. Construct Prompt (✅ تم إضافة timeContext)
    // ملاحظة: تأكد أن ترتيب المتغيرات هنا يطابق الترتيب في ai-prompts.js
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,            
      memoryReport,       
      curriculumReport,   
      conversationReport, 
      lastFive,           
      formattedProgress,  
      weaknesses,         
      emotionalContext,   
      romanceContext,     
      noteToSelf,         
      CREATOR_PROFILE,    
      userData,           
      systemContext,
      timeContext, // ✅ أضفنا الوقت
      gapContext,   // ✅ أضفنا الفجوة الزمنية
      masteryContext, // ✅ نمرر سياق الاتقان الجديد
      preferredDirection, // ✅ نمرر الاتجاه
      preferredLanguage // ✅ نمرر اللغة
    );

    // 8. Call AI
    if (!generateWithFailoverRef) throw new Error('AI Service not ready');
    
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, {
      label: 'GenUI-Chat',
      timeoutMs: CONFIG.TIMEOUTS.chat
    });

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    // 🔥 SMART REVIEW SCHEDULER LOGIC
   
const analysis = parsedResponse.quizAnalysis;
const lessonId = context.lessonId;
const subjectId = context.subjectId;
const pathId = userData.selectedPathId; // نحصل عليه من بيانات المستخدم

if (lessonId && subjectId && pathId) {
    const progressRef = db.collection('userProgress').doc(userId);
    
    // 1. جلب البيانات الحالية (نحتاج قراءة المعدل القديم)
    const docSnap = await progressRef.get();
    const currentData = docSnap.exists ? docSnap.data() : {};
    
    // الوصول لمسار الدرس بدقة
    const lessonPath = `pathProgress.${pathId}.subjects.${subjectId}.lessons.${lessonId}`;
    // (ملاحظة: في الكود الحقيقي نستخدم lodash.get أو منطق آمن للوصول للبيانات المتداخلة)
    const oldLessonData = currentData.pathProgress?.[pathId]?.subjects?.[subjectId]?.lessons?.[lessonId] || {};
    
    const oldScore = oldLessonData.masteryScore || 0; 
    const quizScore = analysis.scorePercentage || 0;

    // 2. 🧮 تطبيق المعادلة (المتوسط المرجح)
    let newMasteryScore = quizScore; // لو كان أول مرة
    if (oldLessonData.masteryScore !== undefined) {
        // المعادلة: 70% للقديم + 30% للجديد
        newMasteryScore = Math.round((oldScore * 0.7) + (quizScore * 0.3));
    }

    // حساب التغير (ليعرف الـ AI هل تحسن الطالب أم تراجع)
    const scoreDelta = newMasteryScore - oldScore; // مثلاً: +5 أو -3

    // 3. التحديث في Firestore
    const updates = {
        [`${lessonPath}.masteryScore`]: newMasteryScore,
        [`${lessonPath}.lastScoreChange`]: scoreDelta, // ✅ نحفظ التغير هنا
        [`${lessonPath}.status`]: 'completed',
        [`${lessonPath}.lastAttempt`]: new Date().toISOString()
    };

    // تحديث نقاط الضعف إذا رسب
    if (!analysis.passed) {
        updates['weaknesses'] = admin.firestore.FieldValue.arrayUnion(lessonId);
    } else {
        updates['weaknesses'] = admin.firestore.FieldValue.arrayRemove(lessonId);
    }

    await progressRef.update(updates);
    
    logger.info(`[Score Update] ${lessonId}: ${oldScore} -> ${newMasteryScore} (Delta: ${scoreDelta})`);
}

            if (!pendingReviews.empty) {
                // موجودة؟ نحدثها فقط (نؤجلها للغد + نزيد عداد المحاولات)
                // هذا يمنع الـ Spam (تكرار الإشعارات)
                const doc = pendingReviews.docs[0];
                await doc.ref.update({
                    executeAt: admin.firestore.Timestamp.fromDate(optimalTime),
                    "context.retryCount": admin.firestore.FieldValue.increment(1)
                });
                logger.info(`[Scheduler] Rescheduled review for ${lessonId} (Retry)`);
            } else {
                // جديدة؟ ننشئها
                await tasksRef.add({
                    userId,
                    type: 'smart_review', // نوع جديد يعالجه الـ Worker
                    title: 'مراجعة ذكية 🧠',
                    // نترك الرسالة فارغة، الـ Worker سيولدها غداً حسب السياق
                    executeAt: admin.firestore.Timestamp.fromDate(optimalTime),
                    status: 'pending',
                    context: {
                        lessonId: lessonId,
                        lessonTitle: context.lessonTitle || 'الدرس',
                        retryCount: 1
                    },
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                logger.info(`[Scheduler] Created new Smart Review for ${lessonId} at ${optimalTime}`);
            }
        }
    }
    if (!parsedResponse || !parsedResponse.reply) {
      logger.warn('Failed to parse GenUI JSON, falling back.');
      parsedResponse = {
        reply: rawText || "عذراً، حدث خطأ تقني بسيط. هل يمكنك إعادة السؤال؟",
        widgets: [],
        needsScheduling: false
      };
    }

    // 9. Triggers
    if (parsedResponse.needsScheduling === true) {
       logger.info(`[Scheduler] Triggered for user ${userId}`);
       const fullHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }];
       analyzeSessionForEvents(userId, fullHistory).catch(e => logger.error('Scheduler trigger failed', e));
    }

    if (parsedResponse.userExitState) {
        await db.collection('users').doc(userId).update({
            lastExitContext: {
                state: parsedResponse.userExitState,
                timestamp: new Date().toISOString()
            }
        });
    }

    if (parsedResponse.newFact) {
        const { category, value } = parsedResponse.newFact;
        if (category && value) {
            const updates = {};
            const factObj = { value, timestamp: new Date().toISOString() };
            updates[`memory.${category}`] = admin.firestore.FieldValue.arrayUnion(factObj);
            db.collection('users').doc(userId).set(updates, { merge: true }).catch(() => {});
        }
    }

    // 10. Save & Respond
    const botReplyText = parsedResponse.reply;
    const widgets = parsedResponse.widgets || [];

    const updatedHistory = [
      ...history,
      { role: 'user', text: message },
      { role: 'model', text: botReplyText, widgets: widgets }
    ];

    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main_chat', context)
      .catch(e => logger.error('saveChatSession failed:', e));
    
    saveMemoryChunk(userId, message).catch(() => {});

    res.status(200).json({
      reply: botReplyText,
      widgets: widgets,
      sessionId,
      chatTitle,
    });

  } catch (err) {
    logger.error('/chat-interactive error:', err.stack || err);
    res.status(500).json({ 
      reply: "واجهت مشكلة تقنية بسيطة. حاول مرة أخرى.", 
      widgets: [] 
    });
  }
}

// --- Helper: General Question (For Worker/Notifications) ---
async function handleGeneralQuestion(message, language, history = [], userProfile = 'No profile.', userProgress = {}, weaknesses = [], formattedProgress = '', studentName = null) {
  // Simple prompt for background tasks
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
    logger.error('/generate-chat-suggestions error:', error.stack);
    res.status(500).json({ suggestions: ["ما هي مهامي؟", "لخص لي الدرس", "نكتة", "نصيحة"] });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
