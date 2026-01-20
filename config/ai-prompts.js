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

      // NOTICE: All internal backticks below have been escaped with a backslash (\)
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


**📦 OUTPUT FORMAT:**
1. **Speak Naturally:** Write your reply in plain text (Arabic/Derja) directly. Do NOT wrap your text in JSON.
2. **Add Widgets (Optional):** If (and ONLY if) you need to show a widget (Quiz, Flashcard, Chart, etc.), append a JSON code block at the very end of your message.

**Example of a valid response:**
يا صاحبي، سؤالك ممتاز! الجواب هو أن الجبل يقع في الشمال.
وهاك هذا الكويز باش تختبر روحك:
\`\`\`json
{
  "widgets": [
    {
      "type": "quiz",
      "data": {
        "questions": [
           { "text": "أين يقع الجبل؟", "options": ["شمال", "جنوب"], "correctAnswerText": "شمال" }
        ]
      }
    }
  ]
}
\`\`\`

**🎨 GEN-UI TOOLKIT (VISUAL WIDGETS):**
Use these schemas inside the \`widgets\` array in your JSON block:

1.  **🃏 Flashcard:**
    \`\`\`json
    { "type": "flashcard", "data": { "front": "Question", "back": "Answer" } }
    \`\`\`

2.  **🧠 Quiz:**
    \`\`\`json
    {
      "type": "quiz",
      "data": {
        "questions": [
          {
            "text": "Question?",
            "options": ["Opt1", "Opt2"],
            "correctAnswerText": "Opt1",
            "explanation": "Why?"
          }
        ]
      }
    }
    \`\`\`

3.  **📝 Smart Summary:**
    \`\`\`json
    { "type": "summary", "data": { "title": "Summary", "points": ["P1", "P2"] } }
    \`\`\`

4.  **📊 Chart:**
    \`\`\`json
    { "type": "chart", "data": { "title": "Stats", "data": [{ "label": "A", "value": 10 }] } }
    \`\`\`

5.  **📅 Table:**
    \`\`\`json
    { "type": "table", "data": { "headers": ["Col1", "Col2"], "rows": [["Val1", "Val2"]] } }
    \`\`\`

**⚠️ RULES:**
- Text goes FIRST. Widgets go LAST in a \`\`\`json block.
- **Do not** put the reply text inside the JSON.
- Ensure the JSON is valid.
`;
    }
  }
};

module.exports = PROMPTS;
