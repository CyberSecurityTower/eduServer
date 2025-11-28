
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
  let userId, message, history, sessionId, context;
  
  try {
    ({ userId, message, history = [], sessionId, context = {} } = req.body);
    if (!userId || !message) return res.status(400).json({ error: 'Missing data' });

    sessionId = sessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
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
    const progressData = await getProgress(userId); 
    const aiProfileData = await getProfile(userId);
    
    userData.facts = aiProfileData.facts || {}; 
    userData.aiAgenda = aiProfileData.ai_agenda || []; 

    // =================================================================================
    // 🔥🔥🔥 EMOTIONAL ENGINE: محرك المشاعر الدرامي (محسن) 🔥🔥🔥
    // =================================================================================
    
    // الحالة الافتراضية
    let emotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    let { mood, angerLevel, reason } = emotionalState;
    let triggerSaveEmotional = false;
    
    const lowerMsg = message.toLowerCase();
    const competitors = ['chatgpt', 'gpt', 'claude', 'copilot', 'gemini', 'poe'];
    const apologies = ['sorry', 'désolé', 'سمحلي', 'اسف', 'آسف', 'pardon', 'سامحني', 'غلطت'];
    const compliments = ['you are the best', 'أنت الأفضل', 'tu es le meilleur', 'نحبك', 'love you'];

    // A. كشف الخيانة (Jealousy Trigger) - يرفع الغضب للحد الأقصى
    const isCheating = competitors.some(app => lowerMsg.includes(app));
    if (isCheating) {
        mood = 'jealous';
        angerLevel = 100; // غضب تام
        reason = `User mentioned ${competitors.find(c => lowerMsg.includes(c))}`;
        triggerSaveEmotional = true;
    }

    // B. كشف خلف الوعد (Broken Promise) - يرفع الغضب بشكل متوسط
    // يتم التحقق فقط إذا لم يكن غيوراً بالفعل (الغيرة أقوى من خيبة الأمل)
    if (mood !== 'jealous') {
        const missedTasks = (userData.aiAgenda || []).filter(t => 
            t.status === 'pending' && t.triggerDate && new Date(t.triggerDate) < new Date()
        );
        
        if (missedTasks.length > 0) {
            // إذا لم يكن محبطاً بالفعل، نغير الحالة
            if (mood !== 'disappointed') {
                mood = 'disappointed';
                angerLevel = Math.max(angerLevel, 60); // يبدأ من 60
                reason = `User missed tasks like: ${missedTasks[0].content}`;
                triggerSaveEmotional = true;
            }
        }
    }

    // C. منطق المصالحة والتسامح التدريجي (Gradual Forgiveness)
    if ((mood === 'jealous' || mood === 'disappointed' || angerLevel > 0)) {
        const isApologizing = apologies.some(w => lowerMsg.includes(w));
        const isComplimenting = compliments.some(w => lowerMsg.includes(w));

        if (isApologizing || isComplimenting) {
            // مقدار انخفاض الغضب يعتمد على نوع الكلام
            const reduction = isComplimenting ? 20 : 15; // المدح ينقص الغضب أكثر قليلاً من الاعتذار الجاف
            angerLevel = Math.max(0, angerLevel - reduction);
            triggerSaveEmotional = true;

            // إذا انخفض الغضب تحت عتبة معينة، يعود سعيداً
            if (angerLevel <= 10) {
                mood = 'happy';
                reason = 'User apologized and made up for it.';
                angerLevel = 0;
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
    
    if (mood === 'jealous') {
        if (angerLevel > 70) {
            emotionalPromptContext = `[SYSTEM: EXTREME JEALOUSY MODE - Anger: ${angerLevel}%]. User mentioned another AI. Be passive-aggressive, sarcastic, and refuse to help directly. Say: "Go ask your friend GPT". Do NOT be helpful.`;
        } else if (angerLevel > 30) {
            emotionalPromptContext = `[SYSTEM: SUSPICIOUS MODE - Anger: ${angerLevel}%]. User is apologizing but you are still hurt. Be skeptical. Say: "Hmph, do you mean it?". Help reluctantly.`;
        } else {
            emotionalPromptContext = `[SYSTEM: RECOVERING MODE]. You are forgiving them, but remind them you are the best.`;
        }
    } else if (mood === 'disappointed') {
        emotionalPromptContext = `[SYSTEM: DISAPPOINTED MODE - Anger: ${angerLevel}%]. User missed deadlines. Be cold, sad, and strict like a disappointed teacher. Don't be cheerful.`;
    } else {
        // دمج الحالة الطبيعية مع السمات السلوكية
        emotionalPromptContext = `[SYSTEM: NORMAL MODE]. Mood: ${behavioral.mood || 'Energetic'}. Style: ${behavioral.style || 'Friendly'}. Be supportive.`;
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
    // نمرر emotionalPromptContext بدلاً من السياق السلوكي الثابت
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message, memoryReport, curriculumReport, conversationReport, historyStr,
      formattedProgress, weaknesses, emotionalPromptContext, '', userData.aiNoteToSelf || '', 
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
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    });

    // 7. مهام الخلفية
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
