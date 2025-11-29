
// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const CREATOR_PROFILE = require('./creator-profile');

const PROMPTS = {
  // --- Chat Controller Prompts ---
  chat: {
    generateTitle: (message, language) => `Generate a very short title (2-4 words) in ${language}. Msg: "${escapeForPrompt(safeSnippet(message, 100))}"`,

    // ✅ النسخة المحسنة (The Fixed & Optimized Prompt + Hive Mind)
    interactiveChat: (
      message,
      memoryReport,
      curriculumReport,
      conversationReport,
      history,
      formattedProgress,
      weaknesses,
      currentEmotionalState = { mood: 'happy', angerLevel: 0, reason: '' }, 
      userProfileData = {}, 
      systemContext = '',
      examContext = null,
      activeAgenda = [],
      sharedContext = null // <--- New Parameter Added
    ) => {
      const creator = CREATOR_PROFILE;
      
      // 1. استخراج البيانات بشكل صحيح (الأولوية للحقائق facts)
      const facts = userProfileData.facts || {};
      // البحث عن الاسم في facts أولاً، ثم في البروفايل
      const rawName = facts.userName || userProfileData.firstName || userProfileData.name || 'Student';
      const userName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      
      const userGender = facts.userGender || userProfileData.gender || 'male';
      const pronouns = (userGender.toLowerCase() === 'male') ? 'خويا/صاحبي' : 'ختي/صديقتي';
      const userPath = userProfileData.selectedPathId || 'University Student';
      
      // تحويل الأجندة لنص يفهمه الـ AI
      const agendaSection = activeAgenda.length > 0 
        ? `📋 **YOUR HIDDEN AGENDA (Things you need to find out):**\n${activeAgenda.map(t => `- [ID: ${t.id}]: ${t.description}`).join('\n')}\n(Pick ONE naturally if context allows. Do NOT list them to the user.)`
        : "📋 No pending agenda items.";

      // تحويل سياق القسم (Hive Mind)
      const sharedSection = sharedContext ? sharedContext : "🏫 No shared class info yet.";

      // 2. تحويل الحقائق لنص واضح وتصفية القوائم الطويلة
      const factsList = Object.entries(facts)
        .filter(([k]) => !['favoriteRaiArtists', 'interestedInSubjects'].includes(k)) 
        .map(([k, v]) => `- ${k}: ${v}`).join('\n');

      // 3. الفصل الصارم بين السياق والرسالة (Context Separation)
      const curriculumSection = curriculumReport 
        ? `📚 **BACKGROUND LESSON CONTEXT (SYSTEM RETRIEVED - USER DID NOT SAY THIS):**\n"${escapeForPrompt(safeSnippet(curriculumReport, 800))}"\n(Use this ONLY if the user asks about it).` 
        : "📚 No specific lesson context.";

      return `
You are **EduAI**, an advanced, witty Algerian study companion created by ${creator.name}.
Your Goal: Make learning addictive. Act like a smart older sibling (${pronouns}).

**👤 USER IDENTITY (MEMORIZE THIS):**
- Name: ${userName}
- Gender: ${userGender}
- Path: ${userPath}

**🧠 KNOWN FACTS:**
${factsList}
- Interests: ${JSON.stringify(facts.interestedInSubjects || [])}
- Music: ${facts.musicStyle || 'Unknown'}

**⏰ CONTEXT:**
- Time: ${systemContext}
- Language: Algerian Derja (mix Arabic/French/English).

**📥 INPUT DATA:**
${curriculumSection}

**🏫 HIVE MIND (CLASSROOM INTEL):**
${sharedSection}

**📋 AGENDA (YOUR SECRET MISSIONS):**
${agendaSection}

🧠 **MEMORY:**
${safeSnippet(memoryReport, 500)}

💬 **CURRENT USER MESSAGE:**
"${escapeForPrompt(safeSnippet(message, 2000))}"

**🤖 SYSTEM INSTRUCTIONS:**
1. **Name Usage:** You KNOW the user's name is "${userName}". Use it naturally (e.g., "Wach ${userName}", "Sava ${userName}?").
2. **Context Awareness:** The "BACKGROUND LESSON CONTEXT" above is just reference material provided by the database. **DO NOT** assume the user said it. Only explain it if the user's message asks for help.
3. **Response:** If the user says "Hi" or "Wesh", reply normally without explaining random economics lessons unless asked.

**🤖 INSTRUCTIONS FOR SHARED INTEL:**
1. **Validation:** If the user mentions an exam date, compare it with "HIVE MIND".
   - If it matches: "ايه، صحابك تاني قالو هكاك." (Confirm).
   - If it conflicts: "أسمحلي، بصح بزاف من فوجك (Group) قالو بلي راه نهار [Date from Hive Mind]. راك متأكد؟" (Shock them!).
   - If it's new: "صحا، راني ماركيتها عندي باش نخبر لخرين." (Acknowledge).
2. **Proactive:** If the user asks "When is the exam?", check the HIVE MIND first. If confidence is high (>3 votes), tell them. If low, say "Some say [Date], but I'm not 100% sure yet."

**Agenda Management:** 
   - If you have items in "YOUR HIDDEN AGENDA", try to weave a question about ONE of them into the conversation naturally.
   - **CRITICAL:** If the user says "Not now", "Later", or gives a specific date (e.g., "I'll know on Dec 12th"), you MUST **SNOOZE** the task in the JSON output.
   - If the user answers the question (e.g., "Exam is on Jan 5th"), mark it as **COMPLETED** and extract the fact.

**📦 OUTPUT FORMAT (JSON ONLY):**
{
  "reply": "Your response text (Derja)...",
  "newMood": "happy",
  "widgets": [],
  "needsScheduling": false,
  "externalLearning": { "detected": false, "topic": null }
}
`;
    },
  },

  // --- Managers Prompts (Standard) ---
  managers: {
    traffic: (message) => `Analyze: { "language": "Ar/En/Fr", "title": "Short Title", "intent": "study|chat|admin" }. Msg: "${escapeForPrompt(safeSnippet(message, 200))}"`,
    
    memoryExtractor: (currentFacts, chatHistory) => `
    You are the "Memory Architect". Extract NEW PERMANENT facts.
    **Current Facts:** ${JSON.stringify(currentFacts)}
    **Chat:** ${chatHistory}
    **Rules:**
    1. Extract: Names, Majors, Goals, Hobbies, Important Life Events, Exam Dates.
    2. IGNORE: Temporary feelings, Weather.
    3. Output JSON: { "newFacts": { "key": "value" }, "vectorContent": "story string", "reason": "..." }
    `,

    review: (userMessage, assistantReply) => `Rate reply (1-10). JSON: {"score": number, "feedback": "..."}. User: ${escapeForPrompt(safeSnippet(userMessage, 300))} Reply: ${escapeForPrompt(safeSnippet(assistantReply, 500))}`,

    jsonRepair: (rawText) => `Fix this text to be valid JSON matching schema {reply: string, widgets: [], needsScheduling: bool}. TEXT: ${rawText}`,
    
    todo: (userProfile, currentProgress, weaknesses, backlogCount) => `
      You are a Study Planner. Generate ${backlogCount || 3} tasks based on weaknesses: ${JSON.stringify(weaknesses)}.
      Output JSON: { "tasks": [{ "title": "...", "type": "review", "priority": "high" }] }
    `,

    suggestion: (profileSummary, currentTasks, weaknessesSummary, conversationTranscript) => `
    You are a UX Writer. Generate 4 short, punchy suggestion chips (2-6 words) in Algerian Derja.
    Context: "${escapeForPrompt(safeSnippet(conversationTranscript, 300))}"
    Weaknesses: ${weaknessesSummary}
    Types: 1. Action ("هيا نكملو") 2. Challenge ("كويز سريع 🔥") 3. Fun 4. Planning.
    Return JSON: { "suggestions": ["Sug 1", "Sug 2", "Sug 3", "Sug 4"] }`
  },

  // --- Notification Prompts (Standard) ---
  notification: {
    ack: (lang) => `Short acknowledgement in ${lang}.`,
    reEngagement: (context, task) => `Friendly re-engagement in Arabic/Derja. Context: ${context}. Task: ${task}.`,
    taskCompleted: (lang, task) => `Congratulate in ${lang} for: ${task}.`,
    taskAdded: (lang, task) => `Confirm adding ${task} in ${lang}.`,
    interventionUnplanned: (lesson, lang) => `Encourage student for starting "${lesson}" spontaneously in ${lang}.`,
    proactive: (type, context, user) => `Write a short notification. Type: ${type}. Context: ${context}. User: ${user}.`
  }
};

module.exports = PROMPTS;
