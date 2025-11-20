
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
  // ... (نفس الكود السابق)
  // للتوفير، يمكنك استخدام نموذج خفيف هنا
  return message.substring(0, 30); 
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
      chatTitle = message.substring(0, 30); // تبسيط لتسريع الاستجابة
    }

    // 2. Parallel Context Retrieval (RAG)
    // نستخدم Promise.all لجلب كل السياقات في وقت واحد
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
    // نحاول تحويل النص إلى JSON، وإذا فشل نستخدم نموذج إصلاح
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

    // حفظ الرسالة في التاريخ (نحفظ النص فقط لتقليل حجم الداتابيس، أو يمكن حفظ الـ widgets أيضاً)
    const updatedHistory = [
      ...history,
      { role: 'user', text: message },
      { role: 'model', text: botReplyText, widgets: widgets } // نحفظ الـ widgets في الهيستوري
    ];

    // Fire-and-forget saving
    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main_chat', context)
      .catch(e => logger.error('saveChatSession failed:', e));
    
    if (saveMemoryChunkRef) {
      saveMemoryChunkRef(userId, message).catch(() => {});
    }

    // إرسال الرد للفرونت إند بالهيكل الجديد
    res.status(200).json({
      reply: botReplyText,
      widgets: widgets, // المصفوفة السحرية
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

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
};
