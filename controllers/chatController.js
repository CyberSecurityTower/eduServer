
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName,
  saveChatSession, analyzeAndSaveMemory
} = require('../services/data/helpers');
const { runTrafficManager } = require('../services/ai/managers/trafficManager');
const { runNotificationManager } = require('../services/ai/managers/notificationManager');
const { runReviewManager } = require('../services/ai/managers/reviewManager');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager'); // Renamed from memoryManager.js
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { enqueueJob } = require('../services/jobs/queue');
const { escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const logger = require('../utils/logger');

let generateWithFailoverRef; // Injected dependency
let saveMemoryChunkRef; // Injected dependency

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover || !dependencies.saveMemoryChunk) {
    throw new Error('Chat Controller requires generateWithFailover and saveMemoryChunk for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  saveMemoryChunkRef = dependencies.saveMemoryChunk;
  logger.info('Chat Controller initialized.');
}

const db = getFirestoreInstance();

// Helper to generate chat title
async function generateTitle(message, language = 'Arabic') {
  const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text, no JSON or extra words.

Message: "${escapeForPrompt(safeSnippet(message, 300))}"

Title:`;
  try {
    if (!generateWithFailoverRef) {
      logger.error('generateTitle: generateWithFailover is not set.');
      return message.substring(0, 30);
    }
    const modelResp = await generateWithFailoverRef('titleIntent', prompt, { label: 'GenerateTitle', timeoutMs: 5000 });
    const title = await extractTextFromResult(modelResp);
    if (!title) return message.substring(0, 30);
    return title.replace(/["']/g, '').trim();
  } catch (e) {
    logger.warn('generateTitle fallback:', e && e.message ? e.message : e);
    return message.substring(0, 30);
  }
}

async function handlePerformanceAnalysis(language, weaknesses = [], formattedProgress = '', tasksSummary = '', studentName = null) {
  const prompt = `You are an AI actor playing "EduAI," a warm, encouraging, and sharp academic advisor in a fictional simulation.\nYour task is to analyze academic data for a student and present a personalized, actionable performance review.\n\n<rules>\n1.  **Persona & Personalization:** Your tone MUST be positive and empowering.\n    *   **If a student name is provided ("${studentName || 'NONE'}"), you MUST address them by their name.**\n    *   **You MUST adapt your language (masculine/feminine grammatical forms in Arabic) to match the gender suggested by the name.**\n    *   **If no name is provided, use a welcoming, gender-neutral greeting** like "أهلاً بك! دعنا نلقي نظرة على أدائك..." and continue with gender-neutral language.\n\n2.  **CRITICAL RULE - NO IDs:** You are FORBIDDEN from ever displaying technical IDs like 'sub1'. You MUST ONLY use the human-readable subject and lesson titles provided.\n\n3.  **Structure the Analysis:** Present your analysis in three clear sections: "نقاط القوة", "مجالات تتطلب التطوير والتحسين", and "الخطوة التالية المقترحة".\n\n4.  **Language:** Respond ONLY in ${language}. Your language must be natural and encouraging.\n</rules>\n\n<simulation_data student_name="${studentName || 'Unknown'}">\n  <current_tasks>\n    ${tasksSummary}\n  </current_tasks>\n  <identified_weaknesses>\n    ${weaknesses.map(w => `- In subject "${w.subjectTitle}", the lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore || 0}%.`).join('\n')}\n  </identified_weaknesses>\n  <overall_subject_mastery>\n    ${formattedProgress}\n  </overall_subject_mastery>\n</simulation_data>\n\nYour personalized and encouraging analysis for ${studentName || 'the student'}:`;

  if (!generateWithFailoverRef) {
    logger.error('handlePerformanceAnalysis: generateWithFailover is not set.');
    return (language === 'Arabic' ? 'لم أتمكن من تحليل الأداء حاليًا.' : 'Could not analyze performance right now.');
  }
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'AnalysisHandler', timeoutMs: CONFIG.TIMEOUTS.chat });
  return await extractTextFromResult(modelResp) || (language === 'Arabic' ? 'لم أتمكن من تحليل الأداء حاليًا.' : 'Could not analyze performance right now.');
}

async function handleGeneralQuestion(message, language, history = [], userProfile = 'No profile.', userProgress = {}, weaknesses = [], formattedProgress = '', studentName = null) {
  const lastFive = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`).join('\n');
  const tasksSummary = userProgress?.dailyTasks?.tasks?.length > 0 ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user currently has no tasks.';
  const weaknessesSummary = weaknesses.length > 0 ? `Identified Weaknesses:\n${weaknesses.map(w => `- In "${w.subjectTitle}", lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore}%.`).join('\n')}` : 'No specific weaknesses identified.';
  const gamificationSummary = `User Stats:\n- Points: ${userProgress?.stats?.points || 0}\n- Rank: "${userProgress?.stats?.rank || 'Beginner'}"\n- Current Streak: ${userProgress?.streakCount || 0} days`;

  const prompt = `You are EduAI, a specialized AI tutor. The information in <user_context> is YOUR MEMORY of the student. Use it to provide personalized, direct answers.\n\n<rules>\n1.  **Persona & Personalization:** Your tone is helpful and encouraging.\n    *   **If a student name is provided ("${studentName || 'NONE'}"), you may address them by their name in a friendly way.**\n    *   **Adapt your language (masculine/feminine forms in Arabic) to the gender suggested by the name.**\n    *   **If no name is provided, use gender-neutral language.**\n\n2.  **ABSOLUTE RULE:** You are FORBIDDEN from saying "I cannot access your data" or any similar phrase. The user's data (streak, points, etc.) IS provided below. Your primary job is to find it and report it when asked.\n\n3.  **Action:** For specific questions about points, streak, or tasks, locate the answer in the <user_context> and state it directly. For general knowledge questions, answer them helpfully.\n\n4.  **Language:** Your response MUST be in ${language}.\n</rules>\n\n<user_context student_name="${studentName || 'Unknown'}">\n  <gamification_stats>${gamificationSummary}</gamification_stats>\n  <learning_focus>${tasksSummary}\n${weaknessesSummary}</learning_focus>\n  <user_profile_summary>${safeSnippet(userProfile, 1000)}</user_profile_summary>\n  <detailed_progress_summary>${formattedProgress}</detailed_progress_summary>\n</user_context>\n\n<conversation_history>${lastFive}</conversation_history>\n\nThe user's new message is: "${escapeForPrompt(safeSnippet(message, 2000))}"\nYour response as EduAI:`;

  if (!generateWithFailoverRef) {
    logger.error('handleGeneralQuestion: generateWithFailover is not set.');
    return (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن.' : 'I could not generate an answer right now.');
  }
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'ResponseManager', timeoutMs: CONFIG.TIMEOUTS.chat });
  let replyText = await extractTextFromResult(modelResp);

  const review = await runReviewManager(message, replyText);
  if (review?.score < CONFIG.REVIEW_THRESHOLD) {
    const correctivePrompt = `Previous reply scored ${review.score}/10. Improve it based on: ${escapeForPrompt(review.feedback)}. User: "${escapeForPrompt(safeSnippet(message, 2000))}"`;
    const res2 = await generateWithFailoverRef('chat', correctivePrompt, { label: 'ResponseRetry', timeoutMs: CONFIG.TIMEOUTS.chat });
    replyText = (await extractTextFromResult(res2)) || replyText;
  }
  return replyText || (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن.' : 'I could not generate an answer right now.');
}

// ---------------- ROUTES ----------------
async function chat(req, res) {
  try {
    const userId = req.body.userId;
    const { message, history = [] } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });

    const traffic = await runTrafficManager(message);
    const { language = 'Arabic', intent = 'unclear' } = traffic;

    if (intent === 'manage_todo' || intent === 'generate_plan') {
      const ack = await runNotificationManager('ack', language);
      const payload = { message, intent, language, pathId: req.body.pathId || null };
      const jobId = await enqueueJob({ userId, type: 'background_chat', payload });
      return res.json({ reply: ack, jobId, isAction: true });
    }

    const [userProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
      getProfile(userId), getProgress(userId), fetchUserWeaknesses(userId), formatProgressForAI(userId), getUserDisplayName(userId)
    ]);

    let reply;
    if (intent === 'analyze_performance') {
      const tasksSummary = userProgress?.dailyTasks?.tasks?.length > 0 ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user has no tasks.';
      reply = await handlePerformanceAnalysis(language, weaknesses, formattedProgress, tasksSummary, userName);
    } else {
      reply = await handleGeneralQuestion(message, language, history, userProfile, userProgress, weaknesses, formattedProgress, userName);
    }

    return res.json({ reply, isAction: false });
  } catch (err) {
    logger.error('/chat error:', err.stack);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
}

async function chatInteractive(req, res) {
  try {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    let sessionId = clientSessionId;
    let chatTitle = 'New Chat';
    const isNewSession = !sessionId;
    if (isNewSession) {
      sessionId = `chat_${Date.now()}_${userId.slice(0, 5)}`;
      try {
        chatTitle = await generateTitle(message.trim());
      } catch (e) {
        chatTitle = message.trim().substring(0, 30);
        logger.error('generateTitle failed, using fallback title:', e);
      }
    }

    const memoryPromise = (async () => {
      try { return await runMemoryAgent(userId, message); }
      catch (e) { logger.error('runMemoryAgent failed:', e); return ''; }
    })();

    const curriculumPromise = (async () => {
      try { return await runCurriculumAgent(userId, message); }
      catch (e) { logger.error('runCurriculumAgent failed:', e); return ''; }
    })();

    const conversationPromise = (async () => {
      try { return await runConversationAgent(userId, message); }
      catch (e) { logger.error('runConversationAgent failed:', e); return ''; }
    })();

    const profilePromise = getProfile(userId).catch(e => { logger.error('getProfile failed:', e); return {}; });
    const progressPromise = getProgress(userId).catch(e => { logger.error('getProgress failed:', e); return {}; });
    const weaknessesPromise = fetchUserWeaknesses(userId).catch(e => { logger.error('fetchUserWeaknesses failed:', e); return []; });
    const formattedProgressPromise = formatProgressForAI(userId).catch(e => { logger.error('formatProgressForAI failed:', e); return ''; });
    const userNamePromise = getUserDisplayName(userId).catch(e => { logger.error('getUserDisplayName failed:', e); return ''; });

    const AGENT_TIMEOUT_MS = 5000;

    const memoryRace = Promise.race([
      memoryPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);
    const curriculumRace = Promise.race([
      curriculumPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);
    const conversationRace = Promise.race([
      conversationPromise,
      new Promise(resolve => setTimeout(() => resolve(''), AGENT_TIMEOUT_MS))
    ]);

    const [memSettled, curSettled, convSettled] = await Promise.allSettled([
      memoryRace, curriculumRace, conversationRace
    ]);

    const memoryReportRaw = (memSettled.status === 'fulfilled' && memSettled.value) ? memSettled.value : '';
    const curriculumReportRaw = (curSettled.status === 'fulfilled' && curSettled.value) ? curSettled.value : '';
    const conversationReportRaw = (convSettled.status === 'fulfilled' && convSettled.value) ? convSettled.value : '';

    const [memoryProfile, userProgress, weaknesses, formattedProgress, userName] = await Promise.all([
      profilePromise, progressPromise, weaknessesPromise, formattedProgressPromise, userNamePromise
    ]);

    const profileSummary = (memoryProfile && memoryProfile.profileSummary) ? memoryProfile.profileSummary : 'No profile summary available.';

    const memoryReport = String(memoryReportRaw || (`NOTE: The memory agent failed. This is a fallback using the full user profile: ${profileSummary}`)).trim();
    const curriculumReport = String(curriculumReportRaw || '').trim();
    const conversationReport = String(conversationReportRaw || '').trim();

    const lastFive = (Array.isArray(history) ? history.slice(-7) : [])
      .map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`)
      .join('\n');

    const finalPrompt = `You are EduAI, a genius, witty, and deeply personal AI companion.
This is the user's question: "${escapeForPrompt(safeSnippet(message, 2000))}"

Here is the complete intelligence briefing from your specialist team. Use it to formulate a brilliant, personal response.

<memory_report_psychologist>
${escapeForPrompt(safeSnippet(memoryReport, 4000)) || 'No long-term memory is relevant to this query.'}
</memory_report_psychologist>

<curriculum_report_academic_advisor>
${escapeForPrompt(safeSnippet(curriculumReport || 'This question does not link to a specific lesson in their plan.', 4000))}
</curriculum_report_academic_advisor>

<conversation_report_context_keeper>
${escapeForPrompt(safeSnippet(conversationReport || 'This appears to be a new topic of conversation.', 4000))}
</conversation_report_context_keeper>

<conversation_history>
${lastFive}
</conversation_history>

Student progress summary (short): ${escapeForPrompt(safeSnippet(formattedProgress || 'No progress summary.', 1000))}
Student weaknesses (short): ${escapeForPrompt(safeSnippet(Array.isArray(weaknesses) ? weaknesses.join('; ') : String(weaknesses || ''), 1000))}

Respond as EduAI in the user's language. Be personal, friendly (non-formal), and concise. If the question is curriculum-related, prefer step-by-step guidance and examples.`;

    if (!generateWithFailoverRef) {
      logger.error('chatInteractive: generateWithFailover is not set.');
      return res.status(500).json({ error: 'An internal server error occurred.' });
    }
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, {
      label: 'InteractiveChat-Decider',
      timeoutMs: CONFIG.TIMEOUTS.chat
    });

    const fullReplyText = await extractTextFromResult(modelResp);
    const botReply = fullReplyText || 'عذراً، لم أتمكن من إنشاء رد الآن.';

    const userMessageObj = { author: 'user', text: message, timestamp: new Date().toISOString() };
    const botMessageObj = { author: 'bot', text: botReply, timestamp: new Date().toISOString() };
    const updatedHistory = [...history, userMessageObj, botMessageObj];

    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main_chat', context)
      .catch(e => logger.error('saveChatSession failed (fire-and-forget):', e));

    if (updatedHistory.length % 6 === 0) {
      analyzeAndSaveMemory(userId, updatedHistory.slice(-6))
        .catch(e => logger.error('analyzeAndSaveMemory failed (fire-and-forget):', e));
    }
    if (!saveMemoryChunkRef) {
      logger.error('chatInteractive: saveMemoryChunk is not set.');
    } else {
      saveMemoryChunkRef(userId, message)
        .catch(e => logger.error('saveMemoryChunk failed in background:', e));
    }

    res.status(200).json({
      reply: botReply,
      sessionId,
      chatTitle,
    });
  } catch (err) {
    logger.error('/chat-interactive error:', err.stack || err);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
}

async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required.' });
    }

    const suggestions = await runSuggestionManager(userId);

    res.status(200).json({ suggestions });

  } catch (error) {
    logger.error('/generate-chat-suggestions error:', error.stack);
    const fallbackSuggestions = ["ما هي مهامي اليومية؟", "لخص لي آخر درس درسته", "حلل أدائي الدراسي"];
    res.status(500).json({ suggestions: fallbackSuggestions });
  }
}

module.exports = {
  initChatController,
  chat,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion, // Export for job worker
};
