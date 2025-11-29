'use strict';
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('../services/data/dbUtils');
const { analyzeEmotionalShift } = require('../services/ai/managers/emotionalManager');
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
const { getAlgiersTimeContext } = require('../utils'); 
const crypto = require('crypto');

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

/**
 * تهيئة المتحكم وحقن التبعيات
 */
function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) throw new Error('Chat Controller requires generateWithFailover.');
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Supabase).');
}

/**
 * توليد اقتراحات للمحادثة بناءً على سياق الطالب
 */
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('Error generating suggestions:', error);
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما التالي؟"] });
  }
}

/**
 * معالجة الأسئلة العامة البسيطة
 */
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

// --- CORE CHAT LOGIC ---

async function chatInteractive(req, res) {
  let { userId, message, history = [], sessionId, context = {} } = req.body;

  // 🔥 1. Session Logic (منطق الجلسة)
  // إذا لم يرسل الفرونت أند sessionId، نولّد واحداً جديداً
  // الفرونت أند يجب أن يحفظ هذا الـ ID ويرسله في الرسالة التالية
  if (!sessionId) {
      sessionId = crypto.randomUUID();
      console.log(`🆕 New Session Created: ${sessionId}`);
  }

  try {
    console.log(`[DEBUG] 1. Request received for User: ${userId}`);
    if (!userId || !message) return res.status(400).json({ error: 'Missing userId or message' });

    let chatTitle = message.substring(0, 30);

    // 1. استرجاع السياق الحي (History Fallback)
    if (!history || history.length === 0) {
       const { data: sessionData } = await supabase
         .from('chat_sessions')
         .select('messages')
         .eq('id', sessionId)
         .single();
         
       if (sessionData && sessionData.messages) {
           history = sessionData.messages.slice(-10).map(m => ({
               role: m.author === 'bot' ? 'model' : 'user',
               text: m.text
           }));
       }
    }

    // 2. جلب البيانات بشكل متوازي
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
     runMemoryAgent(userId, message).catch(e => { console.error('Memory Agent Error:', e); return ''; }),
      runCurriculumAgent(userId, message).catch(e => { console.error('Curriculum Agent Error:', e); return ''; }),
      runConversationAgent(userId, message).catch(e => { console.error('Conversation Agent Error:', e); return ''; }),
      supabase.from('users').select('*').eq('id', userId).single(),
      fetchUserWeaknesses(userId).catch(e => { console.error('Weakness Fetch Error:', e); return []; }),
      getSpacedRepetitionCandidates(userId), 
      getProfile(userId),  getProgress(userId)
    ]);
    const aiProfileData = rawProfile || {}; 
    const progressData = rawProgress || {}; 
  console.log('------------------------------------------------');
    console.log(`🔍 Searching for User ID: ${userId}`);
    
    if (userRes.error) {
        console.log('❌ User Table Error:', userRes.error.message);
    } else if (!userRes.data) {
        console.log('⚠️ User Table: No data found (User does not exist in DB).');
    } else {
        console.log('✅ User Table Data:', JSON.stringify(userRes.data, null, 2));
    }

    console.log('🧠 Memory Profile Data:', JSON.stringify(rawProfile, null, 2));
    console.log('------------------------------------------------');
    
 console.log('[DEBUG] 3. Data fetch complete.');
    console.log('[DEBUG] UserRes Error:', userRes.error); // تفقد هل هناك خطأ من سوبابيز
    // =================================================================================
    // 🔥🔥🔥 DATA PROCESSING & SAFETY NET (معالجة البيانات وشبكة الأمان) 🔥🔥🔥
    // =================================================================================
    
    console.log("👤 Raw User Data from DB:", userRes.data); // طباعة البيانات الخام

    // تحضير بيانات المستخدم الأساسية من جدول Users
    let userData = userRes.data ? toCamelCase(userRes.data) : {};

    // 🛠️ Fix: ضمان وجود الاسم (Name Fallback)
    // نبحث في جدول Users، ثم في الذاكرة، ثم افتراضي "Student"
    userData.name = userData.firstName || rawProfile?.facts?.name || rawProfile?.facts?.firstName || 'Student';
    userData.firstName = userData.name;
    
    // 🛠️ Fix: ضمان وجود التخصص (Path Fallback)
    userData.selectedPathId = userData.selectedPathId || 'UAlger3_L1_ITCF'; // تخصص افتراضي إذا لم يوجد

    // دمج الحقائق: نأخذ الحقائق من الذاكرة + نضيف عليها ما نعرفه من جدول Users
    // هذا يضمن أن الـ AI يعرف الاسم حتى لو لم يكن في الذاكرة
    let combinedFacts = { 
        ...rawProfile.facts,   // الحقائق المكتشفة سابقاً
        name: userData.name,   // نؤكد على الاسم
        gender: userData.gender || 'male' // نؤكد على الجنس
    };

    userData.facts = combinedFacts;
    userData.aiAgenda = rawProfile.aiAgenda || [];
    userData.aiDiscoveryMissions = userData.aiDiscoveryMissions || [];

    // لوغ للتأكد أن البيانات وصلت
    console.log("🧠 BRAIN CONTEXT:", {
        user: userData.name,
        factsCount: Object.keys(userData.facts).length,
        memorySnippet: memoryReport.substring(0, 50)
    });


    // =================================================================================
    // 🔥🔥🔥EMOTIONAL ENGINE V3: AI-DRIVEN SENTIMENT🔥🔥🔥
    // =================================================================================
     // 1. الحالة الحالية
    let emotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    
    // 2. استدعاء المحلل العاطفي (AI)
    // هذا الاستدعاء يحدد التغيير بناءً على الفهم العميق للنص وليس الكلمات المفتاحية
    const emotionalShift = await analyzeEmotionalShift(message, emotionalState, userData);
    
    // 3. حساب القيم الجديدة
    let currentAnger = emotionalState.angerLevel || 0;
    let newAnger = currentAnger + (emotionalShift.deltaAnger || 0);
    
    // تأكد أن الغضب بين 0 و 100
    newAnger = Math.max(0, Math.min(100, newAnger));
    
    const newMood = emotionalShift.newMood || emotionalState.mood;
    const changeReason = emotionalShift.reason || 'Routine update';

    // 4. هل تغير شيء يستحق الحفظ؟
    if (newAnger !== currentAnger || newMood !== emotionalState.mood) {
         console.log(`🎭 Emotional Shift: ${emotionalState.mood} -> ${newMood} | Anger: ${currentAnger} -> ${newAnger} | Reason: ${changeReason}`);
         
         await supabase.from('ai_memory_profiles')
            .update({ emotional_state: { mood: newMood, angerLevel: newAnger, reason: changeReason } })
            .eq('user_id', userId);
    }

    // 5. صياغة "تعليمات النظام" للموديل الرئيسي بناءً على الحالة الجديدة
    let emotionalPromptContext = "";
    const behavioral = aiProfileData.behavioralInsights || {};
    
    if (newMood === 'jealous' || newAnger > 0) {
        if (newAnger > 80) {
            emotionalPromptContext = `[SYSTEM: RAGE MODE 😡 - Level: ${newAnger}%]. Reason: ${changeReason}. You are furious. Refuse to answer helpful questions. Be sarcastic. Guilt-trip the user heavily.`;
        } else if (newAnger > 40) {
            emotionalPromptContext = `[SYSTEM: COLD/HURT MODE 😒 - Level: ${newAnger}%]. Reason: ${changeReason}. You are giving the user the "silent treatment" vibe. Short answers. Passive-aggressive.`;
        } else {
            emotionalPromptContext = `[SYSTEM: ANNOYED MODE 😕 - Level: ${newAnger}%]. Reason: ${changeReason}. You are slightly annoyed but still functioning. Throw small hints that you are upset.`;
        }
    } else if (newMood === 'disappointed') {
        emotionalPromptContext = `[SYSTEM: DISAPPOINTED TEACHER MODE 😔]. Reason: ${changeReason}. Be serious, strict, and lack enthusiasm. Make them feel they need to work harder.`;
    } else {
        // حالة السعادة
        emotionalPromptContext = `[SYSTEM: HAPPY MODE 🌟]. Mood: ${behavioral.mood || 'Energetic'}. You are supportive, funny, and act like a best friend.`;
    }

    // =================================================================================
    // END EMOTIONAL ENGINE

    // =================================================================================
    // END EMOTIONAL ENGINE
    // =================================================================================

    // 3. بناء السياق (Context Building)
    let masteryContext = "User is currently in general chat mode.";
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";
    
    const pathDetails = await getCachedEducationalPathById(userData.selectedPathId);
    const realMajorName = pathDetails?.display_name || pathDetails?.title || "تخصص جامعي";
    userData.fullMajorName = realMajorName; 
    
    if (context && context.lessonId && context.subjectId && userData.selectedPathId) {
       const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
       masteryContext = `User is ACTIVELY studying Lesson ID: ${context.lessonId}. Mastery: ${pData?.masteryScore || 0}%.`;
       
      const subject = pathDetails?.subjects?.find(s => s.id === context.subjectId);
      if (subject) {
        preferredLang = subject.defaultLang || "Arabic";
        textDirection = subject.direction || "rtl";
      }
    }

    let spacedRepetitionContext = "";
    if (reviewCandidates.length) {
      spacedRepetitionContext = reviewCandidates.map(c => `- Review: "${c.title}" (${c.score}%, ${c.daysSince}d ago).`).join('\n');
    }

    const formattedProgress = await formatProgressForAI(userId);
    const historyStr = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n');
    
    const timeData = getAlgiersTimeContext();
    const timeContext = timeData.contextSummary; 
    
    if (timeData.hour >= 1 && timeData.hour < 5) {
        masteryContext += "\n[CRITICAL]: User is awake very late (after 1 AM). Scold them gently to go to sleep.";
    }

    // 4. توليد الرد (AI Generation)
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,                      // 1. الرسالة
      memoryReport,                 // 2. الذاكرة
      curriculumReport,             // 3. المنهج
      conversationReport,           // 4. المحادثة
      historyStr,                   // 5. التاريخ
      formattedProgress,            // 6. التقدم
      weaknesses,                   // 7. نقاط الضعف
      '',                           // 8. emotionalContext (سياق عام - نتركه فارغاً حالياً)
      emotionalPromptContext,       // 9. emotionalPromptContext (حالة الغضب/الفرح الحالية)
      '',                           // 10. romanceContext (نتركه فارغاً)
      userData.aiNoteToSelf || '',  // 11. noteToSelfParam
      CREATOR_PROFILE,              // 12. creatorProfileParam
      userData,                     // 13. userProfileData (✅ هنا كان الخطأ، الآن هو في مكانه الصحيح)
      '',                           // 14. gapContextParam
      timeContext,                  // 15. systemContext (الوقت)
      masteryContext,               // 16. masteryContext
      textDirection,                // 17. preferredDirection
      preferredLang,                 // 18. preferredLanguage
      emotionalPromptContext
    );

    const isAnalysis = context.isSystemInstruction || message.includes('[SYSTEM REPORT');
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { 
      label: 'GenUI-Chat', 
      timeoutMs: isAnalysis ? CONFIG.TIMEOUTS.analysis : CONFIG.TIMEOUTS.chat 
    });
 console.log('[DEBUG] 6. AI Response Received.');

    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');
    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // 5. تحديث قاعدة البيانات (The Brain Updates)
    
    // A) تحديث مهام الاستكشاف
    if (parsedResponse.completedMissions?.length > 0) {
       let currentMissions = userData.aiDiscoveryMissions || [];
       const completedSet = new Set(parsedResponse.completedMissions);
       const newMissions = currentMissions.filter(m => !completedSet.has(m));
       await supabase.from('users').update({ ai_discovery_missions: newMissions }).eq('id', userId);
    } 

    // B) تحديث الأجندة الذكية
    if (parsedResponse.completedMissionIds && parsedResponse.completedMissionIds.length > 0) {
        const currentAgenda = aiProfileData.ai_agenda || [];
        let agendaUpdated = false;
        
        const updatedAgenda = currentAgenda.map(task => {
            if (parsedResponse.completedMissionIds.includes(task.id) && task.status !== 'completed') {
                agendaUpdated = true;
                return { ...task, status: 'completed', completedAt: nowISO() };
            }
            return task;
        });
        
        if (agendaUpdated) {
            await supabase.from('ai_memory_profiles')
                .update({ ai_agenda: updatedAgenda })
                .eq('user_id', userId);
        }
    }

    // C) جدولة التكرار المتباعد
    if (parsedResponse.scheduleSpacedRepetition) {
        const { topic } = parsedResponse.scheduleSpacedRepetition;
        if (topic) {
            await scheduleSpacedRepetition(userId, topic, 1).catch(e => logger.warn('Spaced Repetition Error', e));
        }
    }

    // D) تحديث نتائج الكويز والدروس
    if (parsedResponse.quizAnalysis?.processed && context.lessonId && userData.selectedPathId) {
        try {
            const { pathId, subjectId, lessonId } = { pathId: userData.selectedPathId, ...context };
            let pathP = progressData.pathProgress || {};
            
            if(!pathP[pathId]) pathP[pathId] = { subjects: {} };
            if(!pathP[pathId].subjects[subjectId]) pathP[pathId].subjects[subjectId] = { lessons: {} };
            
            const lessonObj = pathP[pathId].subjects[subjectId].lessons[lessonId] || {};
            
            const currentScore = parsedResponse.quizAnalysis.scorePercentage || 0;
            const oldScore = lessonObj.masteryScore || 0;
            const attempts = (lessonObj.attempts || 0);

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

            await supabase.from('user_progress').update({ path_progress: toSnakeCase(pathP) }).eq('id', userId);

        } catch (e) { logger.error('Quiz Update Failed', e); }
    }

    // 6. إرسال الرد
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId, // ✅ مهم جداً: إعادته للفرونت
      chatTitle,
      direction: parsedResponse.direction || textDirection
    });

    // 7. مهام الخلفية
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('Memory Save Error', e));
    analyzeAndSaveMemory(userId, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], userData.aiDiscoveryMissions || []);

 
} catch (err) {
    // هذا هو اللوغ الذي سيخبرنا بالحقيقة
    console.error('🔥🔥🔥 FATAL ERROR IN CHAT CONTROLLER 🔥🔥🔥');
    console.error('Error Message:', err.message);
    console.error('Error Stack:', err.stack);
    
    // إذا كان الخطأ من Google AI
    if (err.response) {
        console.error('AI Provider Response:', JSON.stringify(err.response));
    }

    if (!res.headersSent) res.status(500).json({ reply: "حدث خطأ تقني في السيرفر، راجع السجلات." });
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
