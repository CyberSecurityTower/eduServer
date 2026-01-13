// controllers/ChatBrainController.js
'use strict';

// ==========================================
// 🧠 ChatBrain: The Central Neural Core
// ==========================================

const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const PROMPTS = require('../config/ai-prompts');
const SYSTEM_INSTRUCTION = require('../config/system-instruction');
const logger = require('../utils/logger');

// Services & Managers
const mediaManager = require('../services/media/mediaManager');
const scraper = require('../utils/scraper');
const { generateWithFailover } = require('../services/ai/failover');
const { getAtomicContext, updateAtomicProgress } = require('../services/atomic/atomicManager');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { getCurriculumContext } = require('../services/ai/curriculumContext');
const { getProfile, formatProgressForAI, saveChatSession, refreshUserTasks, getStudentScheduleStatus } = require('../services/data/helpers');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet, getAlgiersTimeContext, nowISO } = require('../utils');
const { getSystemFeatureFlag } = require('../services/data/helpers');

// Reference for Failover Service (Injected)
let generateWithFailoverRef;

/**
 * 🚀 Initialization
 */
function initChatBrainController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('🧠 ChatBrain Controller Initialized (WebSearch + Vision + Context Aware).');
}

/**
 * 📡 The Main Endpoint Handler
 */
async function processChat(req, res) {
  // 1. استقبال البيانات
  let { 
    userId, 
    message, 
    history = [], 
    sessionId, 
    currentContext = {}, // { lessonId, lessonTitle, pageTitle, section }
    files, 
    webSearch = false // 🔥 مفتاح البحث في الويب
  } = req.body;

  // إعدادات الجلسة
  if (!sessionId) sessionId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    // ---------------------------------------------------------
    // 👁️ 1. معالجة "العيون" (Vision & Files)
    // ---------------------------------------------------------
    // إذا كان هناك ملفات، نعالجها عبر مدير الوسائط
    // ملاحظة: files يمكن أن تكون مصفوفة Base64 أو روابط
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, files);
    
    // دمج ملاحظات الملفات مع الرسالة (مثلاً: "المستخدم أرفق ملف PDF يحتوي على...")
    let finalMessage = message + (fileNote || "");

    // إذا لم يكن هناك ملفات وكان هناك روابط في النص، نثري الرسالة (Scraper)
    if ((!attachments || attachments.length === 0) && message) {
        finalMessage = await scraper.enrichMessageWithContext(message);
    }

    // ---------------------------------------------------------
    // 📍 2. الوعي المكاني (Context Awareness)
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;
    let atomicContext = "";
    let atomicData = null;

    // A. هل الطالب داخل درس معين؟
    if (currentContext.lessonId) {
        // جلب بيانات الدرس
        const { data: lData } = await supabase
            .from('lessons')
            .select('*, subjects(title)')
            .eq('id', currentContext.lessonId)
            .single();
        
        lessonData = lData;

        if (lessonData) {
            // جلب محتوى الدرس (RAG)
            const { data: contentData } = await supabase
                .from('lessons_content')
                .select('content')
                .eq('lesson_id', lessonData.id)
                .single();

            const snippet = safeSnippet(contentData?.content || "", 2000); // نأخذ جزء كبير
            
            locationContext = `
            📍 **CURRENT LOCATION:** 
            - User is studying Lesson: "${lessonData.title}"
            - Subject: "${lessonData.subjects?.title}"
            - Context Source: "Official Curriculum"
            
            📖 **LESSON CONTENT (Reference):**
            """
            ${snippet}
            """
            👉 INSTRUCTION: The user is looking at this content RIGHT NOW. Answer questions based on it.
            `;

            // B. حقن النظام الذري (Atomic Context)
            const atomicResult = await getAtomicContext(userId, currentContext.lessonId);
            if (atomicResult) {
                atomicContext = atomicResult.prompt;
                atomicData = atomicResult.rawData;
            }
        }
    } 
    // B. هل هو في صفحة عامة؟ (مثل Dashboard, Profile)
    else if (currentContext.pageTitle) {
        locationContext = `📍 **CURRENT LOCATION:** User is browsing page: "${currentContext.pageTitle}".`;
    }

    // ---------------------------------------------------------
    // 👤 3. بناء الملف الشخصي والسياق
    // ---------------------------------------------------------
    // جلب البيانات بشكل متوازي للسرعة
    const [
        userProfile,
        memoryReport,
        progressReport,
        curriculumMap,
        scheduleStatus,
        isTableEnabled,
        isChartEnabled
    ] = await Promise.all([
        getProfile(userId),
        runMemoryAgent(userId, message).catch(() => ''),
        formatProgressForAI(userId).catch(() => ''),
        getCurriculumContext(), // خريطة المنهج كاملة
        getStudentScheduleStatus(userProfile?.group), // حالة الجدول الزمني
        getSystemFeatureFlag('feature_genui_table'),
        getSystemFeatureFlag('feature_genui_chart')
    ]);

    // تجميع الميزات
    const enabledFeatures = { table: isTableEnabled, chart: isChartEnabled };

    // السياق الزمني (الجزائر)
    const timeContext = getAlgiersTimeContext().contextSummary;

    // ---------------------------------------------------------
    // 🧠 4. تجميع "الدماغ" (Prompt Engineering)
    // ---------------------------------------------------------
    // استخدام البرومبت المركزي الموجود في ai-prompts.js
    // نمرر له كل ما جمعناه
    const systemPrompt = PROMPTS.chat.interactiveChat(
        finalMessage,
        memoryReport,
        '', // curriculumReport (أصبحنا نستخدم locationContext أدق)
        history.map(m => `${m.role}: ${m.text}`).join('\n'), // تنسيق التاريخ
        progressReport,
        [], // weaknesses (اختياري)
        userProfile.emotionalState || {},
        userProfile,
        `
        ${timeContext}
        ${locationContext}
        ${scheduleStatus ? scheduleStatus.context : ''}
        ${webSearch ? '🌍 **WEB SEARCH:** ENABLED. You can search the internet for real-time info.' : ''}
        `, // System Context Combined
        {}, // examContext
        [], // activeAgenda
        "", // groupContext
        currentContext, // raw context
        null, // gravityContext
        "", // absenceContext
        enabledFeatures,
        atomicContext
    );

    logger.info(`🧠 ChatBrain: Generating response for ${userId} (Search: ${webSearch}, Files: ${attachments.length})...`);

    // ---------------------------------------------------------
    // ⚡ 5. الإرسال للموديل (Execution)
    // ---------------------------------------------------------
    let modelResponse;
    let usedSources = [];

    try {
        const result = await generateWithFailoverRef('chat', systemPrompt, {
            label: 'ChatBrain_v1',
            timeoutMs: webSearch ? 60000 : 45000, // وقت أطول للبحث
            attachments: attachments, // إرسال الصور/الملفات
            enableSearch: !!webSearch, // تفعيل البحث
            maxRetries: 2
        });

        // التعامل مع صيغ الاستجابة المختلفة
        if (typeof result === 'object' && result.text) {
            modelResponse = result.text;
            usedSources = result.sources || [];
        } else {
            modelResponse = result;
        }

    } catch (aiError) {
        logger.error('❌ ChatBrain AI Error:', aiError.message);
        throw aiError;
    }

    // ---------------------------------------------------------
    // 🧹 6. تنظيف ومعالجة الرد (Post-Processing)
    // ---------------------------------------------------------
    const rawText = await extractTextFromResult(modelResponse);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    // Fallback إذا فشل الـ JSON
    if (!parsedResponse?.reply) {
        parsedResponse = { 
            reply: rawText || "عذراً، حدث خطأ في المعالجة.", 
            widgets: [] 
        };
    }

    // ---------------------------------------------------------
    // ⚛️ 7. النظام الذري والمكافآت (The Atomic Monitor)
    // ---------------------------------------------------------
    let updateSignal = parsedResponse.atomic_update || null;
    let lessonSignal = parsedResponse.lesson_signal || null;

    // A. تحليل النص للكويزات (تصحيح تلقائي)
    // إذا وجدنا "Score: 5/5" في النص، نعتبره إنجازاً
    const scoreMatch = finalMessage.match(/(\d+)\s*[\/|من]\s*(\d+)/);
    if (scoreMatch) {
        const score = parseInt(scoreMatch[1]);
        const total = parseInt(scoreMatch[2]);
        if (total > 0 && (score / total) >= 0.7) {
            // نجاح في الكويز -> تحديث ذري شامل
            if (lessonData) {
                updateSignal = { element_id: 'ALL', new_score: 100, reason: 'quiz_passed' };
                lessonSignal = { type: 'complete', id: lessonData.id, score: (score/total)*100 };
            }
        }
    }

    // B. تنفيذ التحديث الذري
    if (updateSignal && lessonData) {
        await updateAtomicProgress(userId, lessonData.id, updateSignal);
    }

    // C. منح المكافآت (إتمام الدرس)
    if (lessonSignal && lessonSignal.type === 'complete') {
        const gateResult = await markLessonComplete(userId, lessonSignal.id, lessonSignal.score || 100);
        
        // إضافة ويدجت الاحتفال
        if (gateResult.reward?.coins_added > 0) {
            parsedResponse.widgets = parsedResponse.widgets || [];
            parsedResponse.widgets.push({ 
                type: 'celebration', 
                data: { 
                    message: `مبروك! 🎉 كسبت ${gateResult.reward.coins_added} كوين!`,
                    coins: gateResult.reward.coins_added 
                } 
            });
            // تحديث رصيد الفرونت أند
            res.locals.rewardData = { 
                reward: gateResult.reward, 
                new_total_coins: gateResult.new_total_coins 
            };
        }
        
        // تحديث المهام تلقائياً
        await refreshUserTasks(userId, true);
        parsedResponse.widgets = parsedResponse.widgets || [];
        parsedResponse.widgets.push({ type: 'event_trigger', data: { event: 'tasks_updated' } });
    }

    // ---------------------------------------------------------
    // 📤 8. إرسال الرد النهائي
    // ---------------------------------------------------------
    const responsePayload = {
        reply: parsedResponse.reply,
        widgets: parsedResponse.widgets || [],
        sessionId: sessionId,
        mood: parsedResponse.newMood,
        sources: usedSources, // روابط البحث إن وجدت
        ...(res.locals?.rewardData || {}) // بيانات المكافأة
    };

    res.status(200).json(responsePayload);

    // ---------------------------------------------------------
    // 💾 9. الحفظ في الخلفية (Background)
    // ---------------------------------------------------------
    setImmediate(async () => {
        try {
            // حفظ الرسائل
            const updatedHistory = [
                ...history,
                { role: 'user', text: message, timestamp: nowISO() },
                { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
            ];
            await saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory);
            
            // تحديث الحالة الشعورية
            if (parsedResponse.newMood) {
                supabase.from('ai_memory_profiles').update({
                    emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason }
                }).eq('user_id', userId).then();
            }
        } catch (e) {
            logger.error('Background Save Error:', e);
        }
    });

  } catch (err) {
    logger.error('🔥 ChatBrain Critical Error:', err);
    return res.status(500).json({ 
        reply: "آسف، حدث خطأ في النظام العصبي. حاول مرة أخرى.",
        error: process.env.NODE_ENV === 'development' ? err.message : undefined 
    });
  }
}

module.exports = {
  initChatBrainController,
  processChat
};
