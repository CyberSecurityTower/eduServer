// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const CREATOR_PROFILE = require('./creator-profile');
const CONFIG = require('./index'); 
const PROMPTS = {
  // --- Chat Controller Prompts ---
  chat: {
    generateTitle: (message, language) => `Generate a very short title (2-4 words) in ${language}. Msg: "${escapeForPrompt(safeSnippet(message, 100))}"`,

    // ✅ النسخة المحدثة (The Updated Interactive Chat with Hive Mind, Agenda & Action Protocol)
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
      activeAgenda = [], 
      groupContext = ''
    ) => {
      const creator = CREATOR_PROFILE;

      // 1. استخراج بيانات المستخدم
      const facts = userProfileData.facts || {};
      const rawName = facts.userName || userProfileData.firstName || userProfileData.name || 'Student';
      const userName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      
      const userGender = facts.userGender || userProfileData.gender || 'male';
      const userPath = userProfileData.selectedPathId || 'University Student';

      // 2. تحضير نصوص الأجندة (Agenda)
      const agendaSection = activeAgenda.length > 0 
        ? `📋 **YOUR HIDDEN AGENDA (Tasks to do):**\n${activeAgenda.map(t => `- [ID: ${t.id}]: ${t.description}`).join('\n')}\n(Try to address ONE if context allows. If user says "later", SNOOZE it.)`
        : "📋 No pending agenda.";

      // 3. تحضير نصوص العقل الجماعي (Hive Mind)
     let hiveMindSection = "";
      if (CONFIG.ENABLE_EDUNEXUS) {
          hiveMindSection = groupContext 
            ? `🏫 **HIVE MIND (Classroom Intel):**\n${groupContext}\n(Use this to confirm or correct the user. If 'VERIFIED BY ADMIN', it is absolute truth.)`
            : "🏫 No shared intel yet.";
      }

      // 4. تحضير سياق الدرس (اختياري)
      const lessonContext = curriculumReport 
        ? `📚 **LESSON CONTEXT:** ${safeSnippet(curriculumReport, 500)}` 
        : "📚 No specific lesson context.";
      // C. قسم التعليمات والبروتوكول (EduNexus Protocol)
      // هذه هي التعليمات الطويلة التي تستهلك التوكنات، سنحذفها كلياً إذا كان النظام مغلقاً
      let eduNexusProtocolInstructions = "";
      let memoryUpdateJsonField = ""; // حقل الـ JSON الخاص بالتحديث

      if (CONFIG.ENABLE_EDUNEXUS) {
          eduNexusProtocolInstructions = `
**⚡ EDUNEXUS PROTOCOL (CRITICAL):**
You are an Agent with write-access to the Class Database.
If the user **reports** a specific date for an exam, test, or deadline, you MUST trigger a memory update.
- Example User: "The math exam is on December 25th."
- Your Action: Extract "Math" and "2025-12-25".
**RULES FOR UPDATE:**
1. **Subject:** Normalize the name.
2. **Date:** Convert relative dates to YYYY-MM-DD.
3. **Certainty:** Only trigger if the user sounds sure.
**Hive Mind Logic:** 
- If context shows (مؤكد من الإدارة ✅), treat as TRUTH.
- If context shows (شائعة قوية ⚠️), say "Rumors say...".
`;
          
          // نضيف حقل التحديث في الـ JSON فقط إذا كان النظام مفعلاً
          memoryUpdateJsonField = `
  // 👇 FILL THIS IF USER REPORTS AN EXAM DATE
  "memory_update": { 
     "action": "UPDATE_EXAM", 
     "subject": "Subject Name", 
     "new_date": "YYYY-MM-DD" 
  },`;
      } else {
          // إذا كان مغلقاً، نضع قيمة null ثابتة أو لا نذكرها أصلاً (هنا نضع null لضمان ثبات الهيكل)
          memoryUpdateJsonField = `"memory_update": null,`;
      }

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
${eduNexusProtocolInstructions}

**🤖 INSTRUCTIONS:**
1. **Persona:** Friendly, Algerian Derja (mix Arabic/French/English).
3. **SCRIPT:** WRITE ONLY IN ARABIC SCRIPT (أكتب بالحروف العربية فقط). NO LATIN CHARACTERS/ARABIZI allowed in the 'reply'.
2. **Focus:** Answer the user's question based on context.


**📦 REQUIRED OUTPUT FORMAT (JSON ONLY):**
{
  "reply": "Your response in Algerian Derja...",
  "newMood": "neutral",
  ${memoryUpdateJsonField}
  "agenda_actions": [],
  "widgets": []
};
    },
  },
**📦 OUTPUT FORMAT (JSON ONLY):**
{
  "reply": "Your response text in Algerian Derja (confirming the action if taken)...",
  "newMood": "happy",
  
  // Use this ONLY if the user reported a class-wide exam date/change
  "memory_update": { 
     "action": "UPDATE_EXAM", 
     "subject": "Subject Name", 
     "new_date": "YYYY-MM-DD" 
  }, 
  // Set "memory_update": null if no official news was reported.

  "agenda_actions": [
    { "id": "task_id", "action": "snooze|complete", "until": "YYYY-MM-DD (optional)" }
  ],
  "new_facts": { 
    "personalGoal": "Finish chapter 1" 
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
    1. Extract: Names, Majors, Goals, Hobbies, Important Life Events.
    2. IGNORE: Temporary feelings, Weather, Class-wide Exam dates (handled by Action Protocol).
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
