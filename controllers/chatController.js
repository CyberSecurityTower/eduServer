
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance } = require('../services/data/firestore');
const {
  getProgress, fetchUserWeaknesses, formatProgressForAI, saveChatSession
} = require('../services/data/helpers');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer'); // ✅ Smart Scheduler

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
        
        if (!userId || !message) {
            return res.status(400).json({ error: 'Missing userId or message' });
        }
    
        const sessionId = clientSessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
        const chatTitle = message.substring(0, 30);
    
        // 1. RAG & Context Retrieval (Parallel for speed)
        const [memory, curriculum, conversation, progress, weaknesses, progressFmt] = await Promise.all([
          runMemoryAgent(userId, message).catch(() => ''),
          runCurriculumAgent(userId, message).catch(() => ''),
          runConversationAgent(userId, message).catch(() => ''),
          getProgress(userId).catch(() => ({})),
          fetchUserWeaknesses(userId).catch(() => []),
          formatProgressForAI(userId).catch(() => '')
        ]);
    
        // 2. History Formatting (Last 5 exchanges)
        const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
          .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 200)}`).join('\n');
    
        // 3. Prompt Engineering (Injecting the "Cool Persona" & "Formatting Rules")
        const prompt = PROMPTS.chat.interactiveChat(
          message, memory, curriculum, conversation, lastFive, progressFmt, weaknesses
        );
    
        // 4. AI Generation
        const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GenUI', timeoutMs: 25000 });
        const rawText = await extractTextFromResult(modelResp);
    
        // 5. Parsing & Repair (Safety Net)
        let parsed = await ensureJsonOrRepair(rawText, 'chat');
        
        // Fallback if parsing fails completely
        if (!parsed || !parsed.reply) {
          logger.warn(`JSON parsing failed for user ${userId}, falling back to raw text.`);
          parsed = { reply: rawText || "عذراً، حدث خطأ بسيط في المعالجة.", widgets: [], needsScheduling: false };
        }
    
        // 6. Construct Updated History (including the new reply)
        const botReplyText = parsed.reply;
        const widgets = parsed.widgets || [];
        const updatedHistory = [
            ...history, 
            { role: 'user', text: message }, 
            { role: 'model', text: botReplyText, widgets: widgets }
        ];
        
        // 7. Background Tasks (Fire & Forget) 🏃‍♂️💨
        
        // A. Save Chat Session
        saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main', context)
          .catch(e => logger.error('SaveChat err', e));
        
        // B. Update Long-term Memory Embedding
        if (saveMemoryChunkRef) {
            saveMemoryChunkRef(userId, message).catch(() => {});
        }

        // ✅ C. Smart Scheduling Trigger
        // If the AI detected a need for scheduling (set via prompt logic), OR strictly if true
        if (parsed.needsScheduling === true) {
            logger.info(`[Scheduler] Triggered for user ${userId}`);
            // Send the FULL history so the analyzer sees the agreement ("Yes, remind me")
            analyzeSessionForEvents(userId, updatedHistory).catch(err => {
                logger.warn(`[Scheduler] Analysis failed:`, err.message);
            });
        }
    
        // 8. Send Response to Client
        res.status(200).json({
          reply: botReplyText,
          widgets: widgets,
          sessionId,
          chatTitle
        });
    
      } catch (err) {
        logger.error('chatInteractive Error:', err);
        // Fail gracefully to the user
        res.status(500).json({ 
            reply: "واجهت مشكلة تقنية بسيطة. هل يمكنك إعادة السؤال؟", 
            widgets: [] 
        });
      }
   // 9. Memory Harvesting (Real-time)
    const updates = {};
    
    // هل اكتشفنا معلومة جديدة؟ (المهمة السرية نجحت!)
    if (parsedResponse.newFact) {
        const { category, value } = parsedResponse.newFact;
        // حفظ في map: facts.music = "Rai"
        updates[`facts.${category}`] = admin.firestore.FieldValue.arrayUnion(value); 
        logger.success(`[Discovery] AI learned: ${category} -> ${value}`);
    }

    // هل ترك الـ AI ملاحظة لنفسه؟
    if (parsedResponse.noteToNextSelf) {
        updates['aiNoteToSelf'] = parsedResponse.noteToNextSelf;
        logger.info(`[Self-Note] Saved: ${parsedResponse.noteToNextSelf}`);
    }

    // تنفيذ التحديث إذا وجد
    if (Object.keys(updates).length > 0) {
        await db.collection('users').doc(userId).set(updates, { merge: true });
    }
}

// --- Suggestions Handler ---
async function generateChatSuggestions(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const suggestions = await runSuggestionManager(userId);
    res.status(200).json({ suggestions });
  } catch (error) {
    logger.error('generateChatSuggestions Error:', error);
    // Fallback suggestions if AI fails
    res.status(500).json({ suggestions: ["لخص لي هذا الدرس", "أعطني كويز سريع", "اشرح لي المفهوم الأساسي"] });
  }
}

// --- Legacy Handler (for Worker fallback) ---
async function handleGeneralQuestion(message, lang) {
    return "هذه الميزة قيد التحديث حالياً."; 
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
