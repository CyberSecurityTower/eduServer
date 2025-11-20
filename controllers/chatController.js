
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance } = require('../services/data/firestore');
const {
  getProgress, fetchUserWeaknesses, formatProgressForAI, saveChatSession, analyzeAndSaveMemory
} = require('../services/data/helpers');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { escapeForPrompt, safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef;
let saveMemoryChunkRef;

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) throw new Error('Chat Controller needs generateWithFailover');
  generateWithFailoverRef = dependencies.generateWithFailover;
  saveMemoryChunkRef = dependencies.saveMemoryChunk;
  logger.info('Chat Controller initialized.');
}

// --- GenUI Main Handler ---
async function chatInteractive(req, res) {
  try {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'Missing data' });

    // 1. Setup Session
    const sessionId = clientSessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    const chatTitle = message.substring(0, 30);

    // 2. Gather Context (Parallel)
    const [memory, curriculum, conversation, progress, weaknesses, progressFmt] = await Promise.all([
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      runConversationAgent(userId, message).catch(() => ''),
      getProgress(userId).catch(() => ({})),
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => '')
    ]);

    // 3. Prepare History
    const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
      .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 200)}`).join('\n');

    // 4. Prompt
    const prompt = PROMPTS.chat.interactiveChat(
      message, memory, curriculum, conversation, lastFive, progressFmt, weaknesses
    );

    // 5. Generate
    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GenUI', timeoutMs: 25000 });
    const rawText = await extractTextFromResult(modelResp);

    // 6. Parse JSON
    let parsed = await ensureJsonOrRepair(rawText, 'chat'); // Use 'chat' pool for repair to be safe
    if (!parsed || !parsed.reply) {
      parsed = { reply: rawText || "عذراً، حدث خطأ.", widgets: [] };
    }

    // 7. Save & Respond
    const updatedHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsed.reply, widgets: parsed.widgets }];
    
    // Fire & Forget Saving
    saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main', context).catch(e => logger.error('SaveChat err', e));
    if (saveMemoryChunkRef) saveMemoryChunkRef(userId, message).catch(() => {});

    res.json({
      reply: parsed.reply,
      widgets: parsed.widgets || [],
      sessionId,
      chatTitle
    });

  } catch (err) {
    logger.error('chatInteractive Error:', err);
    res.status(500).json({ reply: "حدث خطأ في الخادم.", widgets: [] });
  }
}

// ✅ دالة الاقتراحات (مبسطة جداً للسرعة)
async function generateChatSuggestions(req, res) {
  // اقتراحات ثابتة أو عشوائية لتخفيف الحمل، أو يمكنك استخدام الموديل إذا أردت
  const suggestions = [
    "لخص لي هذا الدرس",
    "أعطني كويز سريع",
    "اشرح لي المفهوم الأساسي",
    "ما هي خطوتي التالية؟"
  ];
  res.json({ suggestions });
}

// ✅ دالة للـ Worker (مطلوبة لـ initJobWorker)
async function handleGeneralQuestion(message, lang) {
    return "هذه ميزة قيد التحديث."; 
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
