

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
  scheduleSpacedRepetition // تم إضافتها للتعامل مع الجدولة
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
    // إذا كانت المحادثة فارغة من الفرونت إند، نحاول جلب آخر سياق من قاعدة البيانات
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

    // 2. جلب البيانات بشكل متوازي (Parallel Data Fetching)
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
    
    // إعداد بيانات المستخدم للذكاء الاصطناعي
    userData.facts = aiProfileData.facts || {}; 
    // حقن الأجندة (المهام) في بيانات المستخدم ليراها الـ AI
    userData.aiAgenda = aiProfileData.ai_agenda || []; 

    // 3. بناء السياق (Context Building)
    let masteryContext = "User is currently in general chat mode (Not inside a specific lesson).";
    let textDirection = "rtl"; 
    let preferredLang = "Arabic";
    
    const pathDetails = await getCachedEducationalPathById(userData.selectedPathId);
    const realMajorName = pathDetails?.display_name || pathDetails?.title || "تخصص جامعي";
    userData.fullMajorName = realMajorName; 
    
    // سياق الدرس الحالي (Mastery Context)
    if (context && context.lessonId && context.subjectId && userData.selectedPathId) {
       const pData = progressData.pathProgress?.[userData.selectedPathId]?.subjects?.[context.subjectId]?.lessons?.[context.lessonId];
       masteryContext = `User is ACTIVELY studying Lesson ID: ${context.lessonId}. Mastery: ${pData?.masteryScore || 0}%.`;
       
      const subject = pathDetails?.subjects?.find(s => s.id === context.subjectId);
      if (subject) {
        preferredLang = subject.defaultLang || "Arabic";
        textDirection = subject.direction || "rtl";
      }
    }

    // السياق السلوكي والعاطفي
    const behavioral = aiProfileData.behavioralInsights || {};
    const emotionalContext = `Mood: ${behavioral.mood || 'Neutral'}, Style: ${behavioral.style || 'Friendly'}`;

    // سياق التكرار المتباعد (Spaced Repetition)
    let spacedRepetitionContext = "";
    if (reviewCandidates.length) {
      spacedRepetitionContext = reviewCandidates.map(c => `- Review: "${c.title}" (${c.score}%, ${c.daysSince}d ago).`).join('\n');
    }

    const formattedProgress = await formatProgressForAI(userId);
    const historyStr = history.slice(-5).map(h => `${h.role}: ${h.text}`).join('\n');
    
    // سياق الوقت (توقيت الجزائر)
    const timeData = getAlgiersTimeContext();
    const timeContext = timeData.contextSummary; 
    
    // منطق الوقت المتأخر: توبيخ لطيف إذا كان الوقت بعد 1 صباحاً
    if (timeData.hour >= 1 && timeData.hour < 5) {
        masteryContext += "\n[CRITICAL]: User is awake very late (after 1 AM). Scold them gently to go to sleep.";
    }

    // 4. توليد الرد (AI Generation)
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

    // 5. تحديث قاعدة البيانات (The Brain Updates)
    
    // A) تحديث مهام الاستكشاف (Discovery Missions) - القديم
    if (parsedResponse.completedMissions?.length > 0) {
       let currentMissions = userData.aiDiscoveryMissions || [];
       const completedSet = new Set(parsedResponse.completedMissions);
       const newMissions = currentMissions.filter(m => !completedSet.has(m));
       
       await supabase.from('users').update({ ai_discovery_missions: newMissions }).eq('id', userId);
    } 

    // B) تحديث الأجندة الذكية (AI Agenda) - الجديد
    if (parsedResponse.completedMissionIds && parsedResponse.completedMissionIds.length > 0) {
        const currentAgenda = aiProfileData.ai_agenda || [];
        let agendaUpdated = false;
        
        const updatedAgenda = currentAgenda.map(task => {
            // إذا كانت المهمة موجودة في القائمة المكتملة ولم تكتمل سابقاً
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

    // C) جدولة التكرار المتباعد (Spaced Repetition Scheduling)
    if (parsedResponse.scheduleSpacedRepetition) {
        const { topic } = parsedResponse.scheduleSpacedRepetition;
        if (topic) {
            // جدولة المراجعة الأولى بعد يوم واحد (يمكن تعديل الخوارزمية لاحقاً)
            await scheduleSpacedRepetition(userId, topic, 1).catch(e => logger.warn('Spaced Repetition Error', e));
        }
    }

    // D) تحديث نتائج الكويز والدروس (Quiz / Lesson Logic)
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

            // Weighted Average Calculation
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

    // 6. إرسال الرد (Send Response)
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId,
      chatTitle,
      direction: parsedResponse.direction || textDirection
    });

    // 7. مهام الخلفية (Background Tasks)
    // حفظ الجلسة
    saveChatSession(sessionId, userId, chatTitle, [...history, { role: 'user', text: message }, { role: 'model', text: parsedResponse.reply }], context.type, context);
    
    // حفظ الذاكرة الخام
    saveMemoryChunk(userId, message, parsedResponse.reply).catch(e => logger.warn('Memory Save Error', e));
    
    // تحليل الذاكرة وتحديث البروفايل
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
