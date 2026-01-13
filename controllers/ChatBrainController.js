// controllers/ChatBrainController.js
'use strict';

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
const { nowISO } = require('../services/data/dbUtils');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet, getAlgiersTimeContext } = require('../utils');
const { getSystemFeatureFlag } = require('../services/data/helpers');

let generateWithFailoverRef;

function initChatBrainController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('🧠 ChatBrain Controller Initialized (Aggressive Mode).');
}

async function processChat(req, res) {
  let { 
    userId, message, history = [], sessionId, 
    currentContext = {}, files, webSearch = false 
  } = req.body;

  if (!sessionId) sessionId = crypto.randomUUID();

  try {
    // 1. معالجة الوسائط
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, files);
    let finalMessage = message + (fileNote || "");
    if ((!attachments || attachments.length === 0) && message) {
        finalMessage = await scraper.enrichMessageWithContext(message);
    }

    // ---------------------------------------------------------
    // 📍 2. الوعي المكاني (Aggressive Context Retrieval) 🔥
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null; // سيحمل { id, title, subject }
    let atomicContext = "";
    let atomicData = null;

    // سنبحث عن الدرس إذا توفر ID أو Title
    const targetId = currentContext.lessonId;
    const targetTitle = currentContext.lessonTitle;

    if (targetId || targetTitle) {
        
        // أ. تشغيل 3 استعلامات في وقت واحد لضمان العثور على البيانات
        // 1. البحث عن تعريف الدرس
        const metaPromise = targetId 
            ? supabase.from('lessons').select('*, subjects(title)').eq('id', targetId).maybeSingle()
            : supabase.from('lessons').select('*, subjects(title)').ilike('title', `%${targetTitle}%`).limit(1).maybeSingle();

        // 2. البحث عن المحتوى (نبحث في العمودين id و lesson_id لضمان النتيجة)
        const contentPromise = targetId 
            ? supabase.from('lessons_content').select('content').or(`id.eq.${targetId},lesson_id.eq.${targetId}`).maybeSingle()
            : Promise.resolve({ data: null }); // لا يمكن البحث عن المحتوى بالعنوان مباشرة بسهولة

        // 3. البحث عن الهيكل الذري
        const atomicPromise = targetId 
            ? getAtomicContext(userId, targetId)
            : Promise.resolve(null);

        // انتظار النتائج
        const [metaRes, contentRes, atomicRes] = await Promise.all([metaPromise, contentPromise, atomicPromise]);

        // ب. تجميع البيانات المتاحة
        lessonData = metaRes.data || { 
            id: targetId || 'unknown_id', 
            title: targetTitle || 'Unknown Lesson', 
            subjects: { title: 'General' } 
        };

        const rawContent = contentRes.data?.content || "";
        
        // ج. بناء السياق (إذا وجدنا محتوى OR وجدنا تعريف الدرس)
        if (rawContent || metaRes.data) {
            
            // إذا لم يكن هناك محتوى في DB، نضع ملاحظة للـ AI
            const contentSnippet = rawContent 
                ? safeSnippet(rawContent, 2500) 
                : "No text content found in database for this lesson.";

            locationContext = `
            📍 **CURRENT LOCATION:** 
            - Studying: "${lessonData.title}"
            - Subject: "${lessonData.subjects?.title}"
            - ID: "${lessonData.id}"
            
            📖 **LESSON SOURCE:**
            """
            ${contentSnippet}
            """
            👉 INSTRUCTION: User is on this lesson. Use the text above to explain.
            `;

            if (atomicRes) {
                atomicContext = atomicRes.prompt;
                atomicData = atomicRes.rawData;
            }
            
            // Debug Log
            console.log(`✅ Context Loaded: ${rawContent.length > 0 ? 'Content Found (' + rawContent.length + ' chars)' : 'Meta Only'}`);
        }
    } 
    
    if (!locationContext && currentContext.pageTitle) {
        locationContext = `📍 **CURRENT LOCATION:** User is browsing page: "${currentContext.pageTitle}".`;
    }

    // ---------------------------------------------------------
    // 👤 3. البروفايل والبيانات المساعدة
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
    // 🧠 4. البرومبت والإرسال
    // ---------------------------------------------------------
    const systemPrompt = PROMPTS.chat.interactiveChat(
        finalMessage,
        memoryReport,
        '', 
        history.map(m => `${m.role}: ${m.text}`).join('\n'),
        progressReport,
        [],
        userProfile.emotionalState || {},
        userProfile,
        `
        ${timeContext}
        ${locationContext}
        ${scheduleStatus ? scheduleStatus.context : ''}
        ${webSearch ? '🌍 **WEB SEARCH:** ENABLED.' : ''}
        `,
        {}, [], "", currentContext, null, "", enabledFeatures, atomicContext
    );

    let modelResponse;
    let usedSources = [];

    try {
        const result = await generateWithFailoverRef('chat', systemPrompt, {
            label: 'ChatBrain_v2',
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

    // ---------------------------------------------------------
    // 🧹 5. المعالجة والرد
    // ---------------------------------------------------------
    const rawText = await extractTextFromResult(modelResponse);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) {
        parsedResponse = { reply: rawText || "Error.", widgets: [] };
    }

    // Atomic Updates Logic
    let updateSignal = parsedResponse.atomic_update || null;
    let lessonSignal = parsedResponse.lesson_signal || null;

    const scoreMatch = finalMessage.match(/(\d+)\s*[\/|من]\s*(\d+)/);
    if (scoreMatch) {
        const score = parseInt(scoreMatch[1]);
        const total = parseInt(scoreMatch[2]);
        if (total > 0 && (score / total) >= 0.7 && lessonData) {
            updateSignal = { element_id: 'ALL', new_score: 100, reason: 'quiz_passed' };
            lessonSignal = { type: 'complete', id: lessonData.id, score: (score/total)*100 };
        }
    }

    if (updateSignal && lessonData) {
        await updateAtomicProgress(userId, lessonData.id, updateSignal);
    }

    if (lessonSignal && lessonSignal.type === 'complete' && lessonData) {
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

    // Background Save
    setImmediate(async () => {
        try {
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
