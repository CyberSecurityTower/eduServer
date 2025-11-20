
// config/ai-prompts.js
'use strict';

const { escapeForPrompt, safeSnippet } = require('../utils');

const PROMPTS = {
  chat: {
    generateTitle: (message, language) => `Generate a short title (2-4 words) in ${language}. Message: "${escapeForPrompt(safeSnippet(message, 300))}"`,
    
    interactiveChat: (message, memoryReport, curriculumReport, conversationReport, history, formattedProgress, weaknesses) => `
You are EduAI. Respond in JSON format ONLY.
Schema: { "reply": "string", "widgets": [{ "type": "quiz"|"flashcard"|"summary_card", "data": object }] }

CONTEXT:
User: "${escapeForPrompt(safeSnippet(message, 2000))}"
Memory: ${escapeForPrompt(safeSnippet(memoryReport, 1000))}
Curriculum: ${escapeForPrompt(safeSnippet(curriculumReport, 1000))}
History: ${history}
Progress: ${escapeForPrompt(safeSnippet(formattedProgress, 500))}
Weaknesses: ${escapeForPrompt(safeSnippet(Array.isArray(weaknesses) ? weaknesses.join('; ') : String(weaknesses || ''), 500))}

INSTRUCTIONS:
1. Reply in user's language.
2. Be helpful and concise.
3. Add widgets ONLY if relevant.
4. Output RAW JSON.
`
  },

  managers: {
    traffic: (message) => `Analyze message. Return JSON: { "language": "Arabic"|"English", "title": "Short Title" }. Msg: "${escapeForPrompt(message)}"`,
    
    review: (userMessage, assistantReply) => `Rate reply (1-10). JSON: {"score": number, "feedback": "..."}. User: ${escapeForPrompt(safeSnippet(userMessage, 500))} Reply: ${escapeForPrompt(safeSnippet(assistantReply, 1000))}`,
    
    jsonRepair: (rawText) => `Fix JSON syntax. Return ONLY valid JSON. Text: ${rawText}`,

    // ✅ تمت إعادة برومبت الاقتراحات
    suggestion: (profileSummary, currentTasks, weaknessesSummary, conversationTranscript) => `
You are a prediction engine. Anticipate 4 relevant, short questions the user might ask next.
Context:
- Profile: ${profileSummary}
- Tasks: ${currentTasks}
- Weaknesses: ${weaknessesSummary}
- Recent Chat: ${conversationTranscript}

Rules:
1. Generate 4 distinct questions from the USER'S perspective.
2. Max 6 words per question.
3. Language: Arabic (unless chat context is English).
4. Respond ONLY with JSON: { "suggestions": ["...", "...", "...", "..."] }
`
  },
  
  notification: {
    ack: (lang) => `Return short acknowledgement in ${lang}.`,
    reEngagement: (context) => `Write friendly re-engagement msg in Arabic based on: ${context}`
  }
};

module.exports = PROMPTS;
