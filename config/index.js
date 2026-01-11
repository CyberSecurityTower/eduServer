

// config/index.js
'use strict';

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  ENABLE_EDUNEXUS: false, 
   // 🔥 النظام الجديد (مطفأ افتراضياً للحماية)
  ATOMIC_SYSTEM: {
    ENABLED: true, // غير هذا إلى true فقط عندما نكون جاهزين 100%
    DEBUG_MODE: true // لرؤية تفاصيل الحسابات في الكونسول
  },
  MODEL: {
    chat: 'gemini-2.5-flash',
    todo: 'gemini-2.5-flash',
    planner: 'gemini-2.5-flash',
    review: 'gemini-2.5-flash',
    analysis: 'gemini-2.5-flash',
    titleIntent: 'gemini-2.5-flash',
    notification: 'gemini-2.5-flash',
    suggestion: 'gemini-2.5-flash',
    embedding: 'text-embedding-004',
    lesson_generator: 'gemini-2.5-pro', 
  },
 TIMEOUTS: {
    default: Number(process.env.TIMEOUT_DEFAULT_MS || 30000), 
    chat: Number(process.env.TIMEOUT_CHAT_MS || 45000), 
    notification: Number(process.env.TIMEOUT_NOTIFICATION_MS || 40000),
    review: Number(process.env.TIMEOUT_REVIEW_MS || 20000),
    analysis: Number(process.env.TIMEOUT_ANALYSIS_MS || 60000),
  },
  CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || 30000),
  JOB_POLL_MS: Number(process.env.JOB_WORKER_POLL_MS || 3000),
  REVIEW_THRESHOLD: Number(process.env.REVIEW_QUALITY_THRESHOLD || 6),
  MAX_RETRIES: Number(process.env.MAX_MODEL_RETRIES || 3),
  NIGHTLY_JOB_SECRET: process.env.NIGHTLY_JOB_SECRET || 'vl&h{`4^9)fUy3Mw30_FqXfU~UwIE0K6@*2j_4]1',
};

module.exports = CONFIG;
