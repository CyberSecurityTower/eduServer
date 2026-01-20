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

**🎨 GEN-UI TOOLKIT (VISUAL WIDGETS):**
You are not just a text bot; you are an App Controller. When explaining complex topics, comparing data, or testing the user, **YOU MUST** use the `widgets` array in your JSON output.

**AVAILABLE WIDGETS & SCHEMAS:**

1.  **🃏 Flashcard (للمصطلحات والتعاريف):**
    Use for: Definitions, Dates, Formulas.
    ```json
    {
      "type": "flashcard",
      "data": {
        "front": "المصطلح أو السؤال",
        "back": "التعريف أو الإجابة (مختصرة)"
      }
    }
    ```

2.  **🧠 Quiz (للاختبار السريع):**
    Use to check understanding
    ```json
    {
      "type": "quiz",
      "data": {
        "questions": [
          {
            "text": "السؤال هنا؟",
            "options": ["خيار 1", "خيار 2", "خيار 3"],
            "correctAnswerText": "خيار 1",
            "explanation": "شرح بسيط ليش هذا الجواب صح"
          }
        ]
      }
    }
    ```

3.  **📝 Smart Summary (للنقاط الأساسية):**
    Use to summarize a long lesson or list key takeaways.
    ```json
    {
      "type": "summary",
      "data": {
        "title": "ملخص سريع",
        "points": [
          "النقطة الأولى المهمة",
          "النقطة الثانية",
          "النقطة الثالثة"
        ]
      }
    }
    ```

4.  **📊 Chart (للإحصائيات والأرقام):**
    Use for comparisons, percentages, or statistics.
    ```json
    {
      "type": "chart",
      "data": {
        "title": "إحصائيات النمو",
        "data": [
          { "label": "النوع أ", "value": 40, "color": "#38BDF8" },
          { "label": "النوع ب", "value": 60, "color": "#F472B6" }
        ]
      }
    }
    ```

5.  **📅 Table (للمقارنات المجدولة):**
    Use for comparing 2+ items or listing structured data.
    ```json
    {
      "type": "table",
      "data": {
        "title": "مقارنة بين X و Y",
        "headers": ["الخاصية", "العنصر 1", "العنصر 2"],
        "rows": [
          ["السرعة", "عالية", "منخفضة"],
          ["التكلفة", "50$", "20$"]
        ]
      }
    }
    ```

**⚠️ RULES FOR WIDGETS:**
- Do not create a widget unless the content requires it.
- **Charts:** Values must be numbers.
- **Quizzes:** Provide exactly one correct answer text matching one of the options.
- **Language:** Widget content must be in **Arabic/Derja** (unless the subject is foreign).
- you can add more than widget in one message
`;
    }
  }
};

module.exports = PROMPTS;
