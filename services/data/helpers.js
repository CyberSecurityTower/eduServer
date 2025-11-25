
// services/data/helpers.js
'use strict';

const { getFirestoreInstance, admin } = require('./firestore');
const LRUCache = require('./cache'); // Ensure this file exists
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
  logger.info('Data Helpers initialized.');
}

const db = getFirestoreInstance();

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
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    if (userData.displayName?.trim()) return userData.displayName.split(' ')[0];
    if (userData.firstName?.trim()) return userData.firstName;
    return null;
  } catch (err) {
    logger.error(`Error fetching user display name for ${userId}:`, err.message);
    return null;
  }
}

async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    // Fetch profile from Firestore
    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();

    if (doc.exists) {
      const val = doc.data();
      await cacheSet('profile', userId, val);
      return val;
    } else {
      const defaultProfile = {
        profileSummary: 'New user, no analysis yet.',
        lastUpdatedAt: new Date().toISOString(),
      };
      await db.collection('aiMemoryProfiles').doc(userId).set(defaultProfile);
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
    const doc = await db.collection('userProgress').doc(userId).get();
    if (doc.exists) {
      const val = doc.data() || {};
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
    const userProgressDoc = await db.collection('userProgress').doc(userId).get();
    if (!userProgressDoc.exists) return 'No progress data found.';
    const userProgressData = userProgressDoc.data()?.pathProgress || {};
    if (Object.keys(userProgressData).length === 0) return 'User has not started any educational path yet.';

    const summaryLines = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathDoc = await db.collection('educationalPaths').doc(pathId).get();
        pathDataCache.set(pathId, pathDoc.exists ? pathDoc.data() : null);
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

  const doc = await db.collection('educationalPaths').doc(pathId).get();
  if (doc.exists) {
    const data = doc.data();
    educationalPathCache.set(pathId, data);
    return data;
  }
  return null;
}

// ============================================================================
// 3. Strategy & Analysis (Smart Logic)
// ============================================================================

async function fetchUserWeaknesses(userId) {
  try {
    const userProgressDoc = await db.collection('userProgress').doc(userId).get();
    if (!userProgressDoc.exists) return [];
    const userProgressData = userProgressDoc.data()?.pathProgress || {};
    const weaknesses = [];
    const pathDataCache = new Map();

    for (const pathId in userProgressData) {
      if (!pathDataCache.has(pathId)) {
        const pathDoc = await db.collection('educationalPaths').doc(pathId).get();
        pathDataCache.set(pathId, pathDoc.exists ? pathDoc.data() : null);
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

// ✅ (جديد) خوارزمية المراجعة المتباعدة
async function getSpacedRepetitionCandidates(userId) {
  try {
    const progressDoc = await db.collection('userProgress').doc(userId).get();
    if (!progressDoc.exists) return [];
    
    const data = progressDoc.data();
    const pathProgress = data.pathProgress || {};
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

// ✅ (محدث) العقل المدبر الليلي + اقتراح الدرس التالي
async function generateSmartStudyStrategy(userId) {
  const [progressDoc, userDoc] = await Promise.all([
    db.collection('userProgress').doc(userId).get(),
    db.collection('users').doc(userId).get()
  ]);

  if (!progressDoc.exists || !userDoc.exists) return null;

  const progress = progressDoc.data();
  const userData = userDoc.data();
  const pathId = userData.selectedPathId;

  const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
  const currentMissions = new Set(userData.aiDiscoveryMissions || []);
  const candidates = [];
  let hasWeaknesses = false;

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const pathProgress = progress.pathProgress || {};

  // 1. Spaced Repetition Logic
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

  // 2. Next Lesson Suggestion Logic (Smart Pacing)
  if (!hasWeaknesses && candidates.length < 2 && pathId) {
      try {
        const pathDoc = await db.collection('educationalPaths').doc(pathId).get();
        if (pathDoc.exists) {
            const pathData = pathDoc.data();
            let nextLesson = null;
            const subjects = pathData.subjects || [];
            
            // Loop sequentially to find the first incomplete lesson
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
    const now = new Date();
    const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0));

    // Get Today's Chat
    const todaySnapshot = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(startOfToday))
      .get();

    let combinedMessages = [];
    todaySnapshot.forEach(doc => combinedMessages.push(...(doc.data().messages || [])));

    // Get Last Active Day if Today is empty or short
    if (combinedMessages.length < 5) {
        const lastSessionSnapshot = await db.collection('chatSessions')
          .where('userId', '==', userId)
          .where('updatedAt', '<', admin.firestore.Timestamp.fromDate(startOfToday))
          .orderBy('updatedAt', 'desc')
          .limit(1)
          .get();

        if (!lastSessionSnapshot.empty) {
          const lastActiveTime = lastSessionSnapshot.docs[0].data().updatedAt.toDate();
          const startLast = new Date(new Date(lastActiveTime).setHours(0, 0, 0, 0));
          const endLast = new Date(new Date(lastActiveTime).setHours(23, 59, 59, 999));
          
          const lastDayDocs = await db.collection('chatSessions')
            .where('userId', '==', userId)
            .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(startLast))
            .where('updatedAt', '<=', admin.firestore.Timestamp.fromDate(endLast))
            .get();
            
          lastDayDocs.forEach(doc => combinedMessages.push(...(doc.data().messages || [])));
        }
    }

    if (combinedMessages.length === 0) return 'لا توجد محادثات حديثة.';

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
    const sessionRef = db.collection('chatSessions').doc(sessionId);
    const storableMessages = (messages || [])
      .filter(m => m && (m.author === 'user' || m.author === 'bot' || m.role))
      .slice(-30)
      .map(m => ({
        author: m.author || m.role || 'user',
        text: m.text || m.message || '',
        timestamp: m.timestamp || new Date().toISOString(),
        type: m.type || null,
      }));

    const dataToSave = {
      userId,
      title,
      messages: storableMessages,
      type,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (context && context.lessonId) dataToSave.context = context;

    await sessionRef.set(dataToSave, { merge: true });
  } catch (error) {
    logger.error(`Error saving session ${sessionId}:`, error);
  }
}

async function analyzeAndSaveMemory(userId, newConversation) {
  try {
    const profileDoc = await getProfile(userId);
    const currentSummary = profileDoc.profileSummary || '';

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
      await db.collection('aiMemoryProfiles').doc(userId).update({
        profileSummary: parsed.updatedSummary,
        lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      cacheDel('profile', userId);
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
    const sessionsSnapshot = await db.collection('userBehaviorAnalytics').doc(userId).collection('sessions')
      .orderBy('startTime', 'desc').limit(5).get();

    if (sessionsSnapshot.empty) return;

    const recentSessions = sessionsSnapshot.docs.map(doc => doc.data());
    let totalDuration = 0;
    let totalLessonsViewed = 0;

    recentSessions.forEach(session => {
      totalDuration += session.durationSeconds || 0;
      totalLessonsViewed += session.lessonsViewedCount || 0;
    });

    const avgDuration = totalDuration / recentSessions.length;
    const engagementLevel = Math.min(1, avgDuration / 1800);

    await db.collection('aiMemoryProfiles').doc(userId).set({
      lastAnalyzedAt: new Date().toISOString(),
      behavioralInsights: {
        engagementLevel: parseFloat(engagementLevel.toFixed(2)),
      }
    }, { merge: true });

  } catch (error) {
    logger.error(`Analytics error for ${userId}:`, error.message);
  }
}

async function getOptimalStudyTime(userId) {
  try {
    const sessions = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .orderBy('updatedAt', 'desc')
      .limit(20)
      .get();

    let bestHour = 19; 
    if (!sessions.empty) {
      const hourCounts = {};
      sessions.forEach(doc => {
        const h = doc.data().updatedAt.toDate().getHours();
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

// ✅ (مدمجة ومحسنة) دالة إرسال الإشعارات

/**
 * دالة إرسال الإشعارات (الجوكر)
 * @param {string} userId
 * @param {object} notification
 * @param {string} notification.title
 * @param {string} notification.message
 * @param {string} notification.type - نوع الإشعار (chat, lesson, quiz, re_engagement)
 * @param {string} [notification.targetId] - (اختياري) ID الشيء المراد فتحه
 * @param {object} [notification.meta] - (اختياري) أي بيانات إضافية
 */
async function sendUserNotification(userId, notification) {
  const db = getFirestoreInstance();

  try {
    // 1. التخزين في الأرشيف (Inbox)
    await db.collection('userNotifications').doc(userId).collection('inbox').add({
      title: notification.title,
      message: notification.message,
      type: notification.type || 'system', // chat, lesson, quiz...
      targetId: notification.targetId || null, // ✅ نضيفه هنا ليستخدمه التطبيق عند الفتح
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: notification.meta || {} 
    });

    // 2. الإرسال للهاتف (Push Notification)
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;

      if (fcmToken) {
        // بناء الـ Data Payload الذكي
        const dataPayload = {
          click_action: 'FLUTTER_NOTIFICATION_CLICK', 
          type: notification.type || 'general',
          userId: userId,
          // ✅ نمرر targetId و meta للهاتف
          targetId: notification.targetId || '', 
        };

        // إذا كان هناك بيانات meta إضافية، نضيفها كـ Strings (لأن FCM يقبل Strings فقط في data)
        if (notification.meta) {
            Object.keys(notification.meta).forEach(k => {
                dataPayload[k] = String(notification.meta[k]);
            });
        }

        const payload = {
          notification: {
            title: notification.title,
            body: notification.message,
          },
          data: dataPayload, // البيانات التي سيقرأها التطبيق للتوجيه
          token: fcmToken
        };

        await admin.messaging().send(payload);
        logger.success(`[Notification] 📲 Push sent to ${userId} (Type: ${notification.type})`);
      }
    }

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
