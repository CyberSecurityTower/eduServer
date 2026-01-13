// controllers/ChatBrainController.js
'use strict';

const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const PROMPTS = require('../config/ai-prompts');
const logger = require('../utils/logger');

// Services & Managers
const mediaManager = require('../services/media/mediaManager');
const scraper = require('../utils/scraper');
const { getAtomicContext, updateAtomicProgress } = require('../services/atomic/atomicManager');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { getCurriculumContext } = require('../services/ai/curriculumContext');
const { getProfile, formatProgressForAI, saveChatSession, refreshUserTasks, getStudentScheduleStatus } = require('../services/data/helpers');
const { nowISO } = require('../services/data/dbUtils');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet, getAlgiersTimeContext } = require('../utils');
const { getSystemFeatureFlag } = require('../services/data/helpers');

let generateWithFailoverRef;

function initChatBrainController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('🧠 ChatBrain Controller Initialized (Aggressive Context Mode).');
}

async function processChat(req, res) {
  let { 
    userId, message, history = [], sessionId, 
    currentContext = {}, files, webSearch = false 
  } = req.body;

  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // ---------------------------------------------------------
    // 1. استرجاع بيانات الدرس (الوعي المكاني)
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;
    let atomicContext = "";
    let contentSnippet = null; // تعريف المتغير هنا لنستخدمه لاحقاً
    let subjectTitle = 'General';

    const targetId = currentContext.lessonId;
    const targetTitle = currentContext.lessonTitle || "Unknown Lesson";

    // المنطق اليدوي (Manual Lookup) الذي أثبت نجاحه في الـ Logs
    if (targetId || targetTitle !== "Unknown Lesson") {
        let metaData = null;
        let contentData = null;

        // A. بحث الدرس
        if (targetId) {
            const { data } = await supabase.from('lessons').select('*').eq('id', targetId).maybeSingle();
            metaData = data;
        }
        if (!metaData && targetTitle) {
            const { data } = await supabase.from('lessons').select('*').ilike('title', `%${targetTitle.trim()}%`).limit(1).maybeSingle();
            metaData = data;
        }

        // B. بحث المادة
        if (metaData && metaData.subject_id) {
            const { data: subjectData } = await supabase.from('subjects').select('title').eq('id', metaData.subject_id).maybeSingle();
            if (subjectData) subjectTitle = subjectData.title;
        }

        // C. بحث المحتوى
        const effectiveId = metaData?.id || targetId;
        if (effectiveId) {
            const { data: c1 } = await supabase.from('lessons_content').select('content').eq('id', effectiveId).maybeSingle();
            if (c1) contentData = c1;
            else {
                const { data: c2 } = await supabase.from('lessons_content').select('content').eq('lesson_id', effectiveId).maybeSingle();
                contentData = c2;
            }
        }

        // D. تجهيز البيانات
        lessonData = metaData || { id: targetId || 'manual', title: targetTitle, subject_id: null };
        lessonData.subjects = { title: subjectTitle }; // للهيكلة فقط

        const rawContent = contentData?.content || "";
        contentSnippet = rawContent ? safeSnippet(rawContent, 3000) : null; // زدنا الحجم قليلاً

        // E. طباعة للتحقق (مهم جداً)
        console.log(`🔎 [CONTEXT] Found: ${lessonData.title} | HasContent: ${!!contentSnippet}`);

        // F. بناء سياق الموقع (Aggressive Prompting)
        // التغيير هنا: نجعل السياق أمراً مباشراً (IMPERATIVE)
        if (contentSnippet) {
            locationContext = `
            🚨 **SYSTEM OVERRIDE: ACTIVE LESSON CONTEXT**
            The user is CURRENTLY READING the lesson: "${lessonData.title}" (Subject: ${subjectTitle}).
            
            👇 **SOURCE MATERIAL (Explain based on this):**
            """
            ${contentSnippet}
            """
            
            ⛔ **RULES:**
            1. You act as the TUTOR for THIS specific lesson.
            2. Do NOT say "You haven't chosen a lesson". The user is IN the lesson.
            3. If the user greets you or asks "Explain", explain the content above immediately.
            `;
        } else {
            locationContext = `
            🚨 **SYSTEM OVERRIDE: ACTIVE LESSON CONTEXT**
            The user is viewing: "${lessonData.title}" (Subject: ${subjectTitle}).
            Database content is empty, but you MUST use your internal knowledge to teach this topic.
            Assume the user wants to learn about "${lessonData.title}".
            `;
        }

        if (metaData?.id) {
            const atomicRes = await getAtomicContext(userId, metaData.id);
            if (atomicRes) atomicContext = atomicRes.prompt;
        }
    }

    if (!locationContext && currentContext.pageTitle) {
        locationContext = `📍 User is browsing: "${currentContext.pageTitle}". Be helpful regarding this page.`;
    }

    // ---------------------------------------------------------
    // 2. معالجة الرسالة (Message Enrichment) 🔥 إصلاح مهم
    // ---------------------------------------------------------
    // إذا كان المستخدم داخل درس، والرسالة غامضة أو ترحيبية، نقوم بحقن اسم الدرس في الرسالة
    // حتى يجبر الـ AI على الشرح.
    
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, files);
    let finalMessage = message + (fileNote || "");
    
    // إذا لم يكن هناك ملفات، وكانت الرسالة قصيرة أو عامة، ونحن داخل درس:
    if ((!attachments || attachments.length === 0)) {
        if (lessonData && lessonData.title) {
            // نضيف ملاحظة خفية للـ AI بأن المستخدم يقصد هذا الدرس
            // هذا يمنع الرد "واش من درس؟"
            finalMessage = `[System Context: User is looking at lesson "${lessonData.title}". Explain it or answer their question regarding it.] \n\n User says: ${message}`;
        } else if (message) {
            finalMessage = await scraper.enrichMessageWithContext(message);
        }
    }

    // ---------------------------------------------------------
    // 3. البيانات المساعدة
    // ---------------------------------------------------------
    const userProfile = await getProfile(userId);
    const [
        memoryReport,
        progressReport,
        curriculumMap,
        scheduleStatus,
        isTableEnabled,
        isChartEnabled
    ] = await Promise.all([
        runMemoryAgent(userId, message).catch(() => ''),
        formatProgressForAI(userId).catch(() => ''),
        getCurriculumContext(),
        getStudentScheduleStatus(userProfile?.group),
        getSystemFeatureFlag('feature_genui_table'),
        getSystemFeatureFlag('feature_genui_chart')
    ]);

    const enabledFeatures = { table: isTableEnabled, chart: isChartEnabled };
    const timeContext = getAlgiersTimeContext().contextSummary;

    // ---------------------------------------------------------
    // 4. بناء البرومبت
    // ---------------------------------------------------------
    const systemPrompt = PROMPTS.chat.interactiveChat(
        finalMessage, // نرسل الرسالة المعدلة (المحقونة)
        memoryReport,
        '', 
        history.map(m => `${m.role}: ${m.text}`).join('\n'),
        progressReport,
        [],
        userProfile.emotionalState || {},
        userProfile,
        `
        ${timeContext}
        ${locationContext}  <-- هذا السياق الآن صارم جداً
        ${scheduleStatus ? scheduleStatus.context : ''}
        ${webSearch ? '🌍 **WEB SEARCH:** ENABLED.' : ''}
        `,
        {}, [], "", currentContext, null, "", enabledFeatures, atomicContext
    );

    // ---------------------------------------------------------
    // 5. التنفيذ والاستجابة
    // ---------------------------------------------------------
    let modelResponse;
    let usedSources = [];

    try {
        const result = await generateWithFailoverRef('chat', systemPrompt, {
            label: 'ChatBrain_v3',
            timeoutMs: webSearch ? 60000 : 45000,
            attachments: attachments,
            enableSearch: !!webSearch,
            maxRetries: 2
        });

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

    const rawText = await extractTextFromResult(modelResponse);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) {
        parsedResponse = { reply: rawText || "Error.", widgets: [] };
    }

    // معالجة المكافآت والدروس المكتملة
    let updateSignal = parsedResponse.atomic_update || null;
    let lessonSignal = parsedResponse.lesson_signal || null;

    const scoreMatch = finalMessage.match(/(\d+)\s*[\/|من]\s*(\d+)/); // نستخدم finalMessage لأننا ربما عدلناها
    if (scoreMatch && lessonData?.id && lessonData.id !== 'manual' && lessonData.id !== 'manual_override') {
        const score = parseInt(scoreMatch[1]);
        const total = parseInt(scoreMatch[2]);
        if (total > 0 && (score / total) >= 0.7) {
            updateSignal = { element_id: 'ALL', new_score: 100, reason: 'quiz_passed' };
            lessonSignal = { type: 'complete', id: lessonData.id, score: (score/total)*100 };
        }
    }

    if (updateSignal && lessonData?.id && lessonData.id !== 'manual') {
        await updateAtomicProgress(userId, lessonData.id, updateSignal);
    }

    if (lessonSignal && lessonSignal.type === 'complete' && lessonData?.id) {
        const gateResult = await markLessonComplete(userId, lessonData.id, lessonSignal.score || 100);
        if (gateResult.reward?.coins_added > 0) {
            parsedResponse.widgets = parsedResponse.widgets || [];
            parsedResponse.widgets.push({ 
                type: 'celebration', 
                data: { message: `مبروك! 🪙 +${gateResult.reward.coins_added}`, coins: gateResult.reward.coins_added } 
            });
            res.locals.rewardData = { reward: gateResult.reward, new_total_coins: gateResult.new_total_coins };
        }
        await refreshUserTasks(userId, true);
        parsedResponse.widgets = parsedResponse.widgets || [];
        parsedResponse.widgets.push({ type: 'event_trigger', data: { event: 'tasks_updated' } });
    }

    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: parsedResponse.widgets || [],
        sessionId: sessionId,
        mood: parsedResponse.newMood,
        sources: usedSources,
        ...(res.locals?.rewardData || {})
    });

    setImmediate(async () => {
        try {
            // نحفظ الرسالة الأصلية (message) في الهيستوري وليس المعدلة (finalMessage) للحفاظ على نظافة الشات
            const updatedHistory = [
                ...history,
                { role: 'user', text: message, timestamp: nowISO() },
                { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
            ];
            await saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory);
            
            if (parsedResponse.newMood) {
                supabase.from('ai_memory_profiles').update({
                    emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason }
                }).eq('user_id', userId).then();
            }
        } catch (e) { console.error(e); }
    });

  } catch (err) {
    logger.error('🔥 ChatBrain Fatal:', err);
    return res.status(500).json({ reply: "خطأ تقني." });
  }
}

module.exports = { initChatBrainController, processChat };
