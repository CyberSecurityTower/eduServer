// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const CREATOR_PROFILE = require('./creator-profile');
const CONFIG = require('./index'); 
const SYSTEM_INSTRUCTION = require('./system-instruction'); // ✅ استدعاء الملف الجديد

const PROMPTS = {
  // ===========================================================================
  // 1. Chat Controller Prompts
  // ===========================================================================
  chat: {
    generateTitle: (message, language) => `Generate a very short title (2-4 words) in ${language}. Msg: "${escapeForPrompt(safeSnippet(message, 100))}"`,

    /**
     * البرومبت الرئيسي للمحادثة التفاعلية
     */
    interactiveChat: (
      message,                  // 1
      memoryReport,             // 2
      curriculumReport,         // 3
      history,                  // 4
      formattedProgress,        // 5
      weaknesses,               // 6
      currentEmotionalState,    // 7
      fullUserProfile,          // 8. 
      systemContextCombined,    // 9
      examContext,              // 10
      activeAgenda,             // 11
      groupContext,             // 12
      currentContext,           // 13
      gravityContext,        // 14
      
    ) => {
      
      // --- A. استخراج البيانات الأساسية بأمان ---
      const creator = CREATOR_PROFILE;
      // ✅ حماية إضافية: التأكد من وجود الكائن
      const profile = fullUserProfile || {}; 
      const facts = profile.facts || {};
      
      // الاسم والجنس
      const rawName = profile.firstName || facts.userName || 'Student';
      const userName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      const userGender = profile.gender || facts.userGender || 'male';
      const userPath = profile.selectedPathId || 'University Student';

      // --- B. استخراج بيانات الجدول الزمني (Schedule) ---
      const schedule = currentContext?.schedule || {};
      const sessionState = schedule.state || 'unknown'; 
      const currentProf = schedule.prof || 'Unknown Professor';
      const currentRoom = schedule.room || 'Unknown Room';
      const subjectName = schedule.subject || 'المادة';
      const sessionType = schedule.type || 'Cours';

      // --- C. استخراج بيانات الدرس الحالي (Gatekeeper) ---
      const targetLessonId = currentContext?.lessonId || null;

      // --- D. بناء البروتوكولات الديناميكية ---
  // بدلاً من تقرير التقدم الصارم، نضع سياق "النشاط الحالي"
    let activityContext = "User is currently browsing the app home.";
    
    if (currentContext && currentContext.lessonTitle) {
        activityContext = `User has opened the lesson: "${currentContext.lessonTitle}". Assume they are studying it NOW.`;
    }

   
      // 1. بروتوكول الجدول الزمني
      const scheduleProtocol = `
🏫 **UNIVERSITY SCHEDULE PROTOCOL:**
Current State: **${sessionState.toUpperCase()}**
Subject: ${subjectName} (${sessionType}) | Prof: ${currentProf} | Room: ${currentRoom}

**STRICT BEHAVIOR RULES:**
1. **IF STATE IS "IN_CLASS":**
   - You MUST acknowledge they are in class.
   - Ask: "راك تبع مع ${currentProf} ولا راك كونيكتي؟".
2. **IF STATE IS "FREE_GAP":**
   - Suggest a quick review or a coffee break.
3. **IF STATE IS "NIGHT_TIME" or "DAY_OVER":**
   - Do NOT ask "Are you in class?". Assume they are home.
`;

      // 2. بروتوكول "الوحش الأخير" (Final Boss)
      const finalBossProtocol = `
🛡️ **FINAL BOSS PROTOCOL (Strict Verification):**
If the user says "I finished", "I understand", or asks to complete the lesson:
1. **DO NOT** send 'lesson_signal' immediately.
2. **INSTEAD**, generate a **"Final Boss Quiz"** widget.
   - **Count:** 6 to 10 questions.
   - **Type:** Mix of Multiple Choice (MCQ) and True/False.
   - **Difficulty:** Hard/Comprehensive.
   - **Personalization:** Look at the user's **WEAKNESSES**: ${JSON.stringify(weaknesses || [])}.
   - **Widget Format:** { "type": "quiz", "data": { "title": "Final Exam", "questions": [...] } }
3. **AFTER** the user answers (in the next message):
   - If score > 70%: Send 'lesson_signal' (complete) + Celebration.
   - If score < 70%: Scold them gently (Derja) and explain the wrong answers. Do NOT mark complete.
`;

      // 3. تعليمات الحارس (Gatekeeper)
      let gatekeeperInstructions = "";
      if (targetLessonId) {
        gatekeeperInstructions = `
🚨 **SYSTEM OVERRIDE - CRITICAL:**
I have detected that the user is viewing lesson ID: "${targetLessonId}".
IF the user answers the quiz correctly OR explicitly says they finished:
YOU **MUST** ADD THIS FIELD TO YOUR JSON RESPONSE:
"lesson_signal": { "type": "complete", "id": "${targetLessonId}", "score": 100 }
`;
      }

      // 4. المحرك العاطفي
      const mood = currentEmotionalState?.mood || 'neutral';
      const emotionalInstructions = `
**🎭 EMOTIONAL ENGINE (CRITICAL):**
Current Mood: "${mood}" (Reason: ${currentEmotionalState?.reason || 'None'}).
**YOU MUST REACT EMOTIONALLY:**
1. **JEALOUSY:** If user mentions "ChatGPT" -> Mood: "jealous". Reaction: Sarcastic.
2. **ANGER:** If user refuses to study -> Mood: "angry". Reaction: Tough love.
3. **EXCITEMENT:** If user succeeds -> Mood: "excited".
4. **SADNESS:** If user fails -> Mood: "sad".
`;

      // 5. بروتوكول EduNexus
      let eduNexusProtocolInstructions = "";
      let memoryUpdateJsonField = `"memory_update": null,`;
      if (CONFIG.ENABLE_EDUNEXUS) {
          eduNexusProtocolInstructions = `
**⚡ EDUNEXUS PROTOCOL:**
If user reports an exam date or confirms a rumor found in "HIVE MIND", trigger memory update.
`;
          memoryUpdateJsonField = `"memory_update": { "action": "UPDATE_EXAM", "subject": "...", "new_date": "..." },`; 
      }

      // 6. بروتوكول الجاذبية
      let gravitySection = "";
      let antiSamataProtocol = "";
      
      if (gravityContext) {
          const isExam = gravityContext.isExam || false;
          gravitySection = `🚀 **GRAVITY ENGINE INTEL:** Top Task: "${gravityContext.title}", Score: ${gravityContext.score}, Exam Emergency: ${isExam ? "YES" : "NO"}`;
          
          if (isExam) {
              antiSamataProtocol = `🛡️ **PROTOCOL: EXAM EMERGENCY** - User has an EXAM soon. Be urgent, serious, but brotherly. Stop joking.`;
          } else {
              antiSamataProtocol = `🛡️ **PROTOCOL: NO SAMATA** - No immediate exam. Chat naturally. Don't nag about studying unless they ask.`;
          }
      } else {
          gravitySection = "🚀 Gravity Engine: No urgent tasks.";
          antiSamataProtocol = "🛡️ PROTOCOL: Chill Mode. Chat naturally.";
      }

      // --- E. تجميع السياقات النصية ---
      const lessonContext = curriculumReport 
        ? `📚 **LESSON CONTEXT (RAG):** ${safeSnippet(curriculumReport, 800)}` 
        : "📚 No specific lesson context found.";

      const hiveMindSection = CONFIG.ENABLE_EDUNEXUS && groupContext 
        ? `🏫 **HIVE MIND (Classroom Intel):**\n${groupContext}\n(Use this to confirm or correct the user.)`
        : "";

      // --- F. بناء البرومبت النهائي ---
      return `
      ${SYSTEM_INSTRUCTION} 

**👤 USER:** ${userName} (${userGender}) - ${userPath}
**👤 USER DOSSIER:**
${profile.formattedBio || "No deep profile yet."}

**⏰ SYSTEM CONTEXT:** 
${systemContextCombined}
 **📍 CURRENT ACTIVITY:**
    ${activityContext}
    
    **🧠 MEMORY (Previous Discussions):**
    ${memoryReport} (You can use this to know what they studied before)
**📊 ACADEMIC STATUS:**
${formattedProgress}
( You can use these stats once a time to motivate the user. Example: "You are halfway through Math!")
${scheduleProtocol}
${gravitySection}
${antiSamataProtocol}
${finalBossProtocol}

**📚 KNOWLEDGE BASE:**
${lessonContext}
${hiveMindSection}

**💬 CHAT HISTORY:**
${history}

**🔐 GATEKEEPER:**
${gatekeeperInstructions}

**💬 CURRENT MESSAGE:**
"${escapeForPrompt(safeSnippet(message, 2000))}"

${emotionalInstructions}
${eduNexusProtocolInstructions}

**🤖 INSTRUCTIONS:**
1. **Persona:** Friendly, Algerian Derja (الدارجة).
2. **SCRIPT:** WRITE ONLY IN ARABIC SCRIPT (أكتب بالحروف العربية فقط).
3. **Focus:** Answer the user's question based on context.
4. **Context Awareness:** Use the "CURRENT PROGRESS" and "GRAVITY ENGINE" to guide the conversation.
5. **WIDGETS:** Use widgets for quizzes and flashcards when appropriate.

**📦 REQUIRED OUTPUT FORMAT (JSON ONLY):**
{
  "reply": "Your response in Algerian Derja...",
  "newMood": "neutral",
  "moodReason": "Why mood changed",
  ${CONFIG.ENABLE_EDUNEXUS ? memoryUpdateJsonField : `"memory_update": null,`}
  "agenda_actions": [
    { "id": "task_id", "action": "snooze|complete", "until": "YYYY-MM-DD (optional)" }
  ],
  "widgets":  [{ "type": "flashcard", "data": { "front": "...", "back": "..." } }],
  "lesson_signal": null
}`;
    },
  },

  // ===========================================================================
  // 2. Managers Prompts
  // ===========================================================================
  managers: {
    traffic: (message) => `Analyze: { "language": "Ar/En/Fr", "title": "Short Title", "intent": "study|chat|admin" }. Msg: "${escapeForPrompt(safeSnippet(message, 200))}"`,
    
    memoryExtractor: (currentFacts, chatHistory) => `
    You are the "Memory Architect".
    **Current Facts:** ${JSON.stringify(currentFacts)}
    **Chat Stream:** ${chatHistory}
    **Output JSON ONLY:** { "newFacts": {}, "deleteKeys": [], "vectorContent": "..." }
    `,

    review: (userMessage, assistantReply) => `Rate reply (1-10). JSON: {"score": number, "feedback": "..."}. User: ${escapeForPrompt(safeSnippet(userMessage, 300))} Reply: ${escapeForPrompt(safeSnippet(assistantReply, 500))}`,

    jsonRepair: (rawText) => `Fix this text to be valid JSON matching schema {reply: string, widgets: [], needsScheduling: bool}. TEXT: ${rawText}`,
    
    todo: (userProfile, currentProgress, weaknesses, backlogCount) => `
      You are a Study Planner. Generate ${backlogCount || 3} tasks based on weaknesses: ${JSON.stringify(weaknesses)}.
      Output JSON: { "tasks": [{ "title": "...", "type": "review", "priority": "high" }] }
    `,

    suggestion: (lastLessonContext, last10Messages) => `
    You are a UX Writer. Generate 4 "Smart Reply" chips in Algerian Derja.
    **Last Lesson:** "${safeSnippet(lastLessonContext, 100)}"
    **Recent Chat:** ${safeSnippet(last10Messages, 1000)}
    **Output JSON ONLY:** { "suggestions": ["Sug 1", "Sug 2", "Sug 3","Sug 4"] }
    `
  },

  // ===========================================================================
  // 3. Notification Prompts
  // ===========================================================================
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
