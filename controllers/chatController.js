
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

const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
// ✅ تأكد أن هذا الاستيراد موجود
const { analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');

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
    
        const sessionId = clientSessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
        const chatTitle = message.substring(0, 30);
    
        // 1. RAG & Context Retrieval
        const [memory, curriculum, conversation, progress, weaknesses, progressFmt] = await Promise.all([
          runMemoryAgent(userId, message).catch(() => ''),
          runCurriculumAgent(userId, message).catch(() => ''),
          runConversationAgent(userId, message).catch(() => ''),
          getProgress(userId).catch(() => ({})),
          fetchUserWeaknesses(userId).catch(() => []),
          formatProgressForAI(userId).catch(() => '')
        ]);
    
        // 2. History Formatting
        const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
          .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 200)}`).join('\n');
    
        // 3. Prompt Engineering
        const prompt = PROMPTS.chat.interactiveChat(
          message, memory, curriculum, conversation, lastFive, progressFmt, weaknesses
        );
    
        // 4. AI Generation
        const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GenUI', timeoutMs: 25000 });
        const rawText = await extractTextFromResult(modelResp);
    
        // 5. Parsing & Repair
        let parsed = await ensureJsonOrRepair(rawText, 'chat');
        if (!parsed || !parsed.reply) {
          parsed = { reply: rawText || "عذراً، حدث خطأ.", widgets: [] };
        }
    
        // 6. Construct Updated History
        const updatedHistory = [...history, { role: 'user', text: message }, { role: 'model', text: parsed.reply, widgets: parsed.widgets }];
        
        // 7. Background Tasks (Fire & Forget) 🏃‍♂️💨
        
        // A. Save Chat
        saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main', context)
          .catch(e => logger.error('SaveChat err', e));
        
        // B. Update Memory Embeddings
        if (saveMemoryChunkRef) {
            saveMemoryChunkRef(userId, message).catch(() => {});
        }

        // ✅ C. Deep Scheduler Analysis (الإضافة الجديدة هنا)
        // نمرر updatedHistory لأنه يحتوي على رد الـ AI الجديد (مهم جداً إذا اقترح الـ AI موعداً ووافق المستخدم)
        analyzeSessionForEvents(userId, updatedHistory).catch(err => {
            logger.warn(`[Scheduler] Background analysis failed for user ${userId}:`, err.message);
        });
    
        // 8. Send Response to Client
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

// ✅ دالة الاقتراحات الذكية
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const suggestions = await runSuggestionManager(userId);
    res.json({ suggestions });
  } catch (error) {
    logger.error('generateChatSuggestions Error:', error);
    res.status(500).json({ suggestions: ["لخص لي هذا الدرس", "أعطني كويز سريع", "اشرح لي المفهوم الأساسي"] });
  }
}

async function handleGeneralQuestion(message, lang) {
    return "هذه ميزة قيد التحديث."; 
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
