// controllers/chatController.js
'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const supabase = require('../services/data/supabase');
const PROMPTS = require('../config/ai-prompts');
const mediaManager = require('../services/media/mediaManager'); 
const scraper = require('../utils/scraper');
const { getAtomicContext } = require('../services/atomic/atomicManager'); // (Read Only)
const { generateWithFailover } = require('../services/ai/failover'); 
const { getCurriculumContext } = require('../services/ai/curriculumContext');
const logger = require('../utils/logger');

// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const {
  getAlgiersTimeContext,
  extractTextFromResult,
  ensureJsonOrRepair,
  safeSnippet
} = require('../utils');

// Data Helpers
const {
  getProfile,
  saveChatSession,
  getLastActiveSessionContext,
  refreshUserTasks
} = require('../services/data/helpers');

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Coach Mode 🧠).');
}

// ==========================================
// 3. Main Logic: Chat Interactive
// ==========================================
async function chatInteractive(req, res) {
  let { userId, message, history, sessionId, currentContext, files, file, webSearch } = req.body;
  
  if (!currentContext) currentContext = {};
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!Array.isArray(history)) history = [];

  try {
    // ---------------------------------------------------------
    // A. HISTORY & BRIDGING (استعادة الذاكرة)
    // ---------------------------------------------------------
    if (!history || history.length === 0) {
      const { data: sessionData } = await supabase
        .from('chat_sessions')
        .select('messages')
        .eq('id', sessionId)
        .single();

      if (sessionData && sessionData.messages) {
        history = sessionData.messages.map(m => ({
          role: m.author === 'bot' ? 'model' : 'user',
          text: m.text,
          timestamp: m.timestamp
        })).slice(-10);
      } else {
        const bridgeContext = await getLastActiveSessionContext(userId, sessionId);
        if (bridgeContext) history = bridgeContext.messages;
      }
    }

    // ---------------------------------------------------------
    // B. MEDIA & TOOLS PROCESSING (معالجة الملفات والروابط)
    // ---------------------------------------------------------
    const inputFiles = files || (file ? [file] : []);
    
    // 1. معالجة المرفقات
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, inputFiles);
    
    // 2. معالجة الروابط (Scraping)
    if ((!attachments || attachments.length === 0) && message && webSearch) {
        message = await scraper.enrichMessageWithContext(message);
    }

    const finalMessage = message + (fileNote || "");

    // ---------------------------------------------------------
    // C. FETCH USER DATA & GROUP LOGIC
    // ---------------------------------------------------------
    const { data: userRaw, error: userError } = await supabase
      .from('users')
      .select('*, group_id, role')
      .eq('id', userId)
      .single();

    if (userError || !userRaw) return res.status(404).json({ reply: "حساب غير موجود." });

    let userData = toCamelCase(userRaw);

    // منطق تسجيل الفوج (مهم جداً للطلاب الجدد)
    if (!userData.groupId) {
      const groupMatch = message.match(/(?:فوج|group|groupe|g)\s*(\d+)/i);
      if (groupMatch) {
        const groupNum = groupMatch[1];
        const pathId = userData.selectedPathId || 'UAlger3_L1_ITCF';
        const newGroupId = `${pathId}_G${groupNum}`;
        await supabase.from('users').update({ group_id: newGroupId }).eq('id', userId);
        return res.status(200).json({ reply: `تم! ✅ راك مسجل في الفوج ${groupNum}.`, sessionId });
      } else {
        return res.status(200).json({ reply: "مرحبا! 👋 واش من فوج (Groupe) راك تقرا فيه؟", sessionId });
      }
    }

    // ---------------------------------------------------------
    // D. CONTEXT AGGREGATION (تجميع المعلومات)
    // ---------------------------------------------------------
    
    // 1. المحتوى التعليمي (RAG)
    let lessonContentSnippet = "";
    if (currentContext.lessonId) {
        const { data: contentData } = await supabase
            .from('lessons_content')
            .select('content')
            .eq('id', currentContext.lessonId)
            .maybeSingle();
        if (contentData) lessonContentSnippet = contentData.content;
    }

    // 2. النظام الذري (Lazy Sync - Read Only)
    let atomicPromptSection = "";
    if (currentContext.lessonId) {
        const atomicResult = await getAtomicContext(userId, currentContext.lessonId);
        if (atomicResult) atomicPromptSection = atomicResult.prompt;
    }

    // 3. البروفايل والمهام (Tasks/Gravity)
    // نحتاج المهام ليعرف الـ AI ماذا يقترح، لكن بدون دراما
    const [userProfile, userTasksRes] = await Promise.all([
        getProfile(userId),
        supabase.from('user_tasks').select('*').eq('user_id', userId).eq('status', 'pending')
    ]);

    // صياغة قائمة المهام للـ AI (للعلم فقط)
    let tasksList = "No active tasks.";
    if (userTasksRes.data && userTasksRes.data.length > 0) {
        tasksList = userTasksRes.data.map(t => `- ${t.title}`).join('\n');
    }

    // 4. سياق الوقت والمكان
    const timeContext = getAlgiersTimeContext().contextSummary;
    const systemContextCombined = `
    ${timeContext}
    📋 **CURRENT TODO LIST:**
    ${tasksList}
    `;

    // ---------------------------------------------------------
    // E. AI GENERATION (COACH MODE)
    // ---------------------------------------------------------
    const finalPrompt = PROMPTS.chat.interactiveChat(
      finalMessage,
      userProfile,
      systemContextCombined,
      atomicPromptSection,
      lessonContentSnippet
    );

    // استدعاء الموديل
    const resultObj = await generateWithFailoverRef('chat', finalPrompt, { 
        label: 'MasterChat', 
        timeoutMs: CONFIG.TIMEOUTS.chat, 
        attachments: attachments, 
        enableSearch: !!webSearch,
        history: history // نمرر الهيستوري للموديل
    });

    // معالجة الرد
    const rawText = await extractTextFromResult(resultObj);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };

    // ---------------------------------------------------------
    // F. POST-PROCESSING (بدون تحديث الأتوميك)
    // ---------------------------------------------------------

    // 1. معالجة أوامر الأجندة (حذف/إنهاء مهام) - هذه ميزة مفيدة نحتفظ بها
    let tasksChanged = false;
    if (parsedResponse.agenda_actions && Array.isArray(parsedResponse.agenda_actions)) {
      for (const act of parsedResponse.agenda_actions) {
        if (act.action === 'delete' || act.action === 'complete') {
           await supabase.from('user_tasks').delete().eq('id', act.id); // أو تحديث الحالة
           tasksChanged = true;
        }
      }
    }

    // إذا تغيرت المهام، نرسل تريجر للتحديث
    if (tasksChanged) {
        const newTasks = await refreshUserTasks(userId); // إعادة التوليد
        parsedResponse.widgets = parsedResponse.widgets || [];
        parsedResponse.widgets.push({ 
            type: 'event_trigger', 
            data: { event: 'tasks_updated', tasks: newTasks } 
        });
    }

    // 🛑 ملاحظة هامة: تم إزالة `updateAtomicProgress` و `gatekeeper logic` من هنا.
    // الـ AI الآن يشرح فقط. الأرينا هي التي ستختبر وتحدث الدرجات.

    // ---------------------------------------------------------
    // G. RESPONSE & SAVE
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId
    });

    // حفظ المحادثة في الخلفية
    setImmediate(async () => {
      try {
        const updatedHistory = [
          ...history,
          { role: 'user', text: message, timestamp: nowISO() },
          { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
        ];
        await saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory);
      } catch (bgError) {
        logger.error("SaveChat Error:", bgError);
      }
    });

  } catch (err) {
    logger.error("ChatInteractive CRITICAL:", err);
    if (!res.headersSent) {
      res.status(500).json({ reply: "حدث خطأ في الخادم." });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  // Helper handlers
  handleGeneralQuestion,
  generateChatSuggestions
};
