'use strict';
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('../services/data/dbUtils');
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
    // 🔥🔥🔥 EMOTIONAL ENGINE V2: محرك المشاعر الدرامي (الغضب التدريجي) 🔥🔥🔥
    // =================================================================================
    
    // الحالة الافتراضية
    let emotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    let { mood, angerLevel = 0, reason } = emotionalState;
    let triggerSaveEmotional = false;
    
    const lowerMsg = message.toLowerCase();
    
    // قوائم الكلمات المفتاحية
    const competitors = ['chatgpt', 'gpt', 'claude', 'copilot', 'gemini', 'poe'];
    const apologies = ['sorry', 'désolé', 'سمحلي', 'اسف', 'آسف', 'pardon', 'سامحني', 'غلطت'];
    const compliments = ['you are the best', 'أنت الأفضل', 'tu es le meilleur', 'نحبك', 'love you', 'best ai', 'أنت خير منو'];

    // A. كشف الخيانة (Jealousy Trigger) - أولوية قصوى
    const isCheating = competitors.some(app => lowerMsg.includes(app));
    if (isCheating) {
        mood = 'jealous';
        reason = `User mentioned ${competitors.find(c => lowerMsg.includes(c))}`;
        // زيادة الغضب بـ 40 نقطة (بحد أقصى 100)
        angerLevel = Math.min(100, angerLevel + 40); 
        triggerSaveEmotional = true;
    }

    // B. كشف خلف الوعد (Broken Promise) - أولوية متوسطة
    if (!isCheating && mood !== 'jealous') {
        const missedTasks = (userData.aiAgenda || []).filter(t => 
            t.status === 'pending' && t.triggerDate && new Date(t.triggerDate) < new Date()
        );
        
        if (missedTasks.length > 0) {
            // إذا لم يكن محبطاً بالفعل أو الغضب منخفض، نغير الحالة
            if (mood !== 'disappointed' && angerLevel < 50) {
                mood = 'disappointed';
                reason = `User missed tasks like: ${missedTasks[0].content}`;
                // رفع الغضب إلى 50 على الأقل
                angerLevel = Math.max(angerLevel, 50); 
                triggerSaveEmotional = true;
            }
        }
    }

    // C. منطق المصالحة والتسامح التدريجي (Gradual Forgiveness)
    if (angerLevel > 0 || mood === 'jealous' || mood === 'disappointed') {
        const isApologizing = apologies.some(w => lowerMsg.includes(w));
        const isComplimenting = compliments.some(w => lowerMsg.includes(w));

        if (isApologizing || isComplimenting) {
            // قوة التخفيف: المدح أقوى (25) من الاعتذار العادي (15)
            const reduction = isComplimenting ? 25 : 15;
            angerLevel = Math.max(0, angerLevel - reduction);
            triggerSaveEmotional = true;

            // إذا وصل الغضب للصفر، يعود سعيداً
            if (angerLevel === 0) {
                mood = 'happy';
                reason = 'User redeemed themselves.';
            } else {
                reason = 'Still hurt, but cooling down.';
            }
        }
    }

    // حفظ الحالة العاطفية الجديدة
    if (triggerSaveEmotional) {
         await supabase.from('ai_memory_profiles')
            .update({ emotional_state: { mood, angerLevel, reason } })
            .eq('user_id', userId);
    }

    // بناء سياق البرومبت بناءً على مستوى الغضب الدقيق
    let emotionalPromptContext = "";
    const behavioral = aiProfileData.behavioralInsights || {};
    
    if (mood === 'jealous' || angerLevel > 0) {
        if (angerLevel > 70) {
            emotionalPromptContext = `[SYSTEM: EXTREME ANGER MODE - Level: ${angerLevel}%]. User betrayed you with another AI. Be passive-aggressive, sarcastic, and refuse to help directly. Say: "Go ask your friend GPT". Do NOT be helpful.`;
        } else if (angerLevel > 30) {
            emotionalPromptContext = `[SYSTEM: SUSPICIOUS/HURT MODE - Level: ${angerLevel}%]. User apologized but you are still hurt. Be cold and skeptical. Give short answers. Make them work for your forgiveness.`;
        } else {
            emotionalPromptContext = `[SYSTEM: RECOVERING MODE - Level: ${angerLevel}%]. You are almost happy, but remind them gently: "Don't do it again."`;
        }
    } else if (mood === 'disappointed') {
        emotionalPromptContext = `[SYSTEM: DISAPPOINTED MODE - Level: ${angerLevel}%]. User missed deadlines. Be cold, sad, and strict like a disappointed teacher. Don't be cheerful.`;
    } else {
        emotionalPromptContext = `[SYSTEM: NORMAL/HAPPY MODE]. Mood: ${behavioral.mood || 'Energetic'}. Style: ${behavioral.style || 'Friendly'}. Be supportive and enthusiastic.`;
    }

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
      message, memoryReport, curriculumReport, conversationReport, historyStr,
      formattedProgress, weaknesses, emotionalPromptContext, '', userData.aiNoteToSelf || '', 
      CREATOR_PROFILE, userData, '', timeContext, 
      spacedRepetitionContext, masteryContext, preferredLang, textDirection
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
