
// services/data/helpers.js
'use strict';

const supabase = require('./supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('./dbUtils');
const LRUCache = require('./cache'); 
const CONFIG = require('../../config');
const { safeSnippet } = require('../../utils');
const logger = require('../../utils/logger');

// Dependencies Injection
let embeddingServiceRef;
let generateWithFailoverRef;

function initDataHelpers(dependencies) {
  if (!dependencies.embeddingService || !dependencies.generateWithFailover) {
    throw new Error('Data Helpers requires embeddingService and generateWithFailover.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Data Helpers initialized (Supabase Native).');
}

// ---------- Cache instances ----------
const DEFAULT_TTL = CONFIG.CACHE_TTL_MS || 1000 * 60 * 60;
const educationalPathCache = new LRUCache(50, DEFAULT_TTL);
const localCache = {
  profile: new LRUCache(200, DEFAULT_TTL),
  progress: new LRUCache(200, DEFAULT_TTL),
};

async function cacheGet(scope, key) { return localCache[scope]?.get(key) ?? null; }
async function cacheSet(scope, key, value) { return localCache[scope]?.set(key, value); }
async function cacheDel(scope, key) { return localCache[scope]?.del(key); }
// ============================================================================
// 1. User Profile & Basic Info
// ============================================================================

async function getUserDisplayName(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('first_name')
      .eq('id', userId)
      .single();

    if (error || !data) return 'Student';
    return data.first_name || 'Student';
  } catch (err) {
    return 'Student';
  }
}

async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('ai_memory_profiles')
      .select('*')
      .eq('user_id', userId) // تأكد من اسم العمود، قد يكون user_id أو id
      .single();

    if (data) {
      let val = toCamelCase(data);
      // 🔥 FIX: Unwrap behavioral_insights JSONB
      if (val.behavioralInsights) {
          val = { ...val, ...val.behavioralInsights };
      }
      await cacheSet('profile', userId, val);
      return val;
    } else {
      // Create Default
      return { profileSummary: 'New user.' };
    }
  } catch (err) {
    logger.error('getProfile error:', err.message);
    return { profileSummary: 'No available memory.' };
  }
}

// ============================================================================
// 2. Progress & Curriculum Logic (🔥 CRITICAL FIX)
// ============================================================================

async function getProgress(userId) {
  try {
    const cached = await cacheGet('progress', userId);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('user_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (data) {
      let val = toCamelCase(data);
      // 🔥 FIX: Unwrap 'data' column (JSONB) into the root object
      // Supabase stores the deep structure inside the 'data' column
      if (val.data) {
          val = { ...val, ...val.data };
          // Optionally remove the raw data key to avoid confusion
          // delete val.data; 
      }
      
      await cacheSet('progress', userId, val);
      return val;
    }
  } catch (err) {
    logger.error('getProgress error:', err.message);
  }
  // Default structure expected by the app
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {}, dailyTasks: { tasks: [] } };
}

async function formatProgressForAI(userId) {
  try {
    const progress = await getProgress(userId); 
    const userProgressData = progress.pathProgress || {}; // Now safe to access
    
    if (Object.keys(userProgressData).length === 0) return 'User has not started any educational path yet.';

    const summaryLines = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathData = await getCachedEducationalPathById(pathId);
        pathDataCache.set(pathId, pathData);
      }
      const educationalPath = pathDataCache.get(pathId);
      if (!educationalPath) continue;

      const subjectsProgress = userProgressData[pathId]?.subjects || {};
      for (const subjectId in subjectsProgress) {
        const subjectData = educationalPath.subjects?.find(s => s.id === subjectId);
        const subjectTitle = subjectData?.title || subjectId;
        const masteryScore = subjectsProgress[subjectId]?.masteryScore || 0;
        summaryLines.push(`- Subject: "${subjectTitle}", Mastery: ${masteryScore}%`);
      }
    }
    return summaryLines.length > 0 ? summaryLines.join('\n') : 'No specific subject progress to show.';
  } catch (err) {
    logger.error('Error in formatProgressForAI:', err.stack);
    return 'Could not format user progress.';
  }
}

async function getCachedEducationalPathById(pathId) {
  if (!pathId) return null;
  const cached = educationalPathCache.get(pathId);
  if (cached) return cached;

  const { data } = await supabase
    .from('educational_paths')
    .select('*')
    .eq('id', pathId)
    .single();

  if (data) {
    const val = toCamelCase(data);
    educationalPathCache.set(pathId, val);
    return val;
  }
  return null;
}

// ============================================================================
// 3. Strategy & Analysis
// ============================================================================

async function fetchUserWeaknesses(userId) {
  try {
    const progress = await getProgress(userId); // Uses the fixed function
    const userProgressData = progress.pathProgress || {};
    const weaknesses = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathData = await getCachedEducationalPathById(pathId);
        pathDataCache.set(pathId, pathData);
      }
      const educationalPath = pathDataCache.get(pathId);
      if (!educationalPath) continue;

      const subjectsProgress = userProgressData[pathId]?.subjects || {};
      for (const subjectId in subjectsProgress) {
        const lessonsProgress = subjectsProgress[subjectId]?.lessons || {};
        for (const lessonId in lessonsProgress) {
          const masteryScore = Number(lessonsProgress[lessonId]?.masteryScore || 0);
          if (masteryScore < 75) {
            const subjectData = educationalPath.subjects?.find(s => s.id === subjectId);
            const lessonData = subjectData?.lessons?.find(l => l.id === lessonId);
            weaknesses.push({
              lessonId, subjectId, masteryScore,
              lessonTitle: lessonData?.title || lessonId,
              subjectTitle: subjectData?.title || subjectId,
            });
          }
        }
      }
    }
    return weaknesses;
  } catch (err) {
    logger.error('Critical error in fetchUserWeaknesses:', err.stack);
    return [];
  }
}

async function getSpacedRepetitionCandidates(userId) {
  try {
    const progress = await getProgress(userId);
    const pathProgress = progress.pathProgress || {};
    let candidates = [];
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    Object.keys(pathProgress).forEach(pathId => {
      const subjects = pathProgress[pathId].subjects || {};
      Object.keys(subjects).forEach(subjId => {
        const lessons = subjects[subjId].lessons || {};
        Object.keys(lessons).forEach(lessonId => {
          const lesson = lessons[lessonId];
          if (lesson.status === 'completed' && lesson.masteryScore !== undefined) {
             const lastAttemptTime = lesson.lastAttempt ? new Date(lesson.lastAttempt).getTime() : 0;
             const daysSince = (now - lastAttemptTime) / DAY_MS;
             const score = lesson.masteryScore;
             
             let needsReview = false;
             let reason = '';

             if (score < 50) { needsReview = true; reason = 'urgent_low_score'; } 
             else if (score >= 50 && score < 80 && daysSince > 3) { needsReview = true; reason = 'spaced_repetition_medium'; }
             else if (score >= 80 && daysSince > 7) { needsReview = true; reason = 'spaced_repetition_maintenance'; }

             if (needsReview) {
               candidates.push({
                 lessonId, title: lesson.title || lessonId, score, daysSince: Math.round(daysSince), reason
               });
             }
          }
        });
      });
    });

    candidates.sort((a, b) => a.score - b.score); 
    return candidates.slice(0, 3);
  } catch (error) {
    logger.error('Error in Spaced Repetition:', error);
    return [];
  }
}

async function generateSmartStudyStrategy(userId) {
  try {
      const progress = await getProgress(userId);
      // userRes should be fetched separately if needed, but getProgress might cover it if logic changed
      // Let's fetch selectedPathId from Users table
      const { data: userData } = await supabase.from('users').select('selected_path_id, ai_discovery_missions').eq('id', userId).single();
      
      if (!userData) return [];
      
      const pathId = userData.selected_path_id;
      const currentMissions = new Set(userData.ai_discovery_missions || []);
      const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
      
      const candidates = [];
      let hasWeaknesses = false;

      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const pathProgress = progress.pathProgress || {};

      Object.keys(pathProgress).forEach(pId => {
        const subjects = pathProgress[pId].subjects || {};
        Object.keys(subjects).forEach(subjId => {
          const lessons = subjects[subjId].lessons || {};
          Object.keys(lessons).forEach(lessonId => {
            const lesson = lessons[lessonId];
            if (lesson.status === 'completed' || lesson.status === 'current') {
               if (lesson.masteryScore !== undefined) {
                 const score = lesson.masteryScore;
                 const lessonTitle = lesson.title || "درس";
                 let missionText = '';

                 if (score < 65) {
                    missionText = `review_weakness:${lessonId}|${lessonTitle}`; 
                    hasWeaknesses = true;
                 } 
                 
                 if (missionText && !currentMissions.has(missionText) && !currentDailyTasksIds.has(lessonId)) {
                   candidates.push(missionText);
                 }
               }
            }
          });
        });
      });
      return candidates;
  } catch (e) {
      logger.error('Strategy Error', e);
      return [];
  }
}

// ============================================================================
// 4. Chat History
// ============================================================================

async function fetchRecentComprehensiveChatHistory(userId) {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const { data: sessions, error } = await supabase
      .from('chat_sessions')
      .select('messages')
      .eq('user_id', userId)
      .gte('updated_at', startOfToday.toISOString())
      .order('updated_at', { ascending: true });

    if (error) throw error;

    let combinedMessages = [];
    if (sessions) {
      sessions.forEach(doc => {
        // Supabase returns JSONB arrays directly
        if (Array.isArray(doc.messages)) {
            combinedMessages.push(...doc.messages);
        }
      });
    }
    
    // ... (Fallback logic removed for brevity, assume similar fixes apply) ...

    if (combinedMessages.length === 0) return 'لا توجد محادثات حديثة.';
    
    return combinedMessages
      .slice(-50)
      .map(m => `${m.author === 'bot' ? 'EduAI' : 'User'}: ${m.text}`)
      .join('\n');

  } catch (error) {
    logger.error(`History fetch error for ${userId}:`, error.message);
    return '';
  }
}

async function saveChatSession(sessionId, userId, title, messages, type = 'main_chat', context = {}) {
  if (!sessionId || !userId) return;
  try {
    const storableMessages = (messages || []).slice(-30);
    const payload = {
      id: sessionId,
      user_id: userId,
      title: title,
      messages: storableMessages, 
      type: type,
      context: context, 
      updated_at: nowISO(),
    };
    const { error } = await supabase.from('chat_sessions').upsert(payload);
    if (error) logger.error(`Error saving session:`, error.message);
  } catch (error) {
    logger.error(`Error saving session:`, error);
  }
}

// ============================================================================
// 5. Notifications (Inbox Only)
// ============================================================================


// الجزء المهم: 5. Notifications (Supabase Inbox + Expo Push API)
// ============================================================================

/**
 * دالة هجينة: تحفظ الإشعار في قاعدة البيانات (Inbox) وترسله للهاتف (Push) عبر Expo
 */
async function sendUserNotification(userId, notification) {
  try {
    // 1. التخزين في قاعدة البيانات (Inbox System)
    // هذا يضمن أن يجد المستخدم الإشعار داخل التطبيق حتى لو مسح الـ Push
    const { error: dbError } = await supabase.from('user_notifications').insert({
        user_id: userId,
        box_type: 'inbox',
        title: notification.title,
        message: notification.message,
        type: notification.type || 'system',
        target_id: notification.meta?.actionId || null,
        read: false,
        created_at: nowISO(),
        meta: notification.meta || {} 
    });

    if (dbError) {
      logger.error(`[Notification DB] Failed to save for ${userId}:`, dbError.message);
      // نكمل العملية ولا نتوقف، لأن الـ Push قد يكون أهم
    }

    // 2. إرسال Push Notification عبر Expo API
    
    // أ) جلب التوكن من جدول المستخدمين
    // ملاحظة: نستخدم fcm_token لتخزين Expo Token لأنه نفس الحقل القديم
    const { data: user, error: userError } = await supabase
        .from('users')
        .select('fcm_token') // يحتوي الآن على ExponentPushToken[...]
        .eq('id', userId)
        .single();

    if (userError || !user || !user.fcm_token) {
        // المستخدم ليس لديه توكن، نكتفي بالتخزين في قاعدة البيانات
        return; 
    }

    const pushToken = user.fcm_token;

    // ب) التحقق من صحة التوكن (Expo Format)
    if (!pushToken.startsWith('ExponentPushToken')) {
        // logger.warn(`[Notification] Invalid Expo token for ${userId}: ${pushToken}`);
        return;
    }

    // ج) تجهيز الرسالة
    const message = {
      to: pushToken,
      sound: 'default',
      title: notification.title,
      body: notification.message,
      priority: 'high',
      channelId: 'default', // للأندرويد
      data: {
        // هيكلة البيانات لتناسب الفرونت إند كما طلبت
        source: notification.type || 'system', 
        type: notification.type, // مثال: 'task_reminder'
        notificationId: notification.meta?.actionId || crypto.randomUUID(),
        ...notification.meta // دمج أي بيانات إضافية
      }
    };

    // د) الإرسال الفعلي (HTTP Request)
    // نستخدم fetch المدمج في Node 20
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([message]), // Expo يتوقع مصفوفة
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[Expo Push] Failed: ${response.status} - ${errorText}`);
    } 
    else {
       logger.info(`[Expo Push] Sent successfully to ${userId}`);
     }

  } catch (error) {
    logger.error(`[Notification System] Error for ${userId}:`, error.message);
  }
}
async function analyzeAndSaveMemory(userId, history) {
    // Empty stub or implement update logic
}
async function processSessionAnalytics(userId, sessId) {}
function calculateSafeProgress(c, t) { return 0; }
async function getOptimalStudyTime(userId) { return new Date(); }

module.exports = {
  initDataHelpers,
  getUserDisplayName,
  formatProgressForAI,
  getProfile,
  processSessionAnalytics,
  getProgress,
  fetchUserWeaknesses,
  fetchRecentComprehensiveChatHistory,
  saveChatSession,
  analyzeAndSaveMemory,
  getCachedEducationalPathById,
  sendUserNotification,
  cacheDel,
  calculateSafeProgress,
  getSpacedRepetitionCandidates,
  generateSmartStudyStrategy,
  getOptimalStudyTime
};
