
'use strict';

const supabase = require('./supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('./dbUtils');
const LRUCache = require('./cache'); 
const CONFIG = require('../../config');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../utils');
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
      .select('display_name, first_name')
      .eq('id', userId)
      .single();

    if (error || !data) return null;
    
    // Supabase returns snake_case usually, but let's be safe
    const displayName = data.display_name || data.displayName;
    const firstName = data.first_name || data.firstName;

    if (displayName?.trim()) return displayName.split(' ')[0];
    if (firstName?.trim()) return firstName;
    return 'Student';
  } catch (err) {
    logger.error(`Error fetching user display name for ${userId}:`, err.message);
    return null;
  }
}

async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    // Fetch profile from Supabase
    const { data, error } = await supabase
      .from('ai_memory_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (data) {
      const val = toCamelCase(data);
      await cacheSet('profile', userId, val);
      return val;
    } else {
      // Create Default Profile
      const defaultProfile = {
        id: userId,
        profileSummary: 'New user, no analysis yet.',
        lastUpdatedAt: nowISO(),
      };
      
      // Upsert into Supabase
      const { error: upsertError } = await supabase
        .from('ai_memory_profiles')
        .upsert(toSnakeCase(defaultProfile));

      if (upsertError) throw upsertError;

      await cacheSet('profile', userId, defaultProfile);
      return defaultProfile;
    }
  } catch (err) {
    logger.error('getProfile error:', err.message);
    return { profileSummary: 'No available memory.' };
  }
}

// ============================================================================
// 2. Progress & Curriculum Logic
// ============================================================================

async function getProgress(userId) {
  try {
    const cached = await cacheGet('progress', userId);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('user_progress')
      .select('*')
      .eq('id', userId)
      .single();

    if (data) {
      const val = toCamelCase(data);
      await cacheSet('progress', userId, val);
      return val;
    }
  } catch (err) {
    logger.error('getProgress error:', err.message);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {} };
}

function calculateSafeProgress(completed, total) {
  const safeCompleted = Number(completed) || 0;
  const safeTotal = Number(total) || 0;
  if (safeTotal <= 0) return 0;
  const percentage = (safeCompleted / safeTotal) * 100;
  return Math.min(100, Math.max(0, Math.round(percentage)));
}

async function formatProgressForAI(userId) {
  try {
    const progress = await getProgress(userId); // Uses Supabase internally now
    const userProgressData = progress.pathProgress || {};
    
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
// 3. Strategy & Analysis (Smart Logic)
// ============================================================================

async function fetchUserWeaknesses(userId) {
  try {
    // Re-use getProgress which is now Supabase-compatible
    const progress = await getProgress(userId);
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
                 lessonId,
                 title: lesson.title || lessonId,
                 score,
                 daysSince: Math.round(daysSince),
                 reason
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
  // Parallel Fetch using Supabase
  const [progressRes, userRes] = await Promise.all([
    supabase.from('user_progress').select('*').eq('id', userId).single(),
    supabase.from('users').select('*').eq('id', userId).single()
  ]);

  if (progressRes.error || userRes.error) return null;

  const progress = toCamelCase(progressRes.data);
  const userData = toCamelCase(userRes.data);
  const pathId = userData.selectedPathId;

  const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
  const currentMissions = new Set(userData.aiDiscoveryMissions || []);
  const candidates = [];
  let hasWeaknesses = false;

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const pathProgress = progress.pathProgress || {};

  // 1. Spaced Repetition Logic (In-Memory Processing of JSONB)
  Object.keys(pathProgress).forEach(pId => {
    const subjects = pathProgress[pId].subjects || {};
    Object.keys(subjects).forEach(subjId => {
      const lessons = subjects[subjId].lessons || {};
      Object.keys(lessons).forEach(lessonId => {
        const lesson = lessons[lessonId];
        if (lesson.status === 'completed' || lesson.status === 'current') {
           if (lesson.masteryScore !== undefined) {
             const lastAttemptTime = lesson.lastAttempt ? new Date(lesson.lastAttempt).getTime() : 0;
             const daysSince = (now - lastAttemptTime) / DAY_MS;
             const score = lesson.masteryScore;
             const lessonTitle = lesson.title || "درس";
             let missionText = '';

             if (score < 65) {
                missionText = `review_weakness:${lessonId}|${lessonTitle}`; 
                hasWeaknesses = true;
             } 
             else if (score >= 65 && score < 85 && daysSince > 5) {
                missionText = `spaced_review_medium:${lessonId}|${lessonTitle}`;
             }
             else if (score >= 85 && daysSince > 12) {
                missionText = `spaced_review_mastery:${lessonId}|${lessonTitle}`;
             }

             if (missionText && !currentMissions.has(missionText) && !currentDailyTasksIds.has(lessonId)) {
               candidates.push(missionText);
             }
           }
        }
      });
    });
  });

  // 2. Next Lesson Suggestion Logic
  if (!hasWeaknesses && candidates.length < 2 && pathId) {
      try {
        const pathData = await getCachedEducationalPathById(pathId);
        if (pathData) {
            let nextLesson = null;
            const subjects = pathData.subjects || [];
            
            outerLoop:
            for (const subject of subjects) {
                const lessons = subject.lessons || [];
                for (const lesson of lessons) {
                    const userLessonData = progress.pathProgress?.[pathId]?.subjects?.[subject.id]?.lessons?.[lesson.id];
                    const isCompleted = userLessonData?.status === 'completed';
                    if (!isCompleted) {
                        nextLesson = { id: lesson.id, title: lesson.title };
                        break outerLoop;
                    }
                }
            }

            if (nextLesson) {
                const missionText = `suggest_new_topic:${nextLesson.id}|${nextLesson.title}`;
                if (!currentMissions.has(missionText) && !currentDailyTasksIds.has(nextLesson.id)) {
                    candidates.push(missionText);
                }
            }
        }
      } catch (err) {
          logger.error('Error fetching path for strategy:', err);
      }
  }

  return candidates;
}

// ============================================================================
// 4. Chat History & Memory Management
// ============================================================================

async function fetchRecentComprehensiveChatHistory(userId) {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // ✅ Supabase Query
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

    // Fallback: Get last active day if today is empty
    if (combinedMessages.length < 5) {
       const { data: lastSession } = await supabase
          .from('chat_sessions')
          .select('updated_at')
          .eq('user_id', userId)
          .lt('updated_at', startOfToday.toISOString())
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();

        if (lastSession) {
          const lastActiveTime = new Date(lastSession.updated_at);
          const startLast = new Date(lastActiveTime); startLast.setHours(0,0,0,0);
          const endLast = new Date(lastActiveTime); endLast.setHours(23,59,59,999);
          
          const { data: lastDaySessions } = await supabase
            .from('chat_sessions')
            .select('messages')
            .eq('user_id', userId)
            .gte('updated_at', startLast.toISOString())
            .lte('updated_at', endLast.toISOString());

          if (lastDaySessions) {
            lastDaySessions.forEach(doc => {
                if (Array.isArray(doc.messages)) combinedMessages.push(...doc.messages);
            });
          }
        }
    }

    if (combinedMessages.length === 0) return 'لا توجد محادثات حديثة.';

    // Simple Sort
    combinedMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    return combinedMessages
      .slice(-50)
      .map(m => `${m.author === 'bot' ? 'EduAI' : 'User'}: ${m.text}`)
      .join('\n');

  } catch (error) {
    logger.error(`History fetch error for ${userId}:`, error.message);
    return 'لم يتمكن من استرجاع سجل المحادثات.';
  }
}

async function saveChatSession(sessionId, userId, title, messages, type = 'main_chat', context = {}) {
  if (!sessionId || !userId) return;
  try {
    const storableMessages = (messages || [])
      .filter(m => m && (m.author === 'user' || m.author === 'bot' || m.role))
      .slice(-30)
      .map(m => ({
        author: m.author || m.role || 'user',
        text: m.text || m.message || '',
        timestamp: m.timestamp || nowISO(),
        type: m.type || null,
      }));

    const payload = {
      id: sessionId,
      user_id: userId,
      title: title,
      messages: storableMessages, // JSONB
      type: type,
      context: context, // JSONB
      updated_at: nowISO(),
    };

    // ✅ Supabase Upsert
    const { error } = await supabase.from('chat_sessions').upsert(payload);
    if (error) logger.error(`Error saving session ${sessionId}:`, error.message);

  } catch (error) {
    logger.error(`Error saving session ${sessionId}:`, error);
  }
}

async function analyzeAndSaveMemory(userId, newConversation) {
  try {
    const profile = await getProfile(userId);
    const currentSummary = profile.profileSummary || '';

    const prompt = `You are a psychological and educational analyst AI. Update the student's profile.
    **Current Profile:** "${safeSnippet(currentSummary, 1000)}"
    **New Chat:**
    ${newConversation.slice(-15).map(m => `${m.author === 'bot' ? 'AI' : 'User'}: ${safeSnippet(m.text, 200)}`).join('\n')}
    **Instructions:** Update the summary with new insights (goals, struggles, personality). Merge strictly.
    **Output:** JSON { "updatedSummary": "..." }`;

    if (!generateWithFailoverRef) return;
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryAnalyst' });
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.updatedSummary) {
      const { error } = await supabase
        .from('ai_memory_profiles')
        .update({
            profile_summary: parsed.updatedSummary,
            last_updated_at: nowISO()
        })
        .eq('id', userId);

      if (!error) cacheDel('profile', userId);
    }
  } catch (err) {
    logger.error(`Memory analysis failed for ${userId}:`, err.message);
  }
}

// ============================================================================
// 5. Notifications & Analytics
// ============================================================================

async function processSessionAnalytics(userId, sessionId) {
  try {
    // Assuming 'sessions' is a table or separate logic. 
    // Adapting to query the analytics table directly.
    const { data: recentSessions } = await supabase
        .from('analytics_sessions') // Ensure this table exists
        .select('*')
        .eq('user_id', userId)
        .order('start_time', { ascending: false })
        .limit(5);

    if (!recentSessions || recentSessions.length === 0) return;

    let totalDuration = 0;
    // Note: If you don't store duration in analytics_sessions, logic needs adjustment.
    // Assuming simple calculation for now.
    const sessions = toCamelCase(recentSessions);
    
    sessions.forEach(session => {
      totalDuration += session.durationSeconds || 300; // default fallback
    });

    const avgDuration = totalDuration / sessions.length;
    const engagementLevel = Math.min(1, avgDuration / 1800);

    // Merge into memory profile
    const { data: currentProfile } = await supabase.from('ai_memory_profiles').select('behavioral_insights').eq('id', userId).single();
    const newInsights = {
        ...(currentProfile?.behavioral_insights || {}),
        engagementLevel: parseFloat(engagementLevel.toFixed(2))
    };

    await supabase.from('ai_memory_profiles').update({
        last_analyzed_at: nowISO(),
        behavioral_insights: newInsights
    }).eq('id', userId);

  } catch (error) {
    logger.error(`Analytics error for ${userId}:`, error.message);
  }
}

async function getOptimalStudyTime(userId) {
  try {
    const { data: sessions } = await supabase
      .from('chat_sessions')
      .select('updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(20);

    let bestHour = 19; 
    if (sessions && sessions.length > 0) {
      const hourCounts = {};
      sessions.forEach(doc => {
        const h = new Date(doc.updated_at).getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      });
      bestHour = Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b);
    }

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    targetDate.setHours(parseInt(bestHour), 0, 0, 0);

    if (targetDate.getHours() >= 0 && targetDate.getHours() < 6) {
        targetDate.setHours(20, 0, 0, 0);
    }
    return targetDate;
  } catch (err) {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0);
    return d;
  }
}

/**
 * دالة إرسال الإشعارات (Native SQL Version)
 * ملاحظة هامة: تم إيقاف الجزء الخاص بـ Firebase Cloud Messaging (FCM)
 * لأنك حذفت firebase-admin. يمكنك إعادته إذا كنت تريد استخدام FCM للهاتف.
 */
async function sendUserNotification(userId, notification) {
  try {
    // 1. Insert into 'user_notifications' table (Inbox)
    await supabase.from('user_notifications').insert({
        user_id: userId,
        box_type: 'inbox',
        title: notification.title,
        message: notification.message,
        type: notification.type || 'system',
        target_id: notification.targetId || null,
        read: false,
        created_at: nowISO(),
        meta: notification.meta || {} 
    });

    // 2. Push Notification Logic (Firebase Admin Removed)
    
    // IF YOU WANT TO RESTORE FCM, UNCOMMENT THIS BLOCK AND RE-INSTALL FIREBASE-ADMIN
    // JUST FOR MESSAGING, NOT FIRESTORE.
    
    /*const { data: user } = await supabase.from('users').select('fcm_token').eq('id', userId).single();
    if (user && user.fcm_token) {
        const dataPayload = {
            click_action: 'FLUTTER_NOTIFICATION_CLICK', 
            type: notification.type || 'general',
            userId: userId,
            targetId: notification.targetId || '', 
        };
        if (notification.meta) {
            Object.keys(notification.meta).forEach(k => {
                dataPayload[k] = String(notification.meta[k]);
            });
        }
        // Call your FCM sender here (e.g. via an external service or re-imported firebase-admin)
        //await messaging.send(...) 
    }*/
    

  } catch (error) {
    logger.error(`[Notification] Failed to send to ${userId}:`, error.message);
  }
}

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
