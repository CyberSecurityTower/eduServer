
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const {
  getProfile, getProgress, fetchUserWeaknesses, formatProgressForAI, getUserDisplayName,
  saveChatSession, analyzeAndSaveMemory
} = require('../services/data/helpers');
// قمنا بإزالة Managers غير الضرورية لتبسيط الكود والاعتماد على النموذج الذكي
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager'); // تأكدنا من استيراد هذا
const { escapeForPrompt, safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef;
let saveMemoryChunkRef;

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover || !dependencies.saveMemoryChunk) {
    throw new Error('Chat Controller requires dependencies.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  saveMemoryChunkRef = dependencies.saveMemoryChunk;
  logger.info('Chat Controller initialized (GenUI Ready).');
}

const db = getFirestoreInstance();

// --- Helper: Generate Title ---
async function generateTitle(message) {
  // للتوفير، نستخدم جزء من الرسالة كعنوان، أو يمكن استخدام نموذج خفيف
  return message.substring(0, 30); 
}

// --- Helper: Handle General Question (Required by Worker) ---
// ✅ تمت إعادة هذه الدالة لأن worker.js يعتمد عليها
async function handleGeneralQuestion(message, language, history = [], userProfile = 'No profile.', userProgress = {}, weaknesses = [], formattedProgress = '', studentName = null) {
  const lastFive = (Array.isArray(history) ? history.slice(-5) : []).map(h => `${h.role === 'model' ? 'You' : 'User'}: ${safeSnippet(h.text || '', 500)}`).join('\n');
  const tasksSummary = userProgress?.dailyTasks?.tasks?.length > 0 ? `Current Tasks:\n${userProgress.dailyTasks.tasks.map(t => `- ${t.title} (${t.status})`).join('\n')}` : 'The user currently has no tasks.';
  const weaknessesSummary = weaknesses.length > 0 ? `Identified Weaknesses:\n${weaknesses.map(w => `- In "${w.subjectTitle}", lesson "${w.lessonTitle}" has a mastery of ${w.masteryScore}%.`).join('\n')}` : 'No specific weaknesses identified.';
  const gamificationSummary = `User Stats:\n- Points: ${userProgress?.stats?.points || 0}\n- Rank: "${userProgress?.stats?.rank || 'Beginner'}"\n- Current Streak: ${userProgress?.streakCount || 0} days`;

  // برومبت مبسط للردود النصية فقط (للإشعارات والمهام الخلفية)
  const prompt = `You are EduAI, a specialized AI tutor.
<rules>
1. **Persona:** Helpful and encouraging. Address student by name ("${studentName || 'Student'}") if provided.
2. **Context:** Use the provided data to answer. Do NOT say "I cannot access data".
3. **Language:** Response MUST be in ${language}.
4. **Format:** Text ONLY. No widgets or JSON.
</rules>

<user_context>
  <stats>${gamificationSummary}</stats>
  <tasks>${tasksSummary}</tasks>
  <weaknesses>${weaknessesSummary}</weaknesses>
  <profile>${safeSnippet(userProfile, 500)}</profile>
  <progress>${formattedProgress}</progress>
</user_context>

<history>${lastFive}</history>

User Message: "${escapeForPrompt(safeSnippet(message, 2000))}"
Response:`;

  if (!generateWithFailoverRef) {
    logger.error('handleGeneralQuestion: generateWithFailover is not set.');
    return (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن.' : 'I could not generate an answer right now.');
  }
  
  const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GeneralQuestion', timeoutMs: CONFIG.TIMEOUTS.chat });
  const replyText = await extractTextFromResult(modelResp);
  
  return replyText || (language === 'Arabic' ? 'لم أتمكن من الإجابة الآن.' : 'I could not generate an answer right now.');
}

// --- MAIN ROUTE: Interactive Chat (GenUI) ---
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

    // 2. Parallel Context Retrieval (RAG)
    const [
      memoryReport,
      curriculumReport,
      conversationReport,
      userProgress,
      weaknesses,
      formattedProgress
    ] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      getProgress(userId).catch(() => ({})),
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => '')
    ]);

    // 3. Prepare History
    const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
      .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 500)}`)
      .join('\n');

    // 4. Construct Prompt
    const finalPrompt = PROMPTS.chat.interactiveChat(
      message,
      memoryReport,
      curriculumReport,
      conversationReport,
      lastFive,
      formattedProgress,
      weaknesses
    );

    // 5. Call AI Model
    if (!generateWithFailoverRef) throw new Error('AI Service not ready');
    
    const modelResp = await generateWithFailoverRef('chat', finalPrompt, {
      label: 'GenUI-Chat',
      timeoutMs: CONFIG.TIMEOUTS.chat
    });

    const rawText = await extractTextFromResult(modelResp);

    // 6. Parse & Repair JSON (The Safety Net)
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // Fallback if AI fails completely to give JSON
    if (!parsedResponse || !parsedResponse.reply) {
      logger.warn('Failed to parse GenUI JSON, falling back to raw text.');
      parsedResponse = {
        reply: rawText || "عذراً، حدث خطأ في المعالجة. هل يمكنك إعادة السؤال؟",
        widgets: []
      };
    }

    // 7. Save & Respond
    const botReplyText = parsedResponse.reply;
    const widgets = parsedResponse.widgets || [];

    const updatedHistory = [
      ...history,
      { role: 'user', text: message },
      { role: 'model', text: botReplyText, widgets: widgets }
    ];

    // Fire-and-forget saving
    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main_chat', context)
      .catch(e => logger.error('saveChatSession failed:', e));
    
    if (saveMemoryChunkRef) {
      saveMemoryChunkRef(userId, message).catch(() => {});
    }

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

// ✅ الآن نقوم بتصدير handleGeneralQuestion ليستخدمها worker.js
module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion 
};
