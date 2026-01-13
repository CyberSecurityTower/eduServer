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
  logger.info('🧠 ChatBrain Controller Initialized (No-Relations Mode).');
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
    // 📍 2. الوعي المكاني (Manual Lookup Mode) 🔥
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;
    let atomicContext = "";
    
    const targetId = currentContext.lessonId;
    const targetTitle = currentContext.lessonTitle || "Unknown Lesson";

    if (targetId || targetTitle !== "Unknown Lesson") {
        
        let metaData = null;
        let contentData = null;
        let subjectTitle = 'General';

        // A. البحث عن الدرس (Lesson) بدون علاقات
        if (targetId) {
            const { data } = await supabase
                .from('lessons')
                .select('*')
                .eq('id', targetId)
                .maybeSingle();
            metaData = data;
        }

        // B. البحث بالعنوان (إذا لم نجد بالـ ID)
        if (!metaData && targetTitle) {
            console.log(`⚠️ Lookup by ID failed/missing. Trying title: "${targetTitle}"`);
            const { data } = await supabase
                .from('lessons')
                .select('*')
                .ilike('title', `%${targetTitle.trim()}%`) 
                .limit(1)
                .maybeSingle();
            metaData = data;
        }

        // C. جلب اسم المادة (Subject) يدوياً
        if (metaData && metaData.subject_id) {
            const { data: subjectData } = await supabase
                .from('subjects')
                .select('title')
                .eq('id', metaData.subject_id)
                .maybeSingle();
            
            if (subjectData) {
                subjectTitle = subjectData.title;
            }
        }

        // D. جلب المحتوى (Content)
        const effectiveId = metaData?.id || targetId;
        if (effectiveId) {
            // محاولة 1: الربط المباشر (id = id)
            const { data: c1 } = await supabase
                .from('lessons_content')
                .select('content')
                .eq('id', effectiveId)
                .maybeSingle();
            
            if (c1) {
                contentData = c1;
            } else {
                // محاولة 2: الربط عبر lesson_id
                const { data: c2 } = await supabase
                    .from('lessons_content')
                    .select('content')
                    .eq('lesson_id', effectiveId)
                    .maybeSingle();
                contentData = c2;
            }
        }

        // E. تجميع البيانات
        lessonData = metaData || { 
            id: targetId || 'manual_override', 
            title: targetTitle, 
            subject_id: null 
        };
        lessonData.subjects = { title: subjectTitle };

        const rawContent = contentData?.content || "";
        const contentSnippet = rawContent ? safeSnippet(rawContent, 2500) : null;

        // =========================================================
        // 🖨️ طباعة نتائج البحث (DEBUGGING LOGS)
        // =========================================================
        console.log("\n🔎 [DEBUG] DATABASE RETRIEVAL RESULT:");
        console.log("--------------------------------------------------");
        console.log(`🆔 TARGET ID:   ${effectiveId}`);
        console.log(`📚 LESSON:      ${lessonData.title}`);
        console.log(`🏷️ SUBJECT:     ${subjectTitle}`);
        console.log(`📄 HAS CONTENT? ${contentSnippet ? "✅ YES" : "❌ NO"}`);
        if (contentSnippet) {
            console.log(`📝 START OF CONTENT: "${contentSnippet.substring(0, 150).replace(/\n/g, ' ')}..."`);
        }
        console.log("--------------------------------------------------\n");
        // =========================================================

        // F. بناء سياق الموقع
        if (contentSnippet) {
            locationContext = `
            📍 **CURRENT LOCATION:** 
            - User is studying: "${lessonData.title}"
            - Subject: "${subjectTitle}"
            
            📖 **LESSON CONTENT (FROM DB):**
            """
            ${contentSnippet}
            """
            👉 INSTRUCTION: Use this content to explain.
            `;
        } else {
            locationContext = `
            📍 **CURRENT LOCATION:** 
            - User is currently opening the lesson: "${lessonData.title}"
            - Subject: "${subjectTitle}"
            
            ⚠️ **NOTE:** Database content is missing for this lesson.
            👉 **INSTRUCTION:** You MUST explain "${lessonData.title}" using your own internal knowledge. Do NOT ask "what lesson?". Assume the user is looking at it.
            `;
        }

        // جلب السياق الذري
        if (metaData?.id) {
            const atomicRes = await getAtomicContext(userId, metaData.id);
            if (atomicRes) atomicContext = atomicRes.prompt;
        }
    } 

    
    if (!locationContext && currentContext.pageTitle) {
        locationContext = `📍 **CURRENT LOCATION:** User is browsing page: "${currentContext.pageTitle}".`;
    }

    // ---------------------------------------------------------
    // 👤 3. البيانات المساعدة
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
    // 🧠 4. البرومبت
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

    // ---------------------------------------------------------
    // 🧹 5. المعالجة
    // ---------------------------------------------------------
    const rawText = await extractTextFromResult(modelResponse);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) {
        parsedResponse = { reply: rawText || "Error.", widgets: [] };
    }

    // Atomic & Rewards
    let updateSignal = parsedResponse.atomic_update || null;
    let lessonSignal = parsedResponse.lesson_signal || null;

    const scoreMatch = finalMessage.match(/(\d+)\s*[\/|من]\s*(\d+)/);
    if (scoreMatch && lessonData?.id && lessonData.id !== 'manual_override') {
        const score = parseInt(scoreMatch[1]);
        const total = parseInt(scoreMatch[2]);
        if (total > 0 && (score / total) >= 0.7) {
            updateSignal = { element_id: 'ALL', new_score: 100, reason: 'quiz_passed' };
            lessonSignal = { type: 'complete', id: lessonData.id, score: (score/total)*100 };
        }
    }

    if (updateSignal && lessonData?.id && lessonData.id !== 'manual_override') {
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
