// controllers/ChatBrainController.js
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

const CONFIG = require('../config');
const cloudinary = require('../config/cloudinary'); // Ensure this is configured
const supabase = require('../services/data/supabase');
const PROMPTS = require('../config/ai-prompts');
const logger = require('../utils/logger');

// Services & Managers
const scraper = require('../utils/scraper');
const { getAtomicContext, updateAtomicProgress } = require('../services/atomic/atomicManager');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const { runMemoryAgent } = require('../services/ai/managers/memoryManager');
const { getCurriculumContext } = require('../services/ai/curriculumContext');
const { getProfile, formatProgressForAI, refreshUserTasks, getStudentScheduleStatus } = require('../services/data/helpers');
const { nowISO } = require('../services/data/dbUtils');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet, getAlgiersTimeContext } = require('../utils');
const { getSystemFeatureFlag } = require('../services/data/helpers');

let generateWithFailoverRef;

function initChatBrainController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('🧠 ChatBrain Controller Initialized (Merged V1 Context + V2 Files).');
}

// ============================================================
// 🛠️ Helper: Text Extraction (Background Worker)
// ============================================================
async function extractTextFromCloudinaryUrl(url, mimeType) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        if (mimeType === 'application/pdf') {
            const data = await pdf(buffer);
            // Clean up text (remove excessive newlines common in PDFs)
            return data.text.replace(/\n\s*\n/g, '\n').trim(); 
        } 
        else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value.trim();
        }
        else if (mimeType.startsWith('text/')) {
            return buffer.toString('utf-8');
        }
        return null;
    } catch (error) {
        logger.error(`❌ Text Extraction Failed for ${url}:`, error.message);
        return null;
    }
}

// ============================================================
// 🧠 Main Process Chat
// ============================================================
async function processChat(req, res) {
  let { 
    userId, message, history = [], sessionId, 
    currentContext = {}, files = [], webSearch = false 
  } = req.body;

  // 1. Session Management (V2 Logic integrated)
  if (!sessionId) {
      // Check for existing open session for this context to maintain continuity
      const { data: existingSession } = await supabase
          .from('chat_sessions')
          .select('id')
          .eq('user_id', userId)
          .eq('context_id', currentContext.lessonId || 'general')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

      sessionId = existingSession?.id || crypto.randomUUID();
  }

  try {
    // ---------------------------------------------------------
    // 2. File Processing (V2 Logic: Upload + Prep)
    // ---------------------------------------------------------
    const uploadedAttachments = []; // Stores Cloudinary URLs for DB
    const aiAttachments = [];       // Stores Base64 for immediate AI consumption
    let fileContextNote = "";

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                // A. Prepare for AI (Immediate Multimodal)
                // Remove header if present to get pure base64
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                
                aiAttachments.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: file.mime
                    },
                    // Fallback properties if generateWithFailover expects different format
                    type: file.mime.startsWith('image') ? 'image' : 'file',
                    base64: base64Data,
                    mime: file.mime
                });

                // B. Upload to Cloudinary (Persistence)
                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, {
                    resource_type: "auto",
                    folder: `chat_uploads/${userId}`
                });

                uploadedAttachments.push({
                    url: uploadRes.secure_url,
                    public_id: uploadRes.public_id,
                    mime: file.mime,
                    type: file.mime.startsWith('image') ? 'image' : (file.mime.startsWith('audio') ? 'audio' : 'file')
                });

            } catch (uploadErr) {
                logger.error('File Upload Error:', uploadErr);
            }
        }
        
        if (uploadedAttachments.length > 0) {
            fileContextNote = `\n[System: User has attached ${uploadedAttachments.length} file(s). Analyze them based on the visual/text content provided.]`;
        }
    }

    // ---------------------------------------------------------
    // 3. Lesson Context (V1 Logic - "Spatial Awareness")
    // ---------------------------------------------------------
    let locationContext = "";
    let lessonData = null;
    let atomicContext = "";
    let contentSnippet = null;
    let subjectTitle = 'General';

    const targetId = currentContext.lessonId;
    const targetTitle = currentContext.lessonTitle || "Unknown Lesson";

    if (targetId || targetTitle !== "Unknown Lesson") {
        let metaData = null;
        let contentData = null;

        // Search for Lesson
        if (targetId) {
            const { data } = await supabase.from('lessons').select('*').eq('id', targetId).maybeSingle();
            metaData = data;
        }
        if (!metaData && targetTitle) {
            const { data } = await supabase.from('lessons').select('*').ilike('title', `%${targetTitle.trim()}%`).limit(1).maybeSingle();
            metaData = data;
        }

        // Get Subject
        if (metaData && metaData.subject_id) {
            const { data: subjectData } = await supabase.from('subjects').select('title').eq('id', metaData.subject_id).maybeSingle();
            if (subjectData) subjectTitle = subjectData.title;
        }

        // Get Content
        const effectiveId = metaData?.id || targetId;
        if (effectiveId) {
            const { data: c1 } = await supabase.from('lessons_content').select('content').eq('id', effectiveId).maybeSingle();
            contentData = c1 || await supabase.from('lessons_content').select('content').eq('lesson_id', effectiveId).maybeSingle().then(r => r.data);
        }

        lessonData = metaData || { id: targetId || 'manual', title: targetTitle, subject_id: null };
        const rawContent = contentData?.content || "";
        contentSnippet = rawContent ? safeSnippet(rawContent, 3000) : null;

        // Build Context Prompt
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
            2. Explain the content above immediately if asked.
            `;
        } else {
            locationContext = `
            🚨 **SYSTEM OVERRIDE: ACTIVE LESSON CONTEXT**
            The user is viewing: "${lessonData.title}" (Subject: ${subjectTitle}).
            Database content is empty, but you MUST use your internal knowledge to teach this topic.
            `;
        }

        if (metaData?.id) {
            const atomicRes = await getAtomicContext(userId, metaData.id);
            if (atomicRes) atomicContext = atomicRes.prompt;
        }
    }

    // ---------------------------------------------------------
    // 4. Message Enrichment & Prompt Construction
    // ---------------------------------------------------------
    let finalMessage = message + fileContextNote;

    // Smart context injection if message is vague but lesson is active
    if (lessonData && lessonData.title && aiAttachments.length === 0 && message.length < 10) {
        finalMessage = `[System Context: User is looking at lesson "${lessonData.title}".] \n\n User says: ${message}`;
    }

    const userProfile = await getProfile(userId);
    const [memoryReport, progressReport, curriculumMap, scheduleStatus, isTableEnabled, isChartEnabled] = await Promise.all([
        runMemoryAgent(userId, message).catch(() => ''),
        formatProgressForAI(userId).catch(() => ''),
        getCurriculumContext(),
        getStudentScheduleStatus(userProfile?.group),
        getSystemFeatureFlag('feature_genui_table'),
        getSystemFeatureFlag('feature_genui_chart')
    ]);

    const timeContext = getAlgiersTimeContext().contextSummary;

    const systemPrompt = PROMPTS.chat.interactiveChat(
        finalMessage,
        memoryReport,
        '', 
        history.map(m => `${m.role}: ${m.text}`).join('\n'), // Use frontend history for immediate context
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
        {}, [], "", currentContext, null, "", 
        { table: isTableEnabled, chart: isChartEnabled }, 
        atomicContext
    );

    // ---------------------------------------------------------
    // 5. Execution (Using Failover + Attachments)
    // ---------------------------------------------------------
    let modelResponse;
    let usedSources = [];

    // Save User Message to DB (V2 Style - Before Response)
    // We save basic info first, will update with extracted text later
    const { data: savedUserMsg } = await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: message,
        attachments: uploadedAttachments, 
        metadata: { context: currentContext } 
    }).select().single();

    try {
        const result = await generateWithFailoverRef('chat', systemPrompt, {
            label: 'ChatBrain_v4_Unified',
            timeoutMs: webSearch ? 60000 : 45000,
            attachments: aiAttachments, // Pass the processed Base64 files
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
    // 6. Response Parsing & Widget Logic
    // ---------------------------------------------------------
    const rawText = await extractTextFromResult(modelResponse);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) {
        parsedResponse = { reply: rawText || "Error.", widgets: [] };
    }

    // Atomic Progress & Lesson Completion Logic
    let updateSignal = parsedResponse.atomic_update || null;
    let lessonSignal = parsedResponse.lesson_signal || null;

    // Regex check for quiz scores (Manual override)
    const scoreMatch = finalMessage.match(/(\d+)\s*[\/|من]\s*(\d+)/); 
    if (scoreMatch && lessonData?.id && lessonData.id !== 'manual') {
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
    }

    // Send Response to Client
    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: parsedResponse.widgets || [],
        sessionId: sessionId,
        mood: parsedResponse.newMood,
        sources: usedSources,
        ...(res.locals?.rewardData || {})
    });

    // ---------------------------------------------------------
    // 7. Background Tasks (Memory & Extraction) 🔥 V2 Magic
    // ---------------------------------------------------------
    setImmediate(async () => {
        try {
            // A. Save Assistant Response to DB
            await supabase.from('chat_messages').insert({
                session_id: sessionId,
                user_id: userId,
                role: 'assistant', // mapped from 'model'
                content: parsedResponse.reply,
                metadata: { 
                    mood: parsedResponse.newMood, 
                    sources: usedSources 
                }
            });

            // B. Extract Text from Files (OCR/PDF Parsing)
            if (uploadedAttachments.length > 0 && savedUserMsg) {
                let extractedTextCombined = "";
                let updatedMeta = false;

                for (const att of uploadedAttachments) {
                    // Only extract for Docs/PDFs (Images handled by Vision AI already, but we can add OCR here if needed)
                    const isDoc = !att.mime.startsWith('image/') && !att.mime.startsWith('audio/');
                    
                    if (isDoc) {
                        const text = await extractTextFromCloudinaryUrl(att.url, att.mime);
                        if (text) {
                            extractedTextCombined += `\n--- Extracted Content (${att.mime}) ---\n${text}\n`;
                            updatedMeta = true;
                        }
                    }
                }

                if (updatedMeta) {
                    await supabase
                        .from('chat_messages')
                        .update({
                            metadata: { 
                                ...savedUserMsg.metadata,
                                extracted_text: extractedTextCombined 
                            }
                        })
                        .eq('id', savedUserMsg.id);
                    logger.info(`✅ Background: Text extracted for Session ${sessionId}`);
                }
            }

            // C. Update Session Summary & Mood
            if (parsedResponse.newMood) {
                await supabase.from('ai_memory_profiles').update({
                    emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason }
                }).eq('user_id', userId);
            }

        } catch (e) { 
            logger.error('❌ Background Task Error:', e); 
        }
    });

  } catch (err) {
    logger.error('🔥 ChatBrain Fatal:', err);
    return res.status(500).json({ reply: "نواجه مشكلة تقنية بسيطة، حاول مرة أخرى." });
  }
}

module.exports = { initChatBrainController, processChat };
