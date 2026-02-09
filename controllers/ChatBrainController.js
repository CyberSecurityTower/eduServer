'use strict';

const axios = require('axios');
const cloudinary = require('../config/cloudinary');
const supabase = require('../services/data/supabase');
const generateWithFailover = require('../services/ai/failover');
const { markLessonComplete } = require('../services/engines/gatekeeper');
const PROMPTS = require('../config/ai-prompts'); 
const { getProfile } = require('../services/data/helpers');

// ============================================================
// 🛠️ Helper: Download File & Convert to Base64
// ============================================================
async function fetchFileAsBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
        console.error(`Failed to fetch file from history: ${url}`, error.message);
        return null; 
    }
}

// ============================================================
// 1. Fetch History (Strict Lesson Mode)
// ============================================================
async function getChatHistory(req, res) {
  const { userId, lessonId, cursor } = req.query; 
  console.log(`🔍 SERVER Fetching History for Lesson: ${lessonId}`);

  let contextId = lessonId;

  // Clean ID
  if (!contextId || contextId === 'undefined' || contextId === 'null') {
      contextId = 'general';
  }

  const limit = 20;

  try {
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', contextId) 
      .maybeSingle();

    if (!session) {
        return res.json({ messages: [], nextCursor: null });
    }

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data: messages } = await query;
    const nextCursor = messages && messages.length === limit ? messages[messages.length - 1].created_at : null;

    res.json({ messages: messages || [], nextCursor });
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
}

// ============================================================
// 2. Process Chat (Enhanced Lesson Context + Custom Instructions)
// ============================================================

async function processChat(req, res) {
  // ✅ 1. Destructure new fields: customInstruction, metadata
  let { userId, message, files = [], currentContext, webSearch, location, customInstruction, metadata } = req.body;
  
  // 1. Strict Context Definition
  const rawLessonId = currentContext?.lessonId || req.body.lessonId;
  let contextId = rawLessonId;

  if (contextId === 'undefined' || contextId === 'null' || !contextId) {
      console.warn("⚠️ Warning: No valid Lesson ID provided! Defaulting to 'general'.");
      contextId = 'general'; 
  }

  try {
    // ============================================================
    // 🧠 Smart Step: Parallel Fetch of Title and Content
    // ============================================================
    let lessonTitle = currentContext?.lessonTitle || "General Chat"; 
    let contentSnippet = ""; 

    if (contextId !== 'general') {
        console.log(`📚 Fetching DB Context for Lesson ID: ${contextId}`);
        
        const [lessonResult, contentResult] = await Promise.all([
            // 1. Get Title
            supabase.from('lessons').select('title').eq('id', contextId).maybeSingle(),
            // 2. Get Content
            supabase.from('lessons_content').select('content').eq('lesson_id', contextId).maybeSingle()
        ]);

        if (lessonResult.data?.title) {
            lessonTitle = lessonResult.data.title;
            console.log(`✅ Lesson Title Found: "${lessonTitle}"`);
        }

        if (contentResult.data?.content) {
            contentSnippet = contentResult.data.content.substring(0, 20000);
            console.log(`✅ Lesson Content Loaded (${contentSnippet.length} chars)`);
        } else {
            console.warn(`⚠️ No content found for lesson: ${contextId}`);
        }
    }

    // 2. Find or Create Session
    let sessionId;
    const { data: existingSession } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('context_id', contextId)
        .maybeSingle();

    if (existingSession) {
        sessionId = existingSession.id;
        await supabase.from('chat_sessions').update({ updated_at: new Date() }).eq('id', sessionId);
    } else {
        console.log(`✨ Creating NEW session based on DB Title: ${lessonTitle}`);
        const { data: newSession } = await supabase.from('chat_sessions').insert({
            user_id: userId,
            context_id: contextId,
            context_type: contextId === 'general' ? 'general' : 'lesson',
            summary: lessonTitle 
        }).select().single();
        sessionId = newSession.id;
    }

    // 3. Process Uploaded Files
    const geminiAttachments = []; 
    const dbAttachments = [];     

    if (files && files.length > 0) {
        for (const file of files) {
            try {
                const base64Data = file.data.replace(/^data:.+;base64,/, '');
                geminiAttachments.push({ inlineData: { data: base64Data, mimeType: file.mime } });

                let uploadOptions = { resource_type: "auto", folder: `chat_uploads/${userId}` };
                if (file.mime === 'application/pdf') uploadOptions.format = 'pdf'; 
                if (file.mime.startsWith('audio')) uploadOptions.resource_type = "video"; 

                const uploadRes = await cloudinary.uploader.upload(`data:${file.mime};base64,${base64Data}`, uploadOptions);
                dbAttachments.push({
                    url: uploadRes.secure_url,
                    public_id: uploadRes.public_id,
                    mime: file.mime,
                    type: file.mime.startsWith('image') ? 'image' : (file.mime.startsWith('audio') ? 'audio' : 'file')
                });
            } catch (e) { console.error('File Processing Error:', e.message); }
        }
    }

    // 4. Build Live Vision Memory
    const { data: historyData } = await supabase
        .from('chat_messages')
        .select('role, content, attachments')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(10); 
    
    const orderedHistory = (historyData || []).reverse();

    const history = await Promise.all(orderedHistory.map(async (msg) => {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            const attachmentParts = await Promise.all(msg.attachments.map(async (att) => {
                if (att.url) {
                    const base64 = await fetchFileAsBase64(att.url);
                    if (base64) return { inlineData: { data: base64, mimeType: att.mime || 'image/jpeg' } };
                }
                return null;
            }));
            attachmentParts.filter(p => p !== null).forEach(p => parts.push(p));
        }
        if (parts.length === 0) parts.push({ text: " " });
        return { role: msg.role === 'user' ? 'user' : 'model', parts: parts };
    }));

    // ✅ 5. Save User Message (With merged Metadata)
    // We merge the system contextId with any incoming client metadata
    const finalMetadata = { context: contextId, ...(metadata || {}) };

    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId, 
        role: 'user', 
        content: message,
        attachments: dbAttachments, 
        metadata: finalMetadata // ✅ Updated
    });

    // 6. AI Generation
    const userProfile = await getProfile(userId);
    const locationContext = location || "Algeria"; 

    const personaPrompt = PROMPTS.chat.interactiveChat(
        message, 
        userProfile, 
        locationContext, 
        lessonTitle,     
        contentSnippet   
    );

    // ✅ 7. Handle Custom Instructions (Inject into System Prompt)
    let dynamicInstructions = "";
    if (customInstruction) {
        dynamicInstructions = `
        IMPORTANT CONTEXT FROM USER INTERACTION:
        ${customInstruction}
        (Please take this context into account while answering the user's message).
        `;
    }

    const finalSystemPrompt = `
    ${personaPrompt}

    ${dynamicInstructions}

    🛑 **INSTRUCTIONS:**
    1. You are specifically tutoring the lesson: "${lessonTitle}".
    2. Answer strictly based on the provided content snippet if applicable.
    3. You have vision access to the last 10 messages (Images/PDFs).
    4. Answer in **Algerian Derja**.
    
    **OUTPUT JSON:** { "reply": "...", "widgets": [], "lesson_signal": ... }
    `;

    console.log(`🚀 Sending to AI (Context: ${contextId}, History: ${history.length})...`);

    const aiResult = await generateWithFailover('chat', message || "Analyze attached file", {
        systemInstruction: { parts: [{ text: finalSystemPrompt }] },
        history: history,
        attachments: geminiAttachments,
        enableSearch: !!webSearch,
        label: 'ChatBrain_FullVision'
    });

    // 8. Process Response
    let parsedResponse;
    try {
        const cleanText = (typeof aiResult === 'object' ? aiResult.text : aiResult)
                          .replace(/```json/g, '').replace(/```/g, '').trim();
        parsedResponse = JSON.parse(cleanText);
    } catch (e) {
        parsedResponse = { reply: typeof aiResult === 'object' ? aiResult.text : aiResult, widgets: [] };
    }

    // 9. Gatekeeper & Widgets
    let finalWidgets = parsedResponse.widgets || [];
    const targetLessonId = (contextId !== 'general') ? contextId : null;
    
    if (parsedResponse.lesson_signal?.type === 'complete' && targetLessonId) {
        const gateResult = await markLessonComplete(userId, targetLessonId, parsedResponse.lesson_signal.score || 100);
        if (gateResult.reward?.coins_added > 0) {
            finalWidgets.push({ 
                type: 'celebration', 
                data: { message: `صحيت! +${gateResult.reward.coins_added} كوين`, coins: gateResult.reward.coins_added } 
            });
        }
    }

    // 10. Save Assistant Response
    await supabase.from('chat_messages').insert({
        session_id: sessionId,
        user_id: userId, 
        role: 'assistant', 
        content: parsedResponse.reply,
        metadata: { widgets: parsedResponse.widgets || [] }
    });

    res.status(200).json({
        reply: parsedResponse.reply,
        widgets: finalWidgets,
        sessionId: sessionId
    });

  } catch (err) {
    console.error('🔥 ChatBrain Error:', err);
    res.status(500).json({ reply: "صرا مشكل تقني، عاود المحاولة." });
  }
}

function initChatBrainController(dependencies) {
    console.log('🧠 ChatBrainController initialized (FULL VISION MODE).');
}

async function clearLessonHistory(req, res) {
  const { userId } = req.user;
  const { lessonId } = req.params;

  try {
    // 1. العثور على الجلسة المرتبطة بالدرس والمستخدم
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('context_id', lessonId)
      .maybeSingle();

    if (!session) {
      return res.json({ success: true, message: "No session found to clear." });
    }

    // 2. حذف جميع الرسائل في هذه الجلسة
    const { error } = await supabase
      .from('chat_messages')
      .delete()
      .eq('session_id', session.id);

    if (error) throw error;

    res.json({ success: true, message: "History cleared successfully." });
  } catch (error) {
    console.error("Error clearing history:", error);
    res.status(500).json({ error: "Failed to clear history" });
  }
}

// أضفها للمصدّرات
module.exports = { processChat, getChatHistory, clearLessonHistory, initChatBrainController };
