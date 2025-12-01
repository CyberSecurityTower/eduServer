
// services/ai/managers/sessionAnalyzer.js
'use strict';

const supabase = require('../../data/supabase');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef;

function initSessionAnalyzer(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Session Analyzer requires generateWithFailover.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Session Analyzer Initialized.');
}

async function analyzeSessionForEvents(userId, history) {
  try {
    // نأخذ آخر رسالتين فقط للسرعة
    const recentTranscript = history.slice(-2).map(m => `${m.role}: ${m.text}`).join('\n');
    const now = new Date();

    // 1. برومبت معدل كلياً لإنتاج رسائل جزائرية عفوية
    const prompt = `
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

    if (!generateWithFailoverRef) return;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'SessionAnalyzer', timeoutMs: 10000 });
    const raw = await extractTextFromResult(res);
    const data = await ensureJsonOrRepair(raw, 'analysis');

    if (data && Array.isArray(data.events) && data.events.length > 0) {
      
      for (const event of data.events) {
        const executeTime = new Date(event.executeAt);
        
        // 🛑 2. نظام منع التكرار (Anti-Duplicate Logic) 🛑
        
        // نحدد مجال زمني ضيق (مثلاً: هل يوجد تذكير لنفس المستخدم في نطاق +/- 2 دقيقة من هذا الوقت؟)
        const timeWindowStart = new Date(executeTime.getTime() - 2 * 60000).toISOString();
        const timeWindowEnd = new Date(executeTime.getTime() + 2 * 60000).toISOString();

        // تحقق من قاعدة البيانات
        const { data: existingDuplicates, error: checkError } = await supabase
            .from('scheduled_actions')
            .select('id')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .gte('execute_at', timeWindowStart)
            .lte('execute_at', timeWindowEnd);

        if (checkError) {
            logger.error('[SessionAnalyzer] Duplicate check failed:', checkError.message);
            continue; // في حالة الخطأ، نتجاوز للأمان
        }

        // إذا وجدنا تذكيرًا مشابهًا، نتجاهل الجديد
        if (existingDuplicates && existingDuplicates.length > 0) {
            logger.warn(`[SessionAnalyzer] 🚫 Duplicate reminder prevented for user ${userId} at ${event.executeAt}`);
            continue; 
        }

        // إذا لم يوجد تكرار، نقوم بالإدراج
        const { error: insertError } = await supabase.from('scheduled_actions').insert({
            user_id: userId,
            type: event.type || 'reminder',
            title: event.title || 'تنبيه', // العنوان يمكن أن يكون بسيطاً
            message: event.message, // الرسالة المضحكة من الـ AI
            execute_at: event.executeAt,
            status: 'pending',
            created_at: new Date().toISOString()
        });

        if (insertError) {
            logger.error('[SessionAnalyzer] DB Insert Error:', insertError.message);
        } else {
            logger.success(`[SessionAnalyzer] ✅ Scheduled funny reminder for ${userId}`);
        }
      }
    }

  } catch (error) {
    logger.error(`[SessionAnalyzer] Error:`, error.message);
  }
}

module.exports = { initSessionAnalyzer, analyzeSessionForEvents };
