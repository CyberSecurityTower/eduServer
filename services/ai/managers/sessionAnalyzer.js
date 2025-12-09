
// services/ai/managers/sessionAnalyzer.js
'use strict';

const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');
// استيراد المجدول الذكي الجديد
const { scheduleSmartNotification } = require('../../jobs/smartScheduler'); 
// استيراد دالة إضافة مهام الفضول
const { addDiscoveryMission } = require('../../data/helpers');

let generateWithFailoverRef;

function initSessionAnalyzer(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * 🧠 المحلل الدلالي للجلسة (Semantic Session Analyzer)
 * يقوم بوظيفتين:
 * 1. اكتشاف طلبات الجدولة والتذكير (Event Extractor).
 * 2. اكتشاف المعلومات الناقصة لفضول الـ AI (Curiosity Engine).
 */
async function analyzeSessionForEvents(userId, history = []) {
  try {
    if (!generateWithFailoverRef) return;

    // تجهيز سياق الشات (آخر 3 رسائل كافية للتحليل السريع)
    const recentChat = history.slice(-3).map(m => `${m.role}: ${m.text}`).join('\n');
    const now = new Date();
    const algiersTime = now.toLocaleString('en-US', { timeZone: 'Africa/Algiers' });

    // =========================================================
    // 1. تحليل الأحداث الزمنية (Smart Scheduler Integration)
    // =========================================================
    const eventPrompt = `
    You are an intelligent Event Extractor for an Algerian student.
    Current Server Time (Algiers): ${algiersTime} (ISO: ${now.toISOString()})

    **Task:** Analyze the user's latest messages.
    Did the user explicitly ask to schedule something (reminder, study session, quiz)?

    **Rules:**
    1. If **NO** scheduling request: Return { "event": null }.
    2. If **YES**:
       - Extract **Target Time** (ISO 8601) relative to Current Server Time.
       - If user said "Tomorrow at 5", calculate the exact ISO date.
       - If user said "Later" or didn't specify time, set "targetTime": null (The AI Scheduler will decide).
       - Create a funny/engaging "title" and "message" in Algerian Derja.

    **Chat Snippet:**
    ${recentChat}

    **Output JSON ONLY:**
    {
      "event": {
        "type": "reminder",
        "title": "...",
        "message": "...",
        "targetTime": "ISO_STRING" OR null
      }
    }
    `;

    // استدعاء الموديل (نستخدم timeout قصير نسبياً)
    const eventRes = await generateWithFailoverRef('analysis', eventPrompt, { label: 'SessionEventExtractor', timeoutMs: 6000 });
    const eventRaw = await extractTextFromResult(eventRes);
    const eventResult = await ensureJsonOrRepair(eventRaw, 'analysis');

    if (eventResult && eventResult.event) {
        const { title, message, targetTime } = eventResult.event;
        logger.info(`🧠 AI Detected Event for ${userId}: ${title}`);

        // إرسال للمجدول الذكي
        await scheduleSmartNotification(userId, 'ai_reminder', {
            title: title || 'تذكير',
            message: message || 'وقت الدراسة!'
        }, {
            // إذا استخرج الـ AI وقتاً محدداً، نمرره كأمر يدوي
            // إذا كان null، المجدول سيستخدم خوارزمية Chrono-Sniper
            manualTime: targetTime 
        });
    }

    // =========================================================
    // 2. محرك الفضول (Curiosity Engine)
    // =========================================================
    // نستخدم سياقاً أطول قليلاً (4 رسائل) لفهم السياق العام
    const curiosityChat = history.slice(-4).map(m => `${m.role}: ${m.text}`).join('\n');

    const curiosityPrompt = `
    Analyze this chat snippet. Does the user mention something interesting regarding their personal life, studies, or dreams but the info is incomplete?
    
    Examples:
    - "I hate that teacher" (Why? Which subject?)
    - "I failed the exam" (Which exam? What grade?)
    - "I have a big dream" (What is it?)
    - "I am tired today" (Why?)

    If yes, create a "Discovery Mission" for the AI to ask about it later naturally.
    If NO, return null.

    Output JSON ONLY: { "new_mission": "Ask user why..." } or { "new_mission": null }
    
    Chat:
    ${curiosityChat}
    `;

    const curiosityRes = await generateWithFailoverRef('analysis', curiosityPrompt, { label: 'CuriosityCheck', timeoutMs: 8000 });
    const curiosityRaw = await extractTextFromResult(curiosityRes);
    const curiosityResult = await ensureJsonOrRepair(curiosityRaw, 'analysis');

    if (curiosityResult && curiosityResult.new_mission) {
        // إضافة المهمة لقائمة مهام الاستكشاف الخاصة بالمستخدم
        await addDiscoveryMission(userId, curiosityResult.new_mission, 'auto', 'low');
        logger.info(`🕵️‍♂️ Curiosity Engine: Added mission for ${userId}: "${curiosityResult.new_mission}"`);
    }

  } catch (err) {
    logger.error('SessionAnalyzer Error:', err.message);
  }
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
