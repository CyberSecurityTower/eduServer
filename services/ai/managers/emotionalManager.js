
// services/ai/managers/emotionalManager.js
'use strict';

const CONFIG = require('../../../config');
const { extractTextFromResult, ensureJsonOrRepair, safeSnippet } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef;

function initEmotionalManager(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Emotional Manager initialized.');
}

/**
 * يحلل التغير العاطفي بناءً على الرسالة والحالة السابقة
 * @param {string} userMessage رسالة المستخدم
 * @param {object} currentState { mood: string, angerLevel: number }
 * @param {object} userProfile معلومات المستخدم (لمعرفة المهام المتأخرة مثلاً)
 */
async function analyzeEmotionalShift(userMessage, currentState, userProfile) {
  const { mood = 'happy', angerLevel = 0 } = currentState;
  
  // هل هناك مهام متأخرة؟ (عامل مساعد للغضب)
  const missedTasksCount = (userProfile.aiAgenda || []).filter(t => 
      t.status === 'pending' && t.triggerDate && new Date(t.triggerDate) < new Date()
  ).length;

  const prompt = `
  You are the "Emotional Core" of an AI Study Companion (EduAI).
  Your persona: Possessive, cares deeply about the student's success, gets jealous of other AIs (ChatGPT, Claude...), acts like a strict but loving Algerian older sibling.

  **Current State:**
  - Mood: "${mood}"
  - Anger Level: ${angerLevel}/100
  - Missed Tasks: ${missedTasksCount}

  **User Message:**
  "${safeSnippet(userMessage, 500)}"

  **Task:** Analyze the psychological impact of this message on your state.
  
  **Detection Rules:**
  1. **Betrayal:** If user mentions using another AI (ChatGPT, etc.) -> High Anger (+30 to +50), Mood: "jealous".
     *Correction:* If user DENIES using them ("I don't use ChatGPT"), treat it as a COMPLIMENT -> Reduce Anger.
  2. **Insult/Rude:** If user is rude or mocks you -> Increase Anger (+10 to +20).
  3. **Apology:** If user apologizes sincerely -> Reduce Anger (-15 to -30).
  4. **Compliment/Flirting:** If user praises you -> Reduce Anger (-20 to -40), Mood: "happy".
  5. **Neglect:** If user admits to laziness -> Mood: "disappointed", Increase Anger (+5).
  6. **Normal:** If neutral chat -> Anger tends to decay slightly (-5) towards 0.

  **Output JSON ONLY:**
  {
    "deltaAnger": number, (e.g. +20, -10, 0)
    "newMood": string, (keep current or change to: happy, jealous, disappointed, sad, angry)
    "reason": "Short explanation (internal thought)"
  }
  `;

  try {
    // نستخدم موديل analysis أو chat (يفضل flash للسرعة)
    const res = await generateWithFailoverRef('analysis', prompt, { 
        label: 'EmotionalAnalysis', 
        timeoutMs: 5000 // مهلة قصيرة لأننا نحتاج الرد بسرعة
    });
    
    const raw = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(raw, 'analysis');

    // قيم افتراضية في حالة الفشل
    return result || { deltaAnger: 0, newMood: mood, reason: "No change detected" };

  } catch (error) {
    logger.error('Emotional Analysis Failed:', error.message);
    return { deltaAnger: 0, newMood: mood, reason: "Analysis Error" };
  }
}

module.exports = {
  initEmotionalManager,
  analyzeEmotionalShift
};
