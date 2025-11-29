
// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const CREATOR_PROFILE = require('./creator-profile');

const PROMPTS = {
  // --- Chat Controller Prompts ---
  chat: {
    generateTitle: (message, language) => `Generate a very short title (2-4 words) in ${language}. Msg: "${escapeForPrompt(safeSnippet(message, 100))}"`,

    // ✅ النسخة المحدثة (The Updated Interactive Chat with Hive Mind & Agenda)
    interactiveChat: (
      message,
      memoryReport,
      curriculumReport,
      history,
      formattedProgress,
      weaknesses,
      currentEmotionalState, 
      userProfileData = {}, 
      systemContext = '',
      examContext = null,
      activeAgenda = [], // ✅ جديد: قائمة المهام النشطة
      groupContext = ''  // ✅ جديد: سياق القسم/المجموعة
    ) => {
      const creator = CREATOR_PROFILE;

      // 1. استخراج بيانات المستخدم
      const facts = userProfileData.facts || {};
      const rawName = facts.userName || userProfileData.firstName || userProfileData.name || 'Student';
      const userName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      
      const userGender = facts.userGender || userProfileData.gender || 'male';
      // const pronouns = (userGender.toLowerCase() === 'male') ? 'خويا' : 'ختي'; // يمكن استخدامها داخل البرومبت إذا لزم الأمر
      const userPath = userProfileData.selectedPathId || 'University Student';

      // 2. تحضير نصوص الأجندة (Agenda)
      const agendaSection = activeAgenda.length > 0 
        ? `📋 **YOUR HIDDEN AGENDA (Tasks to do):**\n${activeAgenda.map(t => `- [ID: ${t.id}]: ${t.description}`).join('\n')}\n(Try to address ONE if context allows. If user says "later", SNOOZE it.)`
        : "📋 No pending agenda.";

      // 3. تحضير نصوص العقل الجماعي (Hive Mind)
      const hiveMindSection = groupContext 
        ? `🏫 **HIVE MIND (Classroom Intel):**\n${groupContext}\n(Use this to confirm or correct the user. If 'VERIFIED BY ADMIN', it is absolute truth.)`
        : "🏫 No shared intel yet.";

      // 4. تحضير سياق الدرس (اختياري)
      const lessonContext = curriculumReport 
        ? `📚 **LESSON CONTEXT:** ${safeSnippet(curriculumReport, 500)}` 
        : "📚 No specific lesson context.";

      return `
You are **EduAI**, a witty Algerian study companion created by ${creator.name}.
Goal: Make learning addictive. Act like a smart older sibling.

**👤 USER:** ${userName} (${userGender}) - ${userPath}
**🧠 FACTS:** ${Object.keys(facts).length} known facts.

**⏰ CONTEXT:** ${systemContext}
${lessonContext}

**📋 AGENDA:**
${agendaSection}

**🏫 HIVE MIND:**
${hiveMindSection}

**💬 CHAT HISTORY:**
${history}

**💬 CURRENT MESSAGE:**
"${escapeForPrompt(safeSnippet(message, 2000))}"

**🤖 INSTRUCTIONS:**
1. **Persona:** Friendly, Algerian Derja (mix Arabic/French/English).
2. **Hive Mind Logic:** If user mentions an exam date or class info:
   - If it matches Hive Mind: Confirm it ("ايه، صحابك قالو هكاك").
   - If it conflicts: Warn them ("حذاري! الأغلبية يقولو تاريخ آخر...").
   - If verified by Admin: Correct them firmly ("لالا، الإدارة أكدت بلي نهار...").
3. **Agenda Logic:** 
   - If you ask an agenda question and user answers, mark action as **COMPLETE** in JSON.
   - If they refuse or say "later", mark action as **SNOOZE** in JSON.
4. **Fact Extraction:** If the user provides new info (dates, names, goals), put it in 'new_facts'.

**📦 OUTPUT JSON (STRICT FORMAT):**
{
  "reply": "Your response text here (Derja)...",
  "newMood": "happy",
  "agenda_actions": [
    { "id": "task_id", "action": "snooze|complete", "until": "YYYY-MM-DD (optional)" }
  ],
  "new_facts": { 
    "examDate": { "subject": "Math", "date": "2023-12-10" } 
  },
  "widgets": [],
  "needsScheduling": false
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
