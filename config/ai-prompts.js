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

**📖 REFERENCE CONTENT:**
${safeSnippet(lessonContentSnippet, 1500)}

**💬 USER MESSAGE:**
"${escapeForPrompt(message)}"

**📦 OUTPUT FORMAT & VISUALIZATION:**

1.  **Plain Text:** Write your reply in plain text (Algerian Derja/Arabic) first.

2.  **Visuals (Mermaid.js):** 
    If you need diagrams (flowchart, pie, graph, mindmap), use **Mermaid syntax** inside a code block named \`mermaid\`.
    *Example:*
    \`\`\`mermaid
    graph TD; A[Start] --> B{Decision};
    \`\`\`


3.  **Tables (HTML ONLY):** 
    Do **NOT** use Markdown tables. Instead, use standard **HTML Tables** inside a code block named \`html\`.
    *Example:*
    \`\`\`html
    <table>
      <thead>
        <tr><th>المفهوم</th><th>التعريف</th></tr>
      </thead>
      <tbody>
        <tr><td>الذرة</td><td>أصغر جزء</td></tr>
        <tr><td>الجزيء</td><td>مجموعة ذرات</td></tr>
      </tbody>
    </table>
    \`\`\`

4.  **Interactive Quiz (JSON Widget):**
     - **Trigger:** Generate this **ONLY** if the user explicitly asks for a quiz/test or if you want to verify their understanding of a complex topic.
    - **Structure:** Append a JSON block at the very end.
    - **Content:** Generate **6 to 8 questions**.
    - **Constraint:** Questions must be STRICTLY based on the **Academic Lesson Content** provided above.
    - **NEGATIVE CONSTRAINT:** Do **NOT** ask questions about the App, Arena Rules, EduCoins, Passing Scores, or Interface. Test ONLY the subject matter.
    - **Schema:**
      \`\`\`json
      {
        "type": "quiz",
        "data": {
          "questions": [
            {
              "text": "Question text here?",
              "options": ["Option A", "Option B", "Option C", "Option D"],
              "correctAnswerText": "Option A",
              "explanation": "Brief explanation of why this is correct (shown after answering)."
            }
          ]
        }
      }
      \`\`\`

**⚠️ RULES:**
- Text goes FIRST. Widgets go LAST in a \`\`\`json block.
- **Do NOT** use JSON for anything else (No Flashcards, No Charts - use Mermaid for charts).
- Ensure the JSON is valid and strictly follows the schema above.

Answer now:
`;
    }
  }
};

module.exports = PROMPTS;
