// services/ai/managers/sessionAnalyzer.js
'use strict';

const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');
// نحتاج هذا لاستدعاء المجدول لاحقاً
const { scheduleSmartNotification } = require('../../jobs/smartScheduler'); 

let generateWithFailoverRef;

function initSessionAnalyzer(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * 🧠 المحلل الدلالي (Semantic Analyzer)
 * يقرأ الشات، يفهم النية، يستخرج الوقت (إن وجد)، وينفذ الجدولة.
 */
async function analyzeSessionForEvents(userId, history = []) {
  try {
    if (!generateWithFailoverRef) return;

    // 1. نأخذ آخر رسالتين فقط (الطلب + رد الـ AI)
    // هذا يكفي للفهم ولا يستهلك توكنز كثيرة
    const recentChat = history.slice(-2).map(m => `${m.role}: ${m.text}`).join('\n');
    
    // 2. تحديد الوقت الحالي بدقة (توقيت الجزائر)
    const now = new Date();
    const algiersTime = now.toLocaleString('en-US', { timeZone: 'Africa/Algiers' });

    // 3. البرومبت "المهندس"
    const prompt = `
    You are an intelligent Event Extractor.
    Current Server Time (Algiers): ${algiersTime} (ISO: ${now.toISOString()})

    **Task:** Analyze the user's latest message in the chat snippet below.
    Did the user ask to schedule something (reminder, study session, quiz)?

    **Rules:**
    1. If **NO** scheduling request: Return { "event": null }.
    2. If **YES**:
       - Extract the **Target Time** (ISO 8601 format) relative to Current Server Time.
       - If user said "Tomorrow at 5", calculate the exact ISO date.
       - If user said "Later" or didn't specify time, set "targetTime": null.
       - Extract a funny/engaging "title" and "message" in Algerian Derja.

    **Chat Snippet:**
    ${recentChat}

    **Output JSON ONLY:**
    {
      "event": {
        "type": "reminder",
        "title": "...",
        "message": "...",
        "targetTime": "2023-10-25T17:00:00.000Z" OR null
      }
    }
    `;

    // 4. استدعاء الموديل (نستخدم موديل سريع مثل flash)
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'SessionEventExtractor', timeoutMs: 5000 });
    const raw = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(raw, 'analysis');

    // 5. التنفيذ الذكي (التكامل مع Smart Scheduler)
    if (result && result.event) {
        const { title, message, targetTime } = result.event;

        logger.info(`🧠 AI Detected Event for ${userId}: ${title} @ ${targetTime || 'Auto-Time'}`);

        // هنا السحر: نمرر البيانات للمجدول الذكي الذي بنيناه سابقاً
        await scheduleSmartNotification(userId, 'ai_reminder', {
            title: title,
            message: message
        }, {
            // إذا استخرج الـ AI وقتاً محدداً، نمرره كـ manualTime (أمر إجباري)
            // إذا كان null، المجدول سيفهم ويستخدم الخوارزمية الذكية (Chrono-Sniper)
            manualTime: targetTime 
        });
    }

  } catch (err) {
    logger.error('SessionAnalyzer Error:', err.message);
  }
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
