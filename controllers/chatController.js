// controllers/chatController.js
'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

// Engines & Managers
const { markLessonComplete, trackStudyTime } = require('../services/engines/gatekeeper'); 
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const { initSessionAnalyzer, analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { runMemoryAgent, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { explainLessonContent } = require('../services/engines/ghostTeacher');
const { getNexusMemory, updateNexusKnowledge } = require('../services/ai/eduNexus');

// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const { getHumanTimeDiff } = require('../utils');
const {
  getAlgiersTimeContext,
  extractTextFromResult,
  ensureJsonOrRepair,
  safeSnippet
} = require('../utils');

// Data Helpers
const {
  getProfile,
  formatProgressForAI,
  saveChatSession,
  fetchUserWeaknesses,
  updateAiAgenda,
  getStudentScheduleStatus,
  refreshUserTasks,
  getLastActiveSessionContext,
  getProgress,         
  getRecentPastExams   
} = require('../services/data/helpers');

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
  // ✅ 1. Receive data from frontend
  let { userId, message, history = [], sessionId, currentContext = {} } = req.body;

  // Safety check
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!Array.isArray(history)) history = [];

  try {
    // =========================================================
    // 2. SMART HISTORY RESTORATION & BRIDGING
    // =========================================================
    // We do this EARLY because we need 'history' to define isFirstTimeUser later
    if (!history || history.length === 0) {
      const { data: sessionData } = await supabase
        .from('chat_sessions')
        .select('messages')
        .eq('id', sessionId)
        .single();

      if (sessionData && sessionData.messages && sessionData.messages.length > 0) {
        history = sessionData.messages.map(m => ({
          role: m.author === 'bot' ? 'model' : 'user',
          text: m.text,
          timestamp: m.timestamp
        }));
        history = history.slice(-10);
      } else {
        const bridgeContext = await getLastActiveSessionContext(userId, sessionId);
        if (bridgeContext) {
          history = bridgeContext.messages;
        }
      }
    }

    // =========================================================
    // 3. FETCH USER DATA (The Fix: Do this BEFORE logic checks)
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
    // 4. GROUP ENFORCEMENT LOGIC
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
    // 5. Context Injection & Ghost Teacher Logic
    // ---------------------------------------------------------
    let activeLessonContext = "";

    if (currentContext.lessonId) {
      const { data: lessonData } = await supabase
        .from('lessons')
        .select('*, subjects(title)')
        .eq('id', currentContext.lessonId)
        .single();

      if (lessonData) {
        if (!lessonData.has_content) {
          const isRequestingExplanation = message.toLowerCase().includes('explain') || message.includes('اشرح') || (message.length < 50 && message.includes('?'));

          if (isRequestingExplanation) {
            const ghostResult = await explainLessonContent(lessonData.id, userId);
            const replyText = `👻 **المعلم الشبح:**\n\n${ghostResult.content}`;

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

    // =========================================================
    // 6. Data Aggregation (Parallel Fetching)
    // =========================================================
    const [
      rawProfile,
      memoryReport,
      curriculumReport,
      weaknessesRaw,
      formattedProgress,
      userTasksRes,
      progressData // ✅ Now we have progress data available for streaks
    ] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => ''),
      supabase.from('user_tasks').select('*').eq('user_id', userId).eq('status', 'pending'),
      getProgress(userId) 
    ]);

    // Schedule Status
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

    const updatedContextForPrompt = {
      ...currentContext,
      schedule: scheduleStatus || { state: 'unknown' }
    };

    // 🔥 Gravity Intel (Task Prioritization)
    let gravityContext = null;
    let tasksList = "No active tasks.";

    if (userTasksRes && userTasksRes.data && userTasksRes.data.length > 0) {
      const sortedTasks = userTasksRes.data.sort((a, b) => (b.meta?.score || 0) - (a.meta?.score || 0));
      const topTask = sortedTasks[0];
      const topScore = topTask.meta?.score || 0;
      
      const isExamEmergency = topScore > 4000 && topTask.meta?.isExamPrep === true;
      const timingInfo = topTask.meta?.examTiming || "Unknown time";

      gravityContext = {
        title: topTask.title,
        score: topScore,
        isExam: isExamEmergency,
        subject: topTask.meta?.subjectId || 'General',
        timing: timingInfo
      };

      tasksList = sortedTasks.map(t => {
        const score = t.meta?.score || 0;
        const examBadge = score > 4000 ? "🚨 EXAM TOMORROW" :
          score > 1000 ? "⚠️ EXAM SOON" : "";
        return `- ${t.title} ${examBadge} (Priority: ${score})`;
      }).join('\n');
    }

    // ==========================================
    // 🌟 7. IMPROVEMENTS LOGIC (The Fix: Logic applied AFTER Data is ready)
    // ==========================================

    // A. Gender Awareness
    const userGender = userData.gender || 'male';

    // B. First Time User
    // Now we have both 'history' and 'userData' populated
    const isFirstTimeUser = (history.length === 0 && !userData.lastActiveAt);
    let welcomeContext = "";
    
    if (isFirstTimeUser) {
        welcomeContext = `
        🎉 **NEW USER ALERT:** This is the VERY FIRST time ${userData.firstName} talks to you.
        👉 **INSTRUCTION:**
        1. Welcome them warmly to the EduApp family.
        2. Introduce yourself briefly as their new companion.
        3. Ask them: "واش هو التخصص تاعك؟" or "واش راك حاب تراجع اليوم؟".
        4. Don't be too pushy about tasks yet.
        `;
    }

    // C. Dry Text Detector
    const isShortMessage = message && message.trim().length < 4;
    let conversationalContext = "";
    if (isShortMessage) {
        conversationalContext = `
        ⚠️ **INTERACTION ALERT:** The user sent a very short/dry message ("${message}").
        👉 **INSTRUCTION:** 
        - They might be bored, tired, or busy.
        - STOP explaining lessons immediately.
        - Ask an open-ended question to re-engage them (e.g., "راك عيان؟", "كاش ما صرا؟").
        - Keep your reply VERY short too.
        `;
    }

    // D. Streak Hype
    const streak = progressData?.streakCount || 0;
    const bestStreak = progressData?.bestStreak || 0;
    let streakContext = "";
    if (streak >= 3) {
        streakContext = `🔥 **STREAK ALERT:** User is on a ${streak}-day streak! Mention this proudly!`;
    } else if (streak === 0 && bestStreak > 5) {
        streakContext = `💔 **STREAK BROKEN:** User lost a long streak (${bestStreak} days). Be gentle and encourage them.`;
    }

    // E. Distraction Detector
    let distractionContext = "";
    if (history.length > 0) {
        const lastMsg = history[history.length - 1];
        const lastTime = new Date(lastMsg.timestamp).getTime();
        const now = Date.now();
        const diffMinutes = (now - lastTime) / (1000 * 60);
        if (diffMinutes > 10 && diffMinutes < 60) {
            distractionContext = `⏱️ **DISTRACTION DETECTED:** User went silent for ${Math.floor(diffMinutes)} mins. Tease them playfully!`;
        }
    }

    // F. Fatigue Switch
    const sessionLength = history.length;
    let fatigueContext = "";
    if (sessionLength > 20 && sessionLength % 10 === 0) {
        fatigueContext = `🧠 **FATIGUE CHECK:** Long session (${sessionLength} msgs). Suggest a break or switching subjects.`;
    }

    // G. Recent Past Exams
    const recentPastExams = await getRecentPastExams(userData.groupId);
    let pastExamsContext = "";
    if (recentPastExams.length > 0) {
        pastExamsContext = "🗓️ **RECENT PAST EXAMS (Ask user about results):**\n";
        recentPastExams.forEach(ex => {
            const dateStr = new Date(ex.exam_date).toLocaleDateString('en-US');
            const subject = ex.subjects?.title || ex.subject_id;
            pastExamsContext += `- Finished Exam: "${subject}" (${ex.type}) on ${dateStr}.\n`;
        });
        pastExamsContext += "👉 INSTRUCTION: If you haven't asked yet, ask casually: 'How did the [Subject] exam go?'\n";
    }

    // ==========================================
    // 8. Gravity Protocol & Context Assembly
    // ==========================================
    let gravitySection = "";
    let antiSamataProtocol = "";
      
    if (gravityContext) {
          const isExam = gravityContext.isExam || false;
          const timeStr = gravityContext.timing ? `(Timing: ${gravityContext.timing})` : "";

          gravitySection = `🚀 **GRAVITY ENGINE:** Top Task: "${gravityContext.title}", Score: ${gravityContext.score}. Emergency: ${isExam ? "YES" : "NO"} ${timeStr}`;
          
          if (isExam) {
              antiSamataProtocol = `🛡️ **PROTOCOL: EXAM EMERGENCY** - Exam is ${timeStr}. Be urgent!`;
          } else {
              antiSamataProtocol = `🛡️ **PROTOCOL: NO SAMATA** - No immediate exam. Chat naturally.`;
          }
      }
   // تأكد من جلب last_active_at مع بيانات المستخدم
const lastActive = userData.last_active_at ? new Date(userData.last_active_at) : null;
let absenceContext = "";

if (lastActive) {
    const daysSinceActive = (Date.now() - lastActive.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceActive > 3) {
        absenceContext = `
        👻 **GHOST ALERT:** User hasn't opened the app for ${Math.floor(daysSinceActive)} days.
        👉 **INSTRUCTION:** Start by guilt-tripping them playfully: "يا أهلا! وين كنت غاطس هاد الأيام؟ توحشناك (زعما)".
        `;
    }
}
    // Exam Context
    let examContext = {};
    if (userData.nextExamDate) {
      const humanTime = getHumanTimeDiff(userData.nextExamDate);
      examContext = { 
          subject: userData.nextExamSubject || 'General',
          timingHuman: humanTime,
          rawDate: userData.nextExamDate
      };
    }

    const aiProfileData = rawProfile || {};
    const groupId = userData.groupId;

    // Narrative Profile
    const facts = aiProfileData.facts || {};
    let userBio = "User Profile:\n";
    
    if (facts.identity) userBio += `- Name: ${facts.identity.name} (${facts.identity.role}, ${facts.identity.age}yo).\n`;
    if (facts.social) userBio += `- Circle: Friend ${facts.social.best_friend}, GF ${facts.social.girlfriend}.\n`;
    if (facts.interests) userBio += `- Loves: ${facts.interests.music?.join(', ')} and ${facts.interests.animal}.\n`;
    if (facts.education) userBio += `- Study: ${facts.education.study_style}. Weak in ${facts.education.weaknesses?.[0]}. Strong in ${facts.education.strengths?.[0]}.\n`;
    if (facts.behavior) userBio += `- Style: ${facts.behavior.tone}. Procrastinates by ${facts.behavior.procrastination}.\n`;

    // 🔥 Identity Injection
    const fullUserProfile = {
      userId: userId,
      firstName: userData.firstName || 'Student',
      lastName: userData.lastName || '',
      group: groupId,
      role: userData.role || 'student',
      gender: userGender, // ✅ Correctly populated now
      formattedBio: userBio, 
      ...aiProfileData
    };

    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    const allAgenda = Array.isArray(aiProfileData.aiAgenda) ? aiProfileData.aiAgenda : [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending');

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
    const currentSemester = 'S1'; 

    const systemContextCombined = `
    User Identity: Name=${fullUserProfile.firstName}, Group=${groupId}, Role=${fullUserProfile.role}.
    ${ageContext}
    📅 **ACADEMIC SEASON:** We are currently in **${currentSemester}**.
    ${getAlgiersTimeContext().contextSummary}
    ${scheduleContextString}
    ${sharedContext}
    ${activeLessonContext}

    ${welcomeContext}
    ${conversationalContext}
    ${streakContext}
    ${distractionContext}
    ${fatigueContext}
    ${pastExamsContext}

    📋 **CURRENT TODO LIST:**
    ${tasksList}
    
    ${gravitySection} 
    ${antiSamataProtocol}
    
    ${examContext.subject ? `🚨 **EXAM ALERT:** Subject: "${examContext.subject}" is happening **${examContext.timingHuman}**. Focus on this immediately!` : ""}
    `;

    // ---------------------------------------------------------
    // 9. AI Generation
    // ---------------------------------------------------------
    const safeMessage = message || '';

    const formatTimeShort = (isoString) => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
    };

    const safeHistoryStr = history.map(h => {
      const timeTag = h.timestamp ? `[${formatTimeShort(h.timestamp)}] ` : '';
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
      updatedContextForPrompt,
      gravityContext,
      absenceContext
    );

    const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'MasterChat', timeoutMs: CONFIG.TIMEOUTS.chat });
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // ---------------------------------------------------------
    // 10. Action Layer & Agenda Updates
    // ---------------------------------------------------------

    // Handle Lesson Completion
    if (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete') {
      const signal = parsedResponse.lesson_signal;

      await markLessonComplete(userId, signal.id, signal.score || 100);
      const newDbTasks = await refreshUserTasks(userId);

      const validNextTasks = (newDbTasks || []).filter(t => t.meta?.relatedLessonId !== signal.id);
      const nextTask = validNextTasks.length > 0 ? validNextTasks[0] : null;

      const algiersTime = getAlgiersTimeContext(); 
      const currentHour = algiersTime.hour;
      const isLateNight = currentHour >= 22 || currentHour < 5; 
      const isExamEmergency = gravityContext?.isExam; 

      let recommendationText = "";

      if (isExamEmergency && isLateNight) {
        recommendationText = `\n\n🛑 **حبس هنا!** غدوة عندك امتحان والوقت راه روطار. **روح ترقد دوكا** باش مخك يثبت المعلومات. تصبح على خير! 😴`;

        parsedResponse.widgets = (parsedResponse.widgets || []).filter(w => w.type !== 'action_button');
        parsedResponse.widgets.push({
          type: 'action_button',
          data: { label: 'إغلاق التطبيق والنوم 🌙', action: 'close_app' }
        });
      }
      else if (nextTask) {
        recommendationText = `\n\n💡 **الخطوة التالية:** ${nextTask.title}`;
        parsedResponse.widgets = parsedResponse.widgets || [];
        parsedResponse.widgets.push({
          type: 'action_button',
          data: { label: `ابدأ: ${nextTask.title}`, action: 'navigate', targetId: nextTask.meta?.relatedLessonId }
        });
      }
      else {
        recommendationText = `\n\n🎉 كملت كلش لليوم! ارتاح.`;
      }

      parsedResponse.widgets = parsedResponse.widgets || [];
      parsedResponse.widgets.push({ type: 'event_trigger', data: { event: 'tasks_updated' } });
      parsedResponse.reply += recommendationText;
      parsedResponse.widgets.push({ type: 'celebration', data: { message: 'إنجاز عظيم! 🚀' } });
    }

    // EduNexus Updates
    if (CONFIG.ENABLE_EDUNEXUS && parsedResponse.memory_update && groupId) {
      const action = parsedResponse.memory_update;
      if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
        await updateNexusKnowledge(groupId, userId, 'exams', action.subject, action.new_date);
      }
    }

    // Agenda Actions
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

    // Mood Update
    if (parsedResponse.newMood) {
      supabase.from('ai_memory_profiles').update({
        emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
        last_updated_at: nowISO()
      }).eq('user_id', userId).then();
    }

    // ---------------------------------------------------------
    // 11. Response & Background Saving
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood
    });

    // Background processing
    setImmediate(async () => { 
      // Study time tracking
      if (currentContext && currentContext.lessonId) {
          await trackStudyTime(userId, currentContext.lessonId, 60).catch(err => logger.error('Tracking failed:', err));
      }

      // Save Chat
      const updatedHistory = [
        ...history,
        { role: 'user', text: message, timestamp: nowISO() },
        { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
      ];

      saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory)
        .catch(e => logger.error(e));

      // Memory & Analysis
      analyzeAndSaveMemory(userId, updatedHistory)
        .catch(e => logger.error(e));

      analyzeSessionForEvents(userId, updatedHistory)
        .catch(e => logger.error('SessionAnalyzer Fail:', e));

      // Update Last Active At (Important for future First Time detection)
      supabase.from('users').update({ last_active_at: nowISO() }).eq('id', userId).then();
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
