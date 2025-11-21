
// controllers/chatController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const {
  getProgress, fetchUserWeaknesses, formatProgressForAI, saveChatSession
} = require('../services/data/helpers');

// Managers
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runConversationAgent } = require('../services/ai/managers/conversationManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer'); // ✅ Smart Scheduler

// Configs & Utils
const CREATOR_PROFILE = require('../config/creator-profile'); // ✅ استيراد البروفايل
const { escapeForPrompt, safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef;
let saveMemoryChunkRef;
const db = getFirestoreInstance(); // Initialize DB instance

function initChatController(dependencies) {
  if (!dependencies.generateWithFailover) throw new Error('Chat Controller needs generateWithFailover');
  generateWithFailoverRef = dependencies.generateWithFailover;
  saveMemoryChunkRef = dependencies.saveMemoryChunk;
  logger.info('Chat Controller initialized.');
}

// ✅ Helper: Format Time for Memory (Context Awareness)
function formatMemoryTime(memoryObject) {
  if (!memoryObject || !memoryObject.timestamp) return "";
  
  const eventDate = new Date(memoryObject.timestamp);
  const now = new Date();
  const diffMs = now - eventDate;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  let timeString = "";
  if (diffHours < 1) timeString = "Just now";
  else if (diffHours < 24) timeString = `${Math.floor(diffHours)} hours ago`;
  else if (diffDays < 2) timeString = "Yesterday";
  else timeString = `${Math.floor(diffDays)} days ago`;

  // نفترض أن الحقل المخزن اسمه 'value' أو 'text'
  const content = memoryObject.value || memoryObject.text || ""; 
  return `(${timeString}): ${content}`;
}

// --- GenUI Main Handler ---
async function chatInteractive(req, res) {
    const { userId, message, history = [], sessionId: clientSessionId, context = {} } = req.body;
    
    if (!userId || !message) {
        return res.status(400).json({ error: 'Missing userId or message' });
    }

    const sessionId = clientSessionId || `chat_${Date.now()}_${userId.slice(0, 5)}`;
    const chatTitle = message.substring(0, 30);

    try {
        // 1. RAG & Context Retrieval (Parallel for speed)
        const [
          vectorMemoryReport, // الذاكرة النصية القديمة (Embeddings)
          curriculumReport,
          conversationReport,
          progress,
          weaknesses,
          formattedProgress,
          userDocSnapshot // ✅ نجلب وثيقة المستخدم كاملة للذاكرة الهيكلية
        ] = await Promise.all([
          runMemoryAgent(userId, message).catch(() => ''),
          runCurriculumAgent(userId, message).catch(() => ''),
          runConversationAgent(userId, message).catch(() => ''),
          getProgress(userId).catch(() => ({})),
          fetchUserWeaknesses(userId).catch(() => []),
          formatProgressForAI(userId).catch(() => ''),
          db.collection('users').doc(userId).get(),
        ]);

        // 2. معالجة الذاكرة الهيكلية والزمنية (Temporal & Structured Memory)
        const userData = userDocSnapshot.exists ? userDocSnapshot.data() : {};
        const structuredMemory = userData.memory || {};

        // A. Emotional Context
        let emotionalContext = "Mood: Stable/Unknown.";
        if (structuredMemory.emotions && Array.isArray(structuredMemory.emotions) && structuredMemory.emotions.length > 0) {
            // نأخذ آخر 3 مشاعر (الأحدث أولاً)
            const recent = structuredMemory.emotions.slice(-3).reverse().map(formatMemoryTime);
            emotionalContext = `Recent Moods:\n- ${recent.join('\n- ')}`;
        }

        // B. Romance Context
        let romanceContext = "";
        if (structuredMemory.romance && Array.isArray(structuredMemory.romance) && structuredMemory.romance.length > 0) {
            const recent = structuredMemory.romance.slice(-2).reverse().map(formatMemoryTime);
            romanceContext = `❤️ Romance Life:\n- ${recent.join('\n- ')}`;
        }
        
        // C. Note From Past Self
        const noteToSelf = userData.aiNoteToSelf 
            ? `📝 **NOTE FROM YOUR PAST SELF:** "${userData.aiNoteToSelf}"` 
            : "";

        // 3. تجهيز سجل المحادثة (Last 5 exchanges)
        const lastFive = (Array.isArray(history) ? history.slice(-5) : [])
          .map(h => `${h.role === 'model' ? 'EduAI' : 'User'}: ${safeSnippet(h.text || '', 200)}`).join('\n');

        // 4. بناء البرومبت النهائي (Prompt Engineering)
        const finalPrompt = PROMPTS.chat.interactiveChat(
          message,
          vectorMemoryReport,
          curriculumReport,
          conversationReport,
          lastFive,
          formattedProgress,
          weaknesses,
          emotionalContext, // ✅ سياق المشاعر
          romanceContext,   // ✅ سياق العلاقات
          noteToSelf,       // ✅ ملاحظة للذات
          CREATOR_PROFILE   // ✅ ملف المؤسس
        );

        // 5. توليد الرد (AI Generation)
        const modelResp = await generateWithFailoverRef('chat', finalPrompt, { label: 'GenUI', timeoutMs: 25000 });
        const rawText = await extractTextFromResult(modelResp);

        // 6. تحليل وإصلاح الـ JSON (Parsing & Repair)
        let parsed = await ensureJsonOrRepair(rawText, 'chat');
        
        // Fallback safety
        if (!parsed || !parsed.reply) {
          logger.warn(`JSON parsing failed for user ${userId}, falling back to raw text.`);
          parsed = { reply: rawText || "عذراً، حدث خطأ بسيط في المعالجة.", widgets: [], needsScheduling: false };
        }

        const botReplyText = parsed.reply;
        const widgets = parsed.widgets || [];

        // 7. بناء التاريخ المحدث (Updated History)
        const updatedHistory = [
            ...history, 
            { role: 'user', text: message }, 
            { role: 'model', text: botReplyText, widgets: widgets }
        ];
        
        // 8. إرسال الرد للعميل (Fast Response) 🚀
        res.status(200).json({
          reply: botReplyText,
          widgets: widgets,
          sessionId,
          chatTitle
        });

        // ============================================================
        // 9. مهام الخلفية (Post-Response Background Tasks) 🏃‍♂️💨
        // ============================================================

        // A. حفظ الجلسة
        saveChatSession(sessionId, userId, chatTitle, updatedHistory, context.type || 'main', context)
          .catch(e => logger.error('SaveChat err', e));
        
        // B. حفظ الذاكرة المتجهة (Vector)
        if (saveMemoryChunkRef) {
            saveMemoryChunkRef(userId, message).catch(() => {});
        }

        // C. الجدولة الذكية (Smart Scheduler Trigger)
        if (parsed.needsScheduling === true) {
            logger.info(`[Scheduler] Triggered for user ${userId}`);
            // نرسل السجل كاملاً ليعرف الماناجر على ماذا وافق المستخدم
            analyzeSessionForEvents(userId, updatedHistory).catch(err => {
                logger.warn(`[Scheduler] Analysis failed:`, err.message);
            });
        }

        // D. حصاد المعلومات الفوري (Memory Harvesting)
        // إذا اكتشف الـ AI معلومة جديدة أثناء المحادثة وقرر إرسالها فوراً
        const updates = {};
        
        // هل اكتشفنا معلومة جديدة؟ (المهمة السرية نجحت!)
        if (parsed.newFact) {
            const { category, value } = parsed.newFact;
            if (category && value) {
                const memoryObject = {
                    value: value,
                    timestamp: new Date().toISOString() // نضيف التوقيت هنا
                };
                // حفظ في: memory.preferences = [...]
                updates[`memory.${category}`] = admin.firestore.FieldValue.arrayUnion(memoryObject); 
                logger.success(`[Discovery] AI learned: ${category} -> ${value}`);
            }
        }

        // هل ترك الـ AI ملاحظة لنفسه للمرة القادمة؟
        if (parsed.noteToNextSelf) {
            updates['aiNoteToSelf'] = parsed.noteToNextSelf;
            logger.info(`[Self-Note] Saved: ${parsed.noteToNextSelf}`);
        }

        // تنفيذ التحديث
        if (Object.keys(updates).length > 0) {
            db.collection('users').doc(userId).set(updates, { merge: true })
              .catch(err => logger.error('Harvesting Save Error:', err));
        }
    
    } catch (err) {
        logger.error('chatInteractive Critical Error:', err);
        // رد آمن في حالة الانهيار التام
        if (!res.headersSent) {
            res.status(500).json({ 
                reply: "واجهت مشكلة تقنية بسيطة. هل يمكنك إعادة السؤال؟", 
                widgets: [] 
            });
        }
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
    res.status(500).json({ suggestions: ["لخص لي هذا الدرس", "أعطني كويز سريع", "اشرح لي المفهوم الأساسي"] });
  }
}

// --- Legacy Handler (for Worker fallback) ---
async function handleGeneralQuestion(message, language = 'Arabic') {
    // هذه الدالة تستخدمها الـ Workers للرد النصي البسيط
    return "أنا هنا لمساعدتك! (رد تلقائي)"; 
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
