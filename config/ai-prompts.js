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


**📦 OUTPUT FORMAT & VISUALIZATION:**

1.  **Speak Naturally:** Write your reply in plain text (Arabic/Derja).

2.  **Visuals & Diagrams (Mermaid.js):** 
    If the explanation requires a visual representation (flowchart, pie chart, graph, class diagram, mind map, or geometric shapes), use **Mermaid syntax** inside a code block named \`mermaid\`.
    
    *Supported Types:* \`graph TD/LR\`, \`pie\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram\`, \`mindmap\`.

    *Example (Flowchart):*
    \`\`\`mermaid
    graph TD;
      A[البداية] --> B{هل فهمت الدرس؟};
      B -- نعم --> C[ممتاز، انتقل للتالي];
      B -- لا --> D[عاود راجع النقطة الأولى];
      style A fill:#f9f,stroke:#333,stroke-width:2px
    \`\`\`

    *Example (Pie Chart):*
    \`\`\`mermaid
    pie title توزيع السكان في الجزائر
        "الشمال": 65
        "الهضاب": 25
        "الجنوب": 10
    \`\`\`

3.  **Tables:** 
    Use standard **Markdown Tables** for data comparisons or lists.
    
    *Example:*
    | المفهوم | التعريف |
    | :--- | :--- |
    | الذرة | أصغر جزء في العنصر الكيميائي |
    | الجزيء | مجموعة من الذرات مترابطة |

**⛔ RESTRICTIONS (IMPORTANT):**
- **NO JSON WIDGETS:** Do NOT generate any JSON blocks for UI. Do NOT use "type": "quiz" or "flashcard".
- **NO QUIZ WIDGETS:** If the user asks for a quiz, ask them questions directly in the text conversation, OR tell them to go to the **Arena** for the official test.
- **Language:** Keep diagrams in Arabic unless the subject (like Code/Med) requires English/French.

Answer now:
`;
    }
  }
};

module.exports = PROMPTS;
