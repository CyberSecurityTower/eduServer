// services/ai/managers/sessionAnalyzer.js
'use strict';

const supabase = require('../../data/supabase');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');
const { addDiscoveryMission } = require('../../data/helpers');

let generateWithFailoverRef;

function initSessionAnalyzer(dependencies) {
  if (!dependencies || !dependencies.generateWithFailover) {
    throw new Error('Session Analyzer requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Session Analyzer Initialized.');
}

function isValidISODate(value) {
  if (!value || typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

async function analyzeSessionForEvents(userId, history = []) {
  // Returns a summary object for callers/tests. Not required by original code but useful.
  const summary = { scheduled: 0, skippedDuplicates: 0, errors: [] };

  try {
    if (!generateWithFailoverRef) {
      const msg = 'generateWithFailover dependency not initialized.';
      logger.error('[SessionAnalyzer]', msg);
      summary.errors.push(msg);
      return summary;
    }

    // نأخذ آخر رسالتين فقط للسرعة (لتحليل الطلبات القصيرة مثل التذكير)
    const recentTranscript = history.slice(-2).map(m => `${m.role}: ${m.text}`).join('\n');
    const now = new Date();

    // =====================================
    // 1) Reminder / Scheduler prompt
    // =====================================
    const reminderPrompt = `
**System Task:** You are a witty Algerian Scheduler Agent.
**Current Server Time (UTC):** ${now.toISOString()}

**Instructions:**
1. Analyze if the user asked for a reminder.
2. Calculate the EXACT ISO timestamp based on Current Server Time.
3. **CRITICAL - THE MESSAGE:**
   - Write the notification message in **Algerian Derja (الدارجة)**.
   - Be **funny, spontaneous, and urgent** (like a close friend yelling).
   - **Forbidden:** Do NOT use "تذكير" or "حان الوقت" or robotic phrases.
   - **Length:** Short to Medium (max 15 words).

**Examples of Good Messages:**
- "ياو نوض تقرا باراكا ما ترقد! 📚 راهي خلات!"
- "أيا خويا العزيز، الكوراج وبدا تريفيزي، ماتفشلش 💪"
- "ويييين بيا؟ نسيت القراية؟ نوض يا الفنيان 😂"

-CRUCIAL: don't send notification every message , just EXTREME IMPORTANT EVENTS ONLY and less than 2 times in a day

**Conversation:**
${recentTranscript}

**Output JSON ONLY:**
{
  "events": [
    {
      "type": "reminder",
      "title": "تنبيه 🔔",
      "message": "Write the funny Derja message here...",
      "executeAt": "ISO_DATE_STRING"
    }
  ]
}
If no events, return { "events": [] }.
`;

    // Call the model to analyze for reminders
    const analysisRes = await generateWithFailoverRef('analysis', reminderPrompt, { label: 'SessionAnalyzer', timeoutMs: 10000 });
    const analysisRaw = await extractTextFromResult(analysisRes);
    const analysisData = await ensureJsonOrRepair(analysisRaw, 'analysis');

    if (analysisData && Array.isArray(analysisData.events) && analysisData.events.length > 0) {
      // Ensure we don't schedule more than 2 reminders for this user in the past 24 hours
      const window24hStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentCountData, error: recentCountError } = await supabase
        .from('scheduled_actions')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .gte('created_at', window24hStart)
        .neq('status', 'cancelled')
        .limit(1);

      if (recentCountError) {
        logger.warn('[SessionAnalyzer] Could not fetch recent scheduled count:', recentCountError.message);
      }

      // For safety: we'll still check duplicates per-event and the 2-per-day rule
      for (const event of analysisData.events) {
        try {
          // validate executeAt
          if (!isValidISODate(event.executeAt)) {
            logger.warn(`[SessionAnalyzer] Skipping event with invalid executeAt: ${event.executeAt}`);
            summary.errors.push(`invalid_executeAt:${event.executeAt}`);
            continue;
          }

          const executeTime = new Date(event.executeAt);

          // Prevent scheduling for times in the past (server time)
          if (executeTime.getTime() <= now.getTime() - 1000) {
            logger.warn(`[SessionAnalyzer] Skipping past reminder for user ${userId} at ${event.executeAt}`);
            summary.errors.push(`past_executeAt:${event.executeAt}`);
            continue;
          }

          // 2-minute duplicate window
          const timeWindowStart = new Date(executeTime.getTime() - 2 * 60000).toISOString();
          const timeWindowEnd = new Date(executeTime.getTime() + 2 * 60000).toISOString();

          const { data: existingDuplicates, error: checkError } = await supabase
            .from('scheduled_actions')
            .select('id')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .gte('execute_at', timeWindowStart)
            .lte('execute_at', timeWindowEnd);

          if (checkError) {
            logger.error('[SessionAnalyzer] Duplicate check failed:', checkError.message);
            summary.errors.push(`duplicate_check_error:${checkError.message}`);
            continue; // امن: نتجاهل هذا الحدث عند وجود خطأ في الفحص
          }

          if (existingDuplicates && existingDuplicates.length > 0) {
            logger.warn(`[SessionAnalyzer] 🚫 Duplicate reminder prevented for user ${userId} at ${event.executeAt}`);
            summary.skippedDuplicates += 1;
            continue;
          }

          // Check 2 reminders per day rule: count reminders created in last 24h (type 'reminder')
          const { data: dayReminders, error: dayRemError } = await supabase
            .from('scheduled_actions')
            .select('id')
            .eq('user_id', userId)
            .gte('created_at', window24hStart)
            .eq('type', 'reminder');

          if (dayRemError) {
            logger.warn('[SessionAnalyzer] Could not fetch daily reminders count:', dayRemError.message);
          } else {
            const dayCount = Array.isArray(dayReminders) ? dayReminders.length : 0;
            if (dayCount >= 2) {
              logger.warn(`[SessionAnalyzer] User ${userId} already has ${dayCount} reminders in last 24h. Skipping new reminder.`);
              summary.errors.push('daily_limit_reached');
              continue;
            }
          }

          // insert
          const { error: insertError } = await supabase.from('scheduled_actions').insert({
            user_id: userId,
            type: event.type || 'reminder',
            title: event.title || 'تنبيه',
            message: event.message || '',
            execute_at: event.executeAt,
            status: 'pending',
            created_at: new Date().toISOString()
          });

          if (insertError) {
            logger.error('[SessionAnalyzer] DB Insert Error:', insertError.message);
            summary.errors.push(`insert_error:${insertError.message}`);
          } else {
            summary.scheduled += 1;
            logger.success(`[SessionAnalyzer] ✅ Scheduled funny reminder for ${userId} at ${event.executeAt}`);
          }
        } catch (innerErr) {
          logger.error('[SessionAnalyzer] Inner event processing error:', innerErr.message);
          summary.errors.push(`inner_event_error:${innerErr.message}`);
        }
      }
    }

    // =====================================
    // 2) Curiosity Engine (discovery missions)
    // =====================================
    const recentChat = history.slice(-4).map(m => `${m.role}: ${m.text}`).join('\n');

    const curiosityPrompt = `
Analyze this chat snippet. Does the user mention something interesting but incomplete?
Examples:
- "I hate that teacher" (Why?)
- "I failed the exam" (Which exam? What grade?)
- "I have a big dream" (What is it?)

If yes, create a "Discovery Mission" for the AI to ask about it later.
Output JSON: { "new_mission": "Ask user why..." } or null.
Chat:
${recentChat}
`;

    try {
      const curiosityRes = await generateWithFailoverRef('analysis', curiosityPrompt, { label: 'CuriosityCheck', timeoutMs: 8000 });
      const curiosityRaw = await extractTextFromResult(curiosityRes);
      const curiosityResult = await ensureJsonOrRepair(curiosityRaw, 'analysis');

      if (curiosityResult && curiosityResult.new_mission) {
        await addDiscoveryMission(userId, curiosityResult.new_mission, 'auto', 'low');
        logger.info(`🕵️‍♂️ Curiosity Engine: Added mission for ${userId}: "${curiosityResult.new_mission}"`);
      }
    } catch (curErr) {
      // Don't break the whole function for curiosity errors
      logger.warn('[SessionAnalyzer] Curiosity Engine failed:', curErr.message);
      summary.errors.push(`curiosity_error:${curErr.message}`);
    }

  } catch (error) {
    logger.error(`[SessionAnalyzer] Error:`, error && error.message ? error.message : error);
    summary.errors.push(error && error.message ? error.message : String(error));
  }

  return summary;
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
