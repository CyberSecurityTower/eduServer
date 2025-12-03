'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const { markLessonComplete } = require('../services/engines/gatekeeper'); 
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const { initSessionAnalyzer, analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { refreshUserTasks } = require('../services/data/helpers'); 

// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const { 
  getAlgiersTimeContext, 
  extractTextFromResult, 
  ensureJsonOrRepair, 
  safeSnippet // ✅ New Import
} = require('../utils');

// Helpers
const {
  getProfile, 
  formatProgressForAI,
  saveChatSession, 
  fetchUserWeaknesses, 
  updateAiAgenda 
} = require('../services/data/helpers');

// AI Managers
const { runMemoryAgent, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');

// ✅ Engines (New)
const { explainLessonContent } = require('../services/engines/ghostTeacher'); // ✅ استيراد محرك الشبح

// ✅ EduNexus
const { getNexusMemory, updateNexusKnowledge } = require('../services/ai/eduNexus');

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Context Aware & Identity Mode 🚀).');
}

// ==========================================
// 3. Helper Handlers
// ==========================================
async function handleGeneralQuestion(message, language, studentName) {
  const prompt = `You are EduAI. User: ${studentName}. Q: "${message}". Reply in ${language}. Short.`;
  if (!generateWithFailoverRef) return "Service unavailable.";
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion' });
  return await extractTextFromResult(modelResp);
}

async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('Error generating suggestions:', error);
    res.status(200).json({ suggestions: ["لخص لي الدرس", "أعطني كويز", "ما هي خطتي اليوم؟"] });
  }
}

// ==========================================
// 4. Main Logic: Chat Interactive
// ==========================================
async function chatInteractive(req, res) {
  // ✅ نستقبل currentContext من الفرونت أند
  let { userId, message, history = [], sessionId, currentContext = {} } = req.body;

  // Safety check for history
  if (!Array.isArray(history)) history = [];
  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // ---------------------------------------------------------
    // A. Data Aggregation (Identity First)
    // ---------------------------------------------------------
    const { data: userRaw, error: userError } = await supabase.from('users').select('*, group_id, role').eq('id', userId).single();
    
    if (userError || !userRaw) {
        return res.status(404).json({ reply: "عذراً، لم أتمكن من العثور على حسابك." });
    }

    let userData = toCamelCase(userRaw);

    // --- GROUP ENFORCEMENT logic (from original file) ---
    if (!userData.groupId) {
        const groupMatch = message.match(/(?:فوج|group|groupe|g)\s*(\d+)/i);
        if (groupMatch) {
            const groupNum = groupMatch[1]; 
            const pathId = userData.selectedPathId || 'UAlger3_L1_ITCF'; 
            const newGroupId = `${pathId}_G${groupNum}`;
            
            try {
                await supabase.from('study_groups').upsert({ 
                    id: newGroupId, 
                    path_id: pathId,
                    name: `Group ${groupNum}`
                }, { onConflict: 'id' });

                await supabase.from('users').update({ group_id: newGroupId }).eq('id', userId);
                
                return res.status(200).json({ 
                    reply: `تم! ✅ راك مسجل ضروك في الفوج ${groupNum}.`,
                    sessionId, mood: 'excited'
                });
            } catch (err) {
                return res.status(200).json({ reply: "حدث خطأ تقني.", sessionId });
            }
        } else {
            return res.status(200).json({ reply: "مرحبا! 👋 واش من فوج (Groupe) راك تقرا فيه؟ (اكتب: فوج 1)", sessionId });
        }
    }
    // --- END ENFORCEMENT ---

    // ---------------------------------------------------------
    // ✅ B. Context Injection & Ghost Teacher Logic
    // ---------------------------------------------------------
    let activeLessonContext = "";
    
    if (currentContext.lessonId) {
        // جلب بيانات الدرس المفتوح حالياً
        const { data: lessonData } = await supabase
            .from('lessons')
            .select('*, subjects(title)') // نجلب اسم المادة
            .eq('id', currentContext.lessonId)
            .single();

        if (lessonData) {
            // 👻 Ghost Teacher Logic: إذا الدرس فارغ
            if (!lessonData.has_content) {
                // نتحقق هل الرسالة تدل على طلب شرح؟ (الفرونت أند يرسل "Explain the lesson..." عند الضغط)
                // أو إذا كانت الرسالة قصيرة جداً في سياق درس فارغ
                const isRequestingExplanation = message.toLowerCase().includes('explain') || message.includes('اشرح') || (message.length < 50 && message.includes('?')); 
                
                if (isRequestingExplanation) {
                    logger.info(`👻 Ghost Teacher Triggered for Lesson: ${lessonData.title}`);
                    
                    // 🔥 استدعاء محرك الشبح فوراً
                    const ghostResult = await explainLessonContent(lessonData.id, userId);
                    
                    const replyText = `👻 **المعلم الشبح:**\n\n${ghostResult.content}`;
                    
                    // حفظ في الهيستوري والعودة مبكراً
                    saveChatSession(sessionId, userId, message, [
                        ...history, 
                        { role: 'user', text: message, timestamp: nowISO() }, 
                        { role: 'model', text: replyText, timestamp: nowISO() }
                    ]);

                    return res.status(200).json({
                        reply: replyText,
                        widgets: [],
                        sessionId,
                        mood: 'excited' // الشبح دائماً متحمس
                    });
                } else {
                    // المستخدم في درس فارغ لكن يسأل سؤالاً عاماً
                    activeLessonContext = `User is viewing an EMPTY lesson titled "${lessonData.title}" in subject "${lessonData.subjects?.title || 'Unknown'}". If they ask for content, tell them to click the 'Explain' button or ask you directly to Generate it.`;
                }
            } else {
                // الدرس له محتوى، نجلبه لتعزيز السياق
                const { data: contentData } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonData.id).single();
                
                // استخدام safeSnippet لعدم تجاوز حدود التوكنز
                const snippet = safeSnippet(contentData?.content || "", 1000);
                
                activeLessonContext = `📚 **ACTIVE LESSON CONTEXT:**\nUser is currently reading: "${lessonData.title}" (${lessonData.subjects?.title || ''}).\nContent Snippet: "${snippet}"...\n(Answer questions based on this context if relevant).`;
            }
        }
    }
    // ---------------------------------------------------------

    // Fetch Context Data (Parallel)
    const [rawProfile, memoryReport, curriculumReport, weaknessesRaw, formattedProgress, currentTasks] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''), 
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => ''),
      supabase.from('user_tasks').select('title, type, priority, meta').eq('user_id', userId).eq('status', 'pending')
    ]);

    // تنسيق المهام
   const tasksList = currentTasks.data && currentTasks.data.length > 0 
        ? currentTasks.data.map(t => {
            const creator = (t.meta && t.meta.created_by === 'user') ? '👤 User-Added' : '🤖 AI-Suggested';
            return `- [${creator}] ${t.title} (${t.priority})`;
        }).join('\n')
        : "No active tasks.";
    
    const aiProfileData = rawProfile || {}; 
    const groupId = userData.groupId;

    // 🔥 Identity Injection (System Context)
    const fullUserProfile = { 
        userId: userId,
        firstName: userData.firstName || 'Student', 
        lastName: userData.lastName || '',
        group: groupId,
        role: userData.role || 'student',
        ...aiProfileData, 
        facts: {
            ...(aiProfileData.facts || {}),
            userName: userData.firstName || 'Student',
            userGroup: groupId
        }
    };

    // ---------------------------------------------------------
    // C. Context Preparation
    // ---------------------------------------------------------
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    
    // Agenda Filtering
    const allAgenda = Array.isArray(aiProfileData.aiAgenda) ? aiProfileData.aiAgenda : [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending');

    // Exam Context
    let examContext = {}; 
    if (userData.nextExamDate) {
        const diffDays = Math.ceil((new Date(userData.nextExamDate) - new Date()) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 30) {
            examContext = { daysUntilExam: diffDays, subject: userData.nextExamSubject || 'General' };
        }
    }

    // EduNexus Logic
    let sharedContext = "";
    if (CONFIG.ENABLE_EDUNEXUS && groupId) {
        const nexusMemory = await getNexusMemory(groupId);
        if (nexusMemory && nexusMemory.exams) {
            sharedContext = "🏫 **HIVE MIND (Group Info):**\n";
            Object.entries(nexusMemory.exams).forEach(([subject, data]) => {
                if (data.confirmed_value) {
                    const status = data.is_verified ? "(Verified ✅)" : "(Rumor ⚠️)";
                    sharedContext += `- Exam ${subject}: ${data.confirmed_value} ${status}\n`;
                }
            });
        }
    }
   
    const ageContext = rawProfile.facts?.age ? `User Age: ${rawProfile.facts.age} years old.` : "";
    
    // 🔥 دمج السياقات الجديدة (Active Lesson)
    const systemContextCombined = `
    User Identity: Name=${fullUserProfile.firstName}, Group=${groupId}, Role=${fullUserProfile.role}.
    ${ageContext}
    ${getAlgiersTimeContext().contextSummary}
    ${sharedContext}
    ${activeLessonContext}
    
    📋 **CURRENT TODO LIST:**
    ${tasksList}
    (If the user adds a task that conflicts with their goals or exam schedule, advise them gently).
    `;

    // ---------------------------------------------------------
    // D. AI Generation
    // ---------------------------------------------------------
    
    const safeMessage = message || '';
    
    // دالة تنسيق الوقت
    const formatTimeShort = (isoString) => {
        if (!isoString) return '';
        const date = new Date(isoString);
        return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
    };

    const safeHistoryStr = history.slice(-10).map(h => {
        const timeTag = h.timestamp ? `[${formatTimeShort(h.timestamp)}] ` : ''; 
        return `${timeTag}${h.role === 'model' ? 'EduAI' : 'User'}: ${h.text}`;
    }).join('\n');

    const finalPrompt = PROMPTS.chat.interactiveChat(
      safeMessage, 
      memoryReport || '', 
      curriculumReport || '', 
      safeHistoryStr,
      formattedProgress || '', 
      Array.isArray(weaknessesRaw) ? weaknessesRaw : [], 
      currentEmotionalState, 
      fullUserProfile, 
      systemContextCombined, // ✅ السياق المحدث
      examContext, 
      activeAgenda,
      sharedContext,
      currentContext 
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'MasterChat', timeoutMs: CONFIG.TIMEOUTS.chat });
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // ---------------------------------------------------------
    // E. Action Layer & Agenda Updates
    // ---------------------------------------------------------
    // هل أرسل الـ AI إشارة درس؟
   if (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete') {
        const signal = parsedResponse.lesson_signal;
        
        // 1. تنفيذ الحفظ
        await markLessonComplete(userId, signal.id, signal.score || 100);
        
        // 2. 🔥 حساب الخطوة القادمة فوراً (The Smart Move)
        // نطلب من الخوارزمية مهمة واحدة فقط (الأعلى أولوية)
        const nextMovePlan = await runPlannerManager(userId); 
        const nextTask = nextMovePlan.tasks[0]; // المهمة رقم 1

        let recommendationText = "";
        if (nextTask) {
            recommendationText = `\n\n💡 **الخطوة التالية:** ${nextTask.title} (${nextTask.subjectTitle})`;
            
            // نضيف ويدجت "زر" ليضغط عليه الطالب ويذهب للدرس التالي مباشرة
            parsedResponse.widgets.push({
                type: 'action_button',
                data: { 
                    label: `ابدأ: ${nextTask.title}`, 
                    action: 'navigate', 
                    targetId: nextTask.relatedLessonId 
                }
            });
        }

        // دمج التوصية مع رد الـ AI
        parsedResponse.reply += recommendationText;
        
        // ويدجت الاحتفال
        parsedResponse.widgets.push({ type: 'celebration', data: { message: 'إنجاز عظيم! 🚀' } });
    }
    // 1. EduNexus Updates
    if (CONFIG.ENABLE_EDUNEXUS && parsedResponse.memory_update && groupId) {
        const action = parsedResponse.memory_update;
        if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
            await updateNexusKnowledge(groupId, userId, 'exams', action.subject, action.new_date);
        }
    }

    // 2. Agenda Actions
    if (parsedResponse.agenda_actions && Array.isArray(parsedResponse.agenda_actions)) {
        let currentAgenda = [...allAgenda];
        let agendaUpdated = false;
        for (const act of parsedResponse.agenda_actions) {
             const idx = currentAgenda.findIndex(t => t.id === act.id);
             if (idx !== -1) {
                 agendaUpdated = true;
                 if (act.action === 'complete') {
                     currentAgenda[idx].status = 'completed';
                     currentAgenda[idx].completed_at = nowISO();
                 } else if (act.action === 'snooze') {
                     const until = act.until ? new Date(act.until) : new Date(Date.now() + 86400000);
                     currentAgenda[idx].trigger_date = until.toISOString();
                 }
             }
        }
        if (agendaUpdated) await updateAiAgenda(userId, currentAgenda);
    }

    // 3. Mood Update
    if (parsedResponse.newMood) {
        supabase.from('ai_memory_profiles').update({ 
            emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
            last_updated_at: nowISO()
        }).eq('user_id', userId).then();
    }
    //
    if (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete') {
        const signal = parsedResponse.lesson_signal;
        
        // 1. تنفيذ الحفظ (Gatekeeper)
        await markLessonComplete(userId, signal.id, signal.score || 100);
        
        // 2. 🔥 التحديث الجذري للمهام (The God Mode Update) 🔥
        // سيقوم هذا السطر بمسح المهام القديمة ووضع المهام الجديدة في الداتابيز
        const newDbTasks = await refreshUserTasks(userId); 
        
        // 3. اختيار المهمة الأولى من القائمة الجديدة لاقتراحها في الشات
        const nextTask = newDbTasks[0]; 

        let recommendationText = "";
        if (nextTask) {
            recommendationText = `\n\n💡 **الخطوة التالية (تم تحديث جدولك):** ${nextTask.title}`;
            
            // ويدجت للتنقل
            parsedResponse.widgets.push({
                type: 'action_button',
                data: { 
                    label: `ابدأ: ${nextTask.title}`, 
                    action: 'navigate', 
                    targetId: nextTask.meta?.relatedLessonId 
                }
            });
        }

        // إعلام الفرونت أند بضرورة تحديث قائمة المهام
        parsedResponse.widgets.push({ 
            type: 'event_trigger', 
            data: { event: 'tasks_updated' } // الفرونت أند يستمع لهذا ويعيد طلب /get-daily-tasks
        });

        parsedResponse.reply += recommendationText;
        parsedResponse.widgets.push({ type: 'celebration', data: { message: 'إنجاز عظيم! 🚀' } });
    }
     // ---------------------------------------------------------
    // F. Response
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood 
    });

    // Background processing
    setImmediate(() => {
        const updatedHistory = [
            ...history,
            { role: 'user', text: message, timestamp: nowISO() },
            { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
        ];

        saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory)
            .catch(e => logger.error(e));

        analyzeAndSaveMemory(userId, updatedHistory)
            .catch(e => logger.error(e));

        analyzeSessionForEvents(userId, updatedHistory)
            .catch(e => logger.error('SessionAnalyzer Fail:', e));
    });

  } catch (err) {
      logger.error("ChatInteractive ERR:", err);
      return res.status(500).json({ reply: "حدث خطأ في الخادم." });
  }
} 

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
