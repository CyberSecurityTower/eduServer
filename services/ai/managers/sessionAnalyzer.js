
// services/ai/managers/sessionAnalyzer.js
'use strict';

const supabase = require('../../data/supabase'); // 👈 نستخدم Supabase مباشرة
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
    // نأخذ آخر رسالتين فقط (طلب المستخدم ورد البوت) للسرعة والدقة
    const recentTranscript = history.slice(-2).map(m => `${m.role}: ${m.text}`).join('\n');
    
    // الوقت الحالي (UTC)
    const now = new Date();
    
    const prompt = `
    **System Task:** You are a Scheduler Agent.
    **Current Server Time (UTC):** ${now.toISOString()}
    
    **Instructions:**
    Analyze the conversation. Did the user ask for a reminder?
    If yes, calculate the EXACT ISO timestamp for the reminder based on Current Server Time.
    
    **Example:**
    User: "Remind me in 2 minutes"
    Current Time: 12:00:00
    Execute At: 12:02:00
    
    **Conversation:**
    ${recentTranscript}

    **Output JSON ONLY:**
    {
      "events": [
        {
          "type": "reminder", 
          "title": "تذكير",
          "message": "حان الوقت! طلبت مني نذكرك: [summary of request]",
          "executeAt": "ISO_DATE_STRING" 
        }
      ]
    }
    If no events, return { "events": [] }.
    `;

    if (!generateWithFailoverRef) return;

    // نستخدم موديل سريع (Flash)
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'SessionAnalyzer', timeoutMs: 10000 });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data && Array.isArray(data.events) && data.events.length > 0) {
      
      const eventsToInsert = data.events.map(event => ({
          user_id: userId,
          type: event.type || 'reminder',
          title: event.title || 'تذكير ذكي',
          message: event.message,
          execute_at: event.executeAt, // 👈 هذا هو العمود المهم
          status: 'pending',
          created_at: new Date().toISOString()
      }));

      // الحفظ في Supabase
      const { error } = await supabase.from('scheduled_actions').insert(eventsToInsert);

      if (error) {
          logger.error('[SessionAnalyzer] DB Error:', error.message);
      } else {
          logger.success(`[SessionAnalyzer] Scheduled ${eventsToInsert.length} events for user ${userId}`);
      }
    }

  } catch (error) {
    logger.error(`[SessionAnalyzer] Error:`, error.message);
  }
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
