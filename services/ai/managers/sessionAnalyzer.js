
// services/ai/managers/sessionAnalyzer.js
'use strict';

const { getFirestoreInstance, admin } = require('../../data/firestore');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef;

// تهيئة التبعيات
function initSessionAnalyzer(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Session Analyzer requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Session Analyzer Initialized.');
}

const db = getFirestoreInstance();

/**
 * يحلل جلسة المحادثة لاستخراج أي تذكيرات أو مواعيد تم الاتفاق عليها
 */
async function analyzeSessionForEvents(userId, history) {
  try {
    // نأخذ آخر 20 رسالة فقط لتوفير التوكنز، فهي تحتوي عادة على السياق الأحدث
    const recentTranscript = history.slice(-20).map(m => `${m.role}: ${m.text}`).join('\n');
    
    // الوقت الحالي للسيرفر هو المرجع للـ AI
    const now = new Date();
    const serverTimeISO = now.toISOString();
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });

    const prompt = `
    **System Task:** You are a Scheduler Agent.
    **Current Server Time:** ${serverTimeISO} (Today is ${dayName}).
    
    **Instructions:**
    Analyze the conversation below. Did the user agree to a reminder, mention an exam date, or accept a study session proposal?
    
    1. If user said "Remind me tomorrow at 5 PM", calculate the EXACT ISO date for tomorrow 17:00 based on Current Server Time.
    2. If user mentioned "Exam next Sunday", calculate the date.
    3. **Crucial:** Write the notification message NOW, referencing the context (e.g., "Time to review Physics!").

    **Conversation:**
    ${recentTranscript}

    **Output JSON ONLY:**
    {
      "events": [
        {
          "type": "reminder", // or "exam_prep", "study_session"
          "title": "مراجعة الفيزياء",
          "message": "حان الموعد! اتفقنا أمس أن تراجع درس السرعة. هل أنت جاهز؟",
          "executeAt": "2023-10-27T17:00:00.000Z" // MUST be valid ISO string
        }
      ]
    }
    If no events found, return { "events": [] }.
    `;

    // نستخدم 'analysis' (يفضل Gemini 1.5 Pro إن وجد، أو Flash يكفي حالياً)
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'SessionAnalyzer', timeoutMs: 15000 });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data && Array.isArray(data.events) && data.events.length > 0) {
      const batch = db.batch();
      
      data.events.forEach(event => {
        if (!event.executeAt) return;
        
        const docRef = db.collection('scheduledActions').doc();
        batch.set(docRef, {
          userId,
          type: event.type || 'reminder',
          title: event.title || 'تذكير',
          message: event.message,
          // تحويل النص إلى Timestamp الخاص بفايربيس
          executeAt: admin.firestore.Timestamp.fromDate(new Date(event.executeAt)), 
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          source: 'ai_auto_scheduler'
        });
      });

      await batch.commit();
      logger.success(`[SessionAnalyzer] Scheduled ${data.events.length} smart events for user ${userId}`);
    }

  } catch (error) {
    logger.error(`[SessionAnalyzer] Error for user ${userId}:`, error.message);
  }
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
