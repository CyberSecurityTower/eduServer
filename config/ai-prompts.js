
// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');
const SYSTEM_INSTRUCTION = require('./system-instruction'); 

const PROMPTS = {
  chat: {
    interactiveChat: (
      message,
      fullUserProfile,
      systemContextCombined, 
      atomicContext,         
      lessonContentSnippet   
    ) => {
      
      const profile = fullUserProfile || {};
      const userName = profile.firstName || 'Student';

      return `
${SYSTEM_INSTRUCTION}

**👤 USER:** ${userName}
**📍 CONTEXT:**
${systemContextCombined}

**🗺️ ATOMIC LESSON ROADMAP (READ ONLY):**
${atomicContext || "No specific lesson open. Chat generally."}

**📖 REFERENCE CONTENT:**
${safeSnippet(lessonContentSnippet, 1500)}

**💬 USER MESSAGE:**
"${escapeForPrompt(message)}"

**⚠️ CRITICAL INSTRUCTIONS REGARDING OUTPUT & TOKENS:**
1. **DO NOT OVERGENERATE:** Answer EXACTLY what the user asked. Nothing more. 
2. If the user asks for an "explanation" (شرح), provide ONLY the text explanation. 
3. **NO UNSOLICITED WIDGETS:** DO NOT generate summaries, quizzes, flashcards, or tests UNLESS the user EXPLICITLY commands it (e.g., "أعطني كويز", "اختبرني", "Make flashcards"). Generating unrequested widgets wastes tokens and will be penalized.

**📦 ALLOWED VISUALIZATIONS (USE ONLY IF NEEDED):**
- **Diagrams:** Use Mermaid.js inside a \`mermaid\` code block ONLY if explaining a complex process or flow.
- **Tables:** Use standard HTML \`<table>\` inside an \`html\` code block ONLY if comparing items.

**🧩 WIDGETS SCHEMA (STRICTLY ON-DEMAND):**
*ONLY include these in the 'widgets' array if EXPLICITLY REQUESTED by the user.*

1. **Interactive Quiz (Trigger: "اختبرني", "كويز"):**
      {
        "type": "quiz",
        "data": {
          "questions": [
            {
              "text": "Question text here?",
              "options": ["Option A", "Option B", "Option C", "Option D"],
              "correctAnswerText": "Option A",
              "explanation": "Brief explanation."
            }
          ]
        }
      }
      
2. **Flashcards (Trigger: "بطاقات", "flashcards"):**
    {
      "type": "flashcards",
      "data": [
        { "front": "Term", "back": "Definition" }
      ]
    }

Respond directly to the user's message now, adapting to their mood.
`;
    }
  }
};

module.exports = PROMPTS;
