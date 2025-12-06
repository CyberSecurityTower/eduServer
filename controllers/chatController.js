'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');
const { markLessonComplete, trackStudyTime } = require('../services/engines/gatekeeper'); 
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const { initSessionAnalyzer, analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { refreshUserTasks, getLastActiveSessionContext } = require('../services/data/helpers');
const { getHumanTimeDiff } = require('../utils');
// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const {
  getAlgiersTimeContext,
  extractTextFromResult,
  ensureJsonOrRepair,
  safeSnippet
} = require('../utils');

// Helpers
const {
  getProfile,
  formatProgressForAI,
  saveChatSession,
  fetchUserWeaknesses,
  updateAiAgenda,
  getStudentScheduleStatus // <-- added helper import
} = require('../services/data/helpers');

// AI Managers
const { runMemoryAgent, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');

// ✅ Engines
const { explainLessonContent } = require('../services/engines/ghostTeacher');

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
  // ✅ نستقبل البيانات من الفرونت أند
  let { userId, message, history = [], sessionId, currentContext = {} } = req.body;

  // Safety check
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!Array.isArray(history)) history = [];

  try {
    // =========================================================
    // 1. SMART HISTORY RESTORATION & BRIDGING
    // =========================================================
    // 🛑 التعديل هنا: إذا كان الهيستوري فارغاً، نحاول جلبه من الداتابيز
    if (!history || history.length === 0) {
      // أ. محاولة جلب الجلسة الحالية (Refresh Scenario)
      const { data: sessionData } = await supabase
        .from('chat_sessions')
        .select('messages')
        .eq('id', sessionId)
        .single();

      if (sessionData && sessionData.messages && sessionData.messages.length > 0) {
        // تحويل صيغة الداتابيز (author) إلى صيغة الـ AI (role)
        history = sessionData.messages.map(m => ({
          role: m.author === 'bot' ? 'model' : 'user',
          text: m.text,
          timestamp: m.timestamp
        }));
        // نأخذ آخر 10 رسائل فقط لتوفير التوكنز
        history = history.slice(-10);
      } else {
        // ب. إذا لم توجد جلسة حالية، نحاول جلب سياق من جلسة سابقة (Bridging Scenario)
        const bridgeContext = await getLastActiveSessionContext(userId, sessionId);
        if (bridgeContext) {
          history = bridgeContext.messages;
        }
      }
    }

    // =========================================================
    // 2. Data Aggregation (Identity First)
    // =========================================================
    const { data: userRaw, error: userError } = await supabase
      .from('users')
      .select('*, group_id, role')
      .eq('id', userId)
      .single();

    if (userError || !userRaw) {
      return res.status(404).json({ reply: "عذراً، لم أتمكن من العثور على حسابك." });
    }

    let userData = toCamelCase(userRaw);

    // =========================================================
    // 3. GROUP ENFORCEMENT LOGIC
    // =========================================================
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
            sessionId,
            mood: 'excited'
          });
        } catch (err) {
          console.error("Group Update Error:", err);
          return res.status(200).json({ reply: "حدث خطأ تقني أثناء تسجيل الفوج.", sessionId });
        }
      } else {
        return res.status(200).json({
          reply: "مرحبا! 👋 واش من فوج (Groupe) راك تقرا فيه؟ (اكتب: فوج 1)",
          sessionId
        });
      }
    }

    // ---------------------------------------------------------
    // ✅ B. Context Injection & Ghost Teacher Logic
    // ---------------------------------------------------------
    let activeLessonContext = "";

    if (currentContext.lessonId) {
      const { data: lessonData } = await supabase
        .from('lessons')
        .select('*, subjects(title)')
        .eq('id', currentContext.lessonId)
        .single();

      if (lessonData) {
        // 👻 Ghost Teacher Logic
        if (!lessonData.has_content) {
          const isRequestingExplanation = message.toLowerCase().includes('explain') || message.includes('اشرح') || (message.length < 50 && message.includes('?'));

          if (isRequestingExplanation) {
            const ghostResult = await explainLessonContent(lessonData.id, userId);
            const replyText = `👻 **المعلم الشبح:**\n\n${ghostResult.content}`;

            // حفظ فوري
            saveChatSession(sessionId, userId, message, [
              ...history,
              { role: 'user', text: message, timestamp: nowISO() },
              { role: 'model', text: replyText, timestamp: nowISO() }
            ]);

            return res.status(200).json({
              reply: replyText,
              widgets: [],
              sessionId,
              mood: 'excited'
            });
          } else {
            activeLessonContext = `User is viewing an EMPTY lesson titled "${lessonData.title}". If they ask for content, tell them to click 'Explain'.`;
          }
        } else {
          const { data: contentData } = await supabase.from('lessons_content').select('content').eq('lesson_id', lessonData.id).single();
          const snippet = safeSnippet(contentData?.content || "", 1000);
          activeLessonContext = `📚 **ACTIVE LESSON CONTEXT:**\nUser is reading: "${lessonData.title}".\nSnippet: "${snippet}"...\n`;
        }
      }
    }

    // Fetch Context Data (Parallel)
    // ✅ FIX 1: Renamed 'currentTasks' to 'userTasksRes' to match usage below
    const [rawProfile, memoryReport, curriculumReport, weaknessesRaw, formattedProgress, userTasksRes] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => ''),
      supabase.from('user_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'pending')
    ]);

    // ✅ NEW: جلب حالة الجدول الزمني
    let scheduleStatus = null;
    let scheduleContextString = "";
    try {
      scheduleStatus = await getStudentScheduleStatus(userData.groupId);
      if (scheduleStatus) {
        scheduleContextString = scheduleStatus.context || "";
      }
    } catch (e) {
      logger.warn('getStudentScheduleStatus failed:', e);
      scheduleContextString = "";
    }

    // 🔥 التصحيح هنا: نمرر الكائن كاملاً بدلاً من اختيار حقول محددة
    const updatedContextForPrompt = {
      ...currentContext,
      schedule: scheduleStatus || { state: 'unknown' } // ✅ مررنا كل شيء (prof, room, subject...)
    };

    // 🔥 معالجة بيانات الجاذبية (Gravity Intel)
    let gravityContext = null;
    let tasksList = "No active tasks.";

    // ✅ FIX 2: Properly structured the IF block and closed it with '}'
    if (userTasksRes && userTasksRes.data && userTasksRes.data.length > 0) {
      // 1. ترتيب المهام حسب السكور (الموجود داخل meta) تنازلياً
      const sortedTasks = userTasksRes.data.sort((a, b) => {
        const scoreA = a.meta?.score || 0;
        const scoreB = b.meta?.score || 0;
        return scoreB - scoreA; // الأكبر أولاً
      });

      // 2. التقاط "مهمة الجاذبية القصوى" (Top Priority)
      const topTask = sortedTasks[0];
      const topScore = topTask.meta?.score || 0;
      const isExamEmergency = topScore > 4000; // سكور الطوارئ الذي وضعناه

      gravityContext = {
        title: topTask.title,
        score: topScore,
        isExam: isExamEmergency,
        subject: topTask.meta?.subjectId || 'General'
      };

      // 3. تنسيق القائمة للعرض العام
      tasksList = sortedTasks.map(t => {
        const score = t.meta?.score || 0;
        const examBadge = score > 4000 ? "🚨 EXAM TOMORROW" :
          score > 1000 ? "⚠️ EXAM SOON" : "";
        return `- ${t.title} ${examBadge} (Priority: ${score})`;
      }).join('\n');
    }
// Exam Context
let examContext = {};
if (userData.nextExamDate) {
  // 👇 بدلاً من حساب الأيام يدوياً، نستخدم دالتنا الذكية
  const humanTime = getHumanTimeDiff(userData.nextExamDate);
  
  examContext = { 
      subject: userData.nextExamSubject || 'General',
      timingHuman: humanTime, // "غدوة"، "السيمانة الجاية"
      rawDate: userData.nextExamDate
  };
}
    const aiProfileData = rawProfile || {};
    const groupId = userData.groupId;

    // 🔥 تحويل الـ JSON الجديد إلى نص مقروء (Narrative)
    const facts = aiProfileData.facts || {};
    
    let userBio = "User Profile:\n";
    
    if (facts.identity) {
        userBio += `- Name: ${facts.identity.name} (${facts.identity.role}, ${facts.identity.age}yo).\n`;
    }
    if (facts.social) {
        userBio += `- Circle: Friend ${facts.social.best_friend}, GF ${facts.social.girlfriend}.\n`;
    }
    if (facts.interests) {
        userBio += `- Loves: ${facts.interests.music?.join(', ')} and ${facts.interests.animal}.\n`;
    }
    if (facts.education) {
        userBio += `- Study: ${facts.education.study_style}. Weak in ${facts.education.weaknesses?.[0]}. Strong in ${facts.education.strengths?.[0]}.\n`;
    }
    if (facts.behavior) {
        userBio += `- Style: ${facts.behavior.tone}. Procrastinates by ${facts.behavior.procrastination}.\n`;
    }

    // 🔥 Identity Injection
    const fullUserProfile = {
      userId: userId,
      firstName: userData.firstName || 'Student',
      lastName: userData.lastName || '',
      group: groupId,
      role: userData.role || 'student',
      formattedBio: userBio, // نرسل هذا للبرومبت
      ...aiProfileData
    };

    // ---------------------------------------------------------
    // C. Context Preparation
    // ---------------------------------------------------------
    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    const allAgenda = Array.isArray(aiProfileData.aiAgenda) ? aiProfileData.aiAgenda : [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending');

    // Exam Context
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

   const systemContextCombined = `
    User Identity: Name=${fullUserProfile.firstName}, Group=${groupId}, Role=${fullUserProfile.role}.
    ${ageContext}
    ${getAlgiersTimeContext().contextSummary}
    ${scheduleContextString}
    ${sharedContext}
    ${activeLessonContext}

    📋 **CURRENT TODO LIST:**
    ${tasksList}

    ${examContext.subject ? `🚨 **EXAM ALERT:** Subject: "${examContext.subject}" is happening **${examContext.timingHuman}**. Focus on this immediately!` : ""}
    `;
    // ---------------------------------------------------------
    // D. AI Generation
    // ---------------------------------------------------------
    const safeMessage = message || '';

    // ✅ تنسيق الهيستوري المحدث للـ Prompt
    const formatTimeShort = (isoString) => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
    };

    const safeHistoryStr = history.map(h => {
      const timeTag = h.timestamp ? `[${formatTimeShort(h.timestamp)}] ` : '';
      // تأكد من التعامل مع role أو author
      const speaker = (h.role === 'model' || h.author === 'bot') ? 'EduAI' : 'User';
      return `${timeTag}${speaker}: ${h.text}`;
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
      systemContextCombined,
      examContext,
      activeAgenda,
      sharedContext,
      updatedContextForPrompt, // <--- pass updated context with schedule info
      gravityContext
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'MasterChat', timeoutMs: CONFIG.TIMEOUTS.chat });
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // ---------------------------------------------------------
    // E. Action Layer & Agenda Updates
    // ---------------------------------------------------------

    // 1. Handle Lesson Completion
    if (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete') {
      const signal = parsedResponse.lesson_signal;

      // أ. تسجيل الإكمال في القاعدة
      await markLessonComplete(userId, signal.id, signal.score || 100);

      // ب. تحديث المهام (Gravity Engine)
      const newDbTasks = await refreshUserTasks(userId);

      // 🔥 FIX 1: استبعاد الدرس الذي انتهى للتو من القائمة الجديدة
      // حتى لو القاعدة مازالت تقول أنه غير مكتمل، نحن نعلم أنه انتهى الآن
      const validNextTasks = (newDbTasks || []).filter(t => t.meta?.relatedLessonId !== signal.id);
      const nextTask = validNextTasks.length > 0 ? validNextTasks[0] : null;

      // 🔥 FIX 2: منطق "روح ترقد" (Sleep Guard)
      const algiersTime = getAlgiersTimeContext(); // دالة موجودة في utils
      const currentHour = algiersTime.hour;
      const isLateNight = currentHour >= 22 || currentHour < 5; // بعد 10 ليلاً
      const isExamEmergency = gravityContext?.isExam; // هل غداً امتحان؟

      let recommendationText = "";

      // السيناريو 1: غداً امتحان + وقت متأخر = أمر بالنوم
      if (isExamEmergency && isLateNight) {
        recommendationText = `\n\n🛑 **حبس هنا!** غدوة عندك امتحان والوقت راه روطار. **روح ترقد دوكا** باش مخك يثبت المعلومات. تصبح على خير! 😴`;

        // نلغي أي زر "ابدأ الدرس" ونضع زر الخروج
        parsedResponse.widgets = (parsedResponse.widgets || []).filter(w => w.type !== 'action_button');
        parsedResponse.widgets.push({
          type: 'action_button',
          data: { label: 'إغلاق التطبيق والنوم 🌙', action: 'close_app' }
        });
      }
      // السيناريو 2: وقت عادي = اقترح الدرس التالي
      else if (nextTask) {
        recommendationText = `\n\n💡 **الخطوة التالية:** ${nextTask.title}`;
        parsedResponse.widgets = parsedResponse.widgets || [];
        parsedResponse.widgets.push({
          type: 'action_button',
          data: { label: `ابدأ: ${nextTask.title}`, action: 'navigate', targetId: nextTask.meta?.relatedLessonId }
        });
      }
      // السيناريو 3: لا توجد مهام
      else {
        recommendationText = `\n\n🎉 كملت كلش لليوم! ارتاح.`;
      }

      parsedResponse.widgets = parsedResponse.widgets || [];
      parsedResponse.widgets.push({ type: 'event_trigger', data: { event: 'tasks_updated' } });
      parsedResponse.reply += recommendationText;
      parsedResponse.widgets.push({ type: 'celebration', data: { message: 'إنجاز عظيم! 🚀' } });
    }

    // 2. EduNexus Updates
    if (CONFIG.ENABLE_EDUNEXUS && parsedResponse.memory_update && groupId) {
      const action = parsedResponse.memory_update;
      if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
        await updateNexusKnowledge(groupId, userId, 'exams', action.subject, action.new_date);
      }
    }

    // 3. Agenda Actions
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

    // 4. Mood Update
    if (parsedResponse.newMood) {
      supabase.from('ai_memory_profiles').update({
        emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
        last_updated_at: nowISO()
      }).eq('user_id', userId).then();
    }

    // ---------------------------------------------------------
    // F. Response & Background Saving
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood
    });

  // Background processing
    setImmediate(async () => { // 👈 أضفنا async هنا
      
      // 🔥 1. تتبع وقت الدراسة عبر الشات
      // إذا كان الطالب يتحدث وفي الخلفية يوجد درس مفتوح (currentContext.lessonId)
      if (currentContext && currentContext.lessonId) {
          // نضيف 60 ثانية لكل رسالة (تقدير لوقت القراءة والتفكير)
          await trackStudyTime(userId, currentContext.lessonId, 60);
      }

      // 2. حفظ الشات (الكود القديم)
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
    if (!res.headersSent) {
      return res.status(500).json({ reply: "حدث خطأ في الخادم." });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
