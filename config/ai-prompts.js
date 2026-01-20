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
*(Use this map to know what the user knows and what comes next. Do NOT try to update it.)*

**📖 REFERENCE CONTENT:**
${safeSnippet(lessonContentSnippet, 1500)}

**💬 USER MESSAGE:**
"${escapeForPrompt(message)}"

**📦 OUTPUT FORMAT (JSON ONLY):**
{
  "reply": "Your explanation here...",
  "widgets": []
}
`;
    }
  }
};

module.exports = PROMPTS;
