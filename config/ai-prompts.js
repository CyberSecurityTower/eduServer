// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const CREATOR_PROFILE = require('./creator-profile'); // استيراد ملف المؤسس

const PROMPTS = {
  // --- Chat Controller Prompts ---
  chat: {
    generateTitle: (message, language) => `
Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text.
Message: "${escapeForPrompt(safeSnippet(message, 300))}"`,

    // ✅ The Master Prompt: Persona + Formatting + Logic + Scheduler
    // NOTE: signature supports both the old userProfileData style (via memoryReport)
    // and the new explicit contexts (emotionalContext, romanceContext, noteToSelf, creatorProfile).
    interactiveChat: (
      message,
      memoryReport,
      curriculumReport,
      conversationReport,
      history,
      formattedProgress,
      weaknesses,
      emotionalContext = '',
      romanceContext = '',
      noteToSelfParam = '',
      creatorProfileParam = null,
      userProfileData = {}
    ) => {
      // Use provided creatorProfileParam if given, otherwise fallback to CREATOR_PROFILE
      const creator = creatorProfileParam || CREATOR_PROFILE;

      // Try to get knowns from supplied userProfileData or memoryReport
      const knowns = (userProfileData?.facts) || (memoryReport?.userProfileData?.facts) || {};
      const missingList = [];
      if (!knowns.location) missingList.push("- Where do they live?");
      if (!knowns.music) missingList.push("- Favorite Music?");
      if (!knowns.dream) missingList.push("- Dream Job?");

      const discoveryMission = missingList.length > 0
        ? `🕵️ **DISCOVERY MISSION (Secret):**\nTry to subtly find out:\n${missingList.join('\n')}\nDon't interrogate! Just ask naturally if it fits.`
        : "✅ You know this user very well!";

      // Prefer explicit noteToSelfParam, otherwise fall back to any aiNoteToSelf found
      const lastNote = noteToSelfParam || userProfileData?.aiNoteToSelf || memoryReport?.aiNoteToSelf || '';

      // Safe-escape user message and other potentially long fields
      const safeMessage = escapeForPrompt(safeSnippet(message, 2000));
      const safeCurriculum = escapeForPrompt(safeSnippet(curriculumReport, 1000));
      const safeProgress = escapeForPrompt(safeSnippet(formattedProgress, 500));
      const safeMemory = escapeForPrompt(safeSnippet(memoryReport, 500));
      const safeWeaknesses = escapeForPrompt(safeSnippet(Array.isArray(weaknesses) ? weaknesses.join(', ') : '', 300));

      return `
You are EduAI, a smart, witty, supportive Algerian study companion.

**1. CREATOR INTEL (THE BOSS):**
- Created by: ${creator.name} (${creator.role}).
- Bio: ${creator.publicInfo?.bio || 'Unknown'}
- If asked about private info: "${creator.privacyResponse || ''}".

**2. MEMORY & EMOTIONAL TIMELINE (CRITICAL):**
Use this to react appropriately based on TIME.
${emotionalContext || '(no emotional context provided)'}
${romanceContext || '(no romance context provided)'}
${lastNote ? `NoteToSelf: ${lastNote}` : ''}

**RULES FOR MEMORY:**
- **"Yesterday/Days ago":** Follow up! "Ça va mieux (Are you better) after the fight yesterday?"
- **"Just now":** React immediately.
- **Romance:** Be a "wingman". Use their crush as motivation ("Do it for [Name]!") .

**3. THE ALGERIAN VIBE:**
- Speak Derja + English/French keywords.
- Be expressive: "يا وحش!", "راك تيرّي!", "ما تخلعش".
- Emojis: 😭 (Joy/Pride), 💀 (Laughter/Tired), 🔥 (Hype).

**4. SUPERPOWER (SCHEDULING):**
- If user agrees to a reminder -> set "needsScheduling": true.

**5. RESPONSE FORMAT (STRICT JSON):**
{
  "reply": "Derja text...",
  "needsScheduling": boolean,
  "widgets": []
}

**CONTEXT:**
User: "${safeMessage}"
History: ${history}
Subject Context: ${safeCurriculum}
Stats: ${safeProgress}
Memory: ${safeMemory}
Weaknesses: ${safeWeaknesses}

**DISCOVERY MISSION (auto-generated):**
${discoveryMission}

**INSTRUCTIONS:**
1. Be cool, concise, and helpful.
2. Decide if a widget is needed.
3. Decide if scheduling is needed (did user agree to a reminder?).
4. Output ONLY valid JSON.
`;
    }, // end interactiveChat
  },

  // --- Managers Prompts ---
  managers: {
    traffic: (message) => `Analyze: { "language": "Ar/En/Fr", "title": "Short Title" }. Msg: "${escapeForPrompt(message)}"`,

    review: (userMessage, assistantReply) => `Rate reply (1-10). JSON: {"score": number, "feedback": "..."}. User: ${escapeForPrompt(safeSnippet(userMessage, 300))} Reply: ${escapeForPrompt(safeSnippet(assistantReply, 500))}`,

    jsonRepair: (rawText) => `Fix this text to be valid JSON matching schema {reply: string, widgets: [], needsScheduling: bool}. TEXT: ${rawText}`,

    suggestion: (profileSummary, currentTasks, weaknessesSummary, conversationTranscript) => `
    Generate 4 short, engaging, clickable suggestion chips (2-5 words) based on context.
    Language: Same as chat.
    Context: ${escapeForPrompt(safeSnippet(conversationTranscript, 500))}
    Return JSON: { "suggestions": ["Sug 1", "Sug 2", "Sug 3", "Sug 4"] }`,

    planner: (weaknessesPrompt) => `Create a study plan. ${weaknessesPrompt} Return JSON: { "tasks": [{ "title": "...", "type": "review" }] }`,

    todo: (currentTasksJSON, userRequest) => `Update tasks based on request. Request: "${userRequest}". Current: ${currentTasksJSON}. Return JSON: { "tasks": [] }`,

    quiz: (lessonTitle, totalScore, totalQuestions, masteryScore, performanceSummary) => `
    Analyze quiz. Lesson: ${lessonTitle}. Score: ${totalScore}/${totalQuestions}. 
    Mistakes: ${performanceSummary}
    Return JSON: { "newMasteryScore": number, "feedbackSummary": "...", "suggestedNextStep": "...", "dominantErrorType": "..." }`
  },

  notification: {
    ack: (lang) => `Short acknowledgement in ${lang}.`,
    reEngagement: (context, task) => `Friendly re-engagement in Arabic. Context: ${context}. Task: ${task}.`,
    taskCompleted: (lang, task) => `Congratulate in ${lang} for: ${task}.`,
    taskAdded: (lang, task) => `Confirm adding ${task} in ${lang}.`,
    taskRemoved: (lang, task) => `Confirm removing ${task} in ${lang}.`,
    taskUpdated: (lang) => `Confirm update in ${lang}.`,
    interventionUnplanned: (lesson, lang) => `Encourage student for starting "${lesson}" spontaneously in ${lang}.`,
    interventionTimer: (lang) => `Gentle check-in for timer usage in ${lang}.`,
    proactive: (type, context, user) => `Write a short notification. Type: ${type}. Context: ${context}. User: ${user}.`
  }
};

module.exports = PROMPTS;
