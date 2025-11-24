
// services/data/helpers.js
'use strict';

const { getFirestoreInstance, admin } = require('./firestore');
const LRUCache = require('./cache'); // Assuming cache.js is in the same folder
const CONFIG = require('../../config');
const { safeSnippet } = require('../../utils');
const logger = require('../../utils/logger');

// Dependencies that need to be injected
let embeddingServiceRef;
let generateWithFailoverRef;

function initDataHelpers(dependencies) {
  if (!dependencies.embeddingService || !dependencies.generateWithFailover) {
    throw new Error('Data Helpers requires embeddingService and generateWithFailover for initialization.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Data Helpers initialized with dependencies.');
}

const db = getFirestoreInstance();

// ---------- Cache instances ----------
const DEFAULT_TTL = CONFIG.CACHE_TTL_MS || 1000 * 60 * 60;
const educationalPathCache = new LRUCache(50, DEFAULT_TTL); // 50 items, 1 hour TTL
const localCache = {
  profile: new LRUCache(200, DEFAULT_TTL),
  progress: new LRUCache(200, DEFAULT_TTL),
};

async function cacheGet(scope, key) { return localCache[scope]?.get(key) ?? null; }
async function cacheSet(scope, key, value) { return localCache[scope]?.set(key, value); }
async function cacheDel(scope, key) { return localCache[scope]?.del(key); }

// ---------------- DATA HELPERS ----------------
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

async function getProfile(userId) {
  try {
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    const doc = await db.collection('aiMemoryProfiles').doc(userId).get();
    if (doc.exists) {
      const val = doc.data();
      await cacheSet('profile', userId, val);
      return val;
    } else {
      const defaultProfile = {
        profileSummary: 'مستخدم جديد، لم يتم تحليل أي بيانات بعد.',
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

// --- NEW: Safe Progress Calculation ---
/**
 * يحسب النسبة المئوية بأمان لتجنب القسمة على صفر أو القيم غير المنطقية.
 * @param {number} completed - العدد المنجز.
 * @param {number} total - العدد الكلي.
 * @returns {number} - نسبة مئوية صحيحة بين 0 و 100.
 */
function calculateSafeProgress(completed, total) {
  // 1. التعامل مع القيم غير المعرفة أو null
  const safeCompleted = Number(completed) || 0;
  const safeTotal = Number(total) || 0;

  // 2. منع القسمة على صفر
  if (safeTotal <= 0) return 0;

  // 3. الحساب
  const percentage = (safeCompleted / safeTotal) * 100;

  // 4. التقريب وضمان الحدود (Clamping)
  return Math.min(100, Math.max(0, Math.round(percentage)));
}
async function processSessionAnalytics(userId, sessionId) {
  try {
    logger.log(`[Analytics] Processing session ${sessionId} for user ${userId}`);

    const sessionsSnapshot = await db.collection('userBehaviorAnalytics').doc(userId).collection('sessions')
      .orderBy('startTime', 'desc').limit(5).get();

    if (sessionsSnapshot.empty) {
      logger.log('[Analytics] No sessions found to process.');
      return;
    }

    const recentSessions = sessionsSnapshot.docs.map(doc => doc.data());

    let totalDuration = 0;
    let totalQuickCloses = 0;
    let totalLessonsViewed = 0;

    recentSessions.forEach(session => {
      totalDuration += session.durationSeconds || 0;
      totalQuickCloses += session.quickCloseCount || 0;
      totalLessonsViewed += session.lessonsViewedCount || 0;
    });

    const avgDuration = totalDuration / recentSessions.length;

    const procrastinationScore = totalLessonsViewed > 0 ? (totalQuickCloses / totalLessonsViewed) : 0;
    const engagementLevel = Math.min(1, avgDuration / 1800);

    const memoryProfileRef = db.collection('aiMemoryProfiles').doc(userId);
    await memoryProfileRef.set({
      lastAnalyzedAt: new Date().toISOString(),
      behavioralInsights: {
        engagementLevel: parseFloat(engagementLevel.toFixed(2)),
        procrastinationScore: parseFloat(procrastinationScore.toFixed(2)),
      }
    }, { merge: true });

    logger.log(`[Analytics] Successfully updated memory profile for user ${userId}`);

  } catch (error) {
    logger.error(`[Analytics] Error processing session for user ${userId}:`, error);
  }
}
/**
 * 🧠 العقل المدبر الليلي: يولد مهام المراجعة والدروس الجديدة
 * يتأكد من عدم تكرار المهام الموجودة حالياً في dailyTasks أو missions
 */
async function generateSmartStudyStrategy(userId) {
  const db = getFirestoreInstance();
  
  // 1. جلب كل البيانات المطلوبة دفعة واحدة
  const [progressDoc, userDoc] = await Promise.all([
    db.collection('userProgress').doc(userId).get(),
    db.collection('users').doc(userId).get()
  ]);

  if (!progressDoc.exists || !userDoc.exists) return null;

  const progress = progressDoc.data();
  const userData = userDoc.data();

  // استخراج المهام الحالية لتجنب التكرار
  const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
  const currentMissions = new Set(userData.aiDiscoveryMissions || []); // المهام السرية الحالية

  const candidates = [];
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  let hasWeaknesses = false;

  // 2. فحص المراجعة المتباعدة (Spaced Repetition)
  const pathProgress = progress.pathProgress || {};
  
  // سنبحث عن آخر درس تم الوصول إليه لنعرف أين نحن في المنهج
  let lastActiveLesson = null;

  Object.keys(pathProgress).forEach(pathId => {
    const subjects = pathProgress[pathId].subjects || {};
    Object.keys(subjects).forEach(subjId => {
      const lessons = subjects[subjId].lessons || {};
      Object.keys(lessons).forEach(lessonId => {
        const lesson = lessons[lessonId];
        
        if (lesson.status === 'completed' || lesson.status === 'current') {
           // تحديد آخر درس نشط
           if (!lastActiveLesson || new Date(lesson.lastAttempt) > new Date(lastActiveLesson.lastAttempt)) {
             lastActiveLesson = { ...lesson, id: lessonId, subjectId: subjId };
           }

           // --- منطق التكرار المتباعد ---
           if (lesson.masteryScore !== undefined) {
             const lastAttemptTime = lesson.lastAttempt ? new Date(lesson.lastAttempt).getTime() : 0;
             const daysSince = (now - lastAttemptTime) / DAY_MS;
             const score = lesson.masteryScore;
             
             let missionText = '';

             // أ) حالة الخطر (ضعف)
             if (score < 60) {
                missionText = `review_weakness:${lessonId}`; // صيغة مشفرة يفهمها الـ AI
                hasWeaknesses = true;
             } 
             // ب) حالة التثبيت (علامة جيدة لكن مر وقت)
             else if (score >= 60 && score < 85 && daysSince > 4) {
                missionText = `spaced_review_medium:${lessonId}`;
             }
             // ج) حالة الصيانة (علامة ممتازة لكن مر زمن طويل - مثلا 10 أيام)
             else if (score >= 85 && daysSince > 10) {
                missionText = `spaced_review_mastery:${lessonId}`; // "راجع بطل، راك نسيت هذي"
             }

             // 🔥 الفلتر الذكي: هل هذه المهمة موجودة بالفعل؟
             if (missionText && !currentMissions.has(missionText) && !currentDailyTasksIds.has(lessonId)) {
               candidates.push(missionText);
             }
           }
        }
      });
    });
  });

  // 3. قرار فتح درس جديد (Pacing Decision)
  // إذا لم يكن هناك "نقاط ضعف" كثيرة، والمهام قليلة، نقترح درساً جديداً
  if (!hasWeaknesses && candidates.length < 2) {
      // هنا منطق بسيط: إذا أكمل الدرس X، نقترح X+1 (يحتاج لمنطق المنهج الدراسي EducationalPath)
      // سنضيف مهمة عامة والـ AI سيعرف الدرس التالي من سياق المنهج
      const newLessonMission = "suggest_new_topic";
      if (!currentMissions.has(newLessonMission)) {
        candidates.push(newLessonMission);
      }
  }

  return candidates; // مصفوفة من السلاسل النصية: ["review_weakness:lesson1", "suggest_new_topic"]
}
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

async function fetchRecentComprehensiveChatHistory(userId) {
  try {
    const now = new Date();
    const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0));

    const todaySnapshot = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(startOfToday))
      .get();

    let combinedMessages = [];
    todaySnapshot.forEach(doc => {
      combinedMessages.push(...(doc.data().messages || []));
    });

    const lastSessionBeforeTodaySnapshot = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .where('updatedAt', '<', admin.firestore.Timestamp.fromDate(startOfToday))
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();

    if (!lastSessionBeforeTodaySnapshot.empty) {
      const lastActiveTimestamp = lastSessionBeforeTodaySnapshot.docs[0].data().updatedAt.toDate();
      const startOfLastActiveDay = new Date(new Date(lastActiveTimestamp).setHours(0, 0, 0, 0));
      const endOfLastActiveDay = new Date(new Date(lastActiveTimestamp).setHours(23, 59, 59, 999));

      const lastDaySnapshot = await db.collection('chatSessions')
        .where('userId', '==', userId)
        .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(startOfLastActiveDay))
        .where('updatedAt', '<=', admin.firestore.Timestamp.fromDate(endOfLastActiveDay))
        .get();

      lastDaySnapshot.forEach(doc => {
        combinedMessages.push(...(doc.data().messages || []));
      });
    }

    if (combinedMessages.length === 0) {
      return 'لا توجد محادثات حديثة.';
    }

    combinedMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const recentTranscript = combinedMessages
      .slice(-50)
      .map(m => `${m.author === 'bot' ? 'EduAI' : 'User'}: ${m.text}`)
      .join('\n');

    return recentTranscript;

  } catch (error) {
    logger.error(`Error fetching comprehensive chat history for ${userId}:`, error);
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

    if (context && context.lessonId) {
      dataToSave.context = context;
    }

    await sessionRef.set(dataToSave, { merge: true });

  } catch (error) {
    logger.error(`Error saving chat session ${sessionId}:`, error);
  }
}

async function analyzeAndSaveMemory(userId, newConversation) {
  try {
    const profileDoc = await getProfile(userId);
    const currentSummary = profileDoc.profileSummary || '';

    const prompt = `You are a psychological and educational analyst AI. Your task is to update a student's long-term memory profile based on a new conversation.

    **Current Profile Summary:**
    "${currentSummary}"

    **New Conversation Transcript (User and EduAI):**
    ${newConversation.map(m => `${m.author === 'bot' ? 'EduAI' : 'User'}: ${m.text}`).join('\n')}

    **Instructions:**
    1. Read the new conversation.
    2. Identify ANY new personal information, goals, struggles, preferences, or significant events.
    3. Integrate this new information into the existing profile summary to create an updated, concise, and coherent summary in english.
    4. Do not repeat information already in the summary.
    5. Respond ONLY with a valid JSON object: { "updatedSummary": "..." }`;

    if (!generateWithFailoverRef) {
      logger.error('analyzeAndSaveMemory: generateWithFailover is not set.');
      return;
    }
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryAnalyst' });
    // This helper also needs to be injected or imported
    const { extractTextFromResult, ensureJsonOrRepair } = require('../../utils'); // Assuming utils has these
    const raw = await extractTextFromResult(res);
    const parsed = await ensureJsonOrRepair(raw, 'analysis');

    if (parsed && parsed.updatedSummary) {
      await db.collection('aiMemoryProfiles').doc(userId).update({
        profileSummary: parsed.updatedSummary,
        lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      cacheDel('profile', userId); // Invalidate cache
    }
  } catch (err) {
    logger.error(`Failed to analyze memory for user ${userId}:`, err);
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

async function sendUserNotification(userId, payload = {}) {
  if (!userId) return;
  
  const title = payload.title || 'تنبيه من EduAI';
  const message = payload.message || '';
  const type = payload.type || 'system';
  const meta = payload.meta || {};

  try {
    // 1. الحفظ في قاعدة البيانات (ليظهر في قائمة الإشعارات داخل التطبيق)
    // هذا الجزء كان موجوداً ويعمل
    await db.collection('userNotifications').doc(userId).collection('inbox').add({
      title: title,
      message: message,
      type: type,
      meta: meta,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    logger.log(`[Notification] Saved to DB for user ${userId}`);

    // 2. الإرسال للهاتف (Push Notification via FCM) 🔥 هذا هو الجديد
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken; // ⚠️ تأكد أن التطبيق يحفظ التوكن بهذا الاسم

      if (fcmToken) {
        await admin.messaging().send({
          token: fcmToken,
          notification: {
            title: title,
            body: message,
          },
          data: {
            click_action: 'FLUTTER_NOTIFICATION_CLICK', // مهم لتطبيقات Flutter
            type: type,
            // يجب تحويل أي بيانات في meta إلى String لأن FCM لا يقبل JSON متداخل
            ...Object.keys(meta).reduce((acc, key) => {
              acc[key] = String(meta[key]); 
              return acc;
            }, {})
          }
        });
        logger.success(`[Notification] 📲 Push sent to user ${userId}`);
      } else {
        logger.warn(`[Notification] User ${userId} has no fcmToken. Saved to DB only.`);
      }
    }

  } catch (err) {
    logger.error(`sendUserNotification failed for ${userId}:`, err.message);
  }
}
async function sendUserNotification(userId, payload = {}) {
  if (!userId) return;

  const title = payload.title || 'EduAI';
  const message = payload.message || '';
  const type = payload.type || 'system';
  const meta = payload.meta || {};

  try {
    // 1. حفظ الإشعار في قاعدة البيانات (لأرشيف التطبيق)
    await db.collection('userNotifications').doc(userId).collection('inbox').add({
      title: title,
      message: message,
      type: type,
      meta: meta,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    logger.log(`[Notification] Saved to DB for user ${userId}`);

    // 2. جلب التوكن الخاص بالمستخدم
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      logger.warn(`[Notification] User ${userId} not found.`);
      return;
    }

    const userData = userDoc.data();
    const fcmToken = userData.fcmToken; // ✅ هذا الاسم يطابق الكود الذي أرسلته لي

    if (!fcmToken) {
      logger.log(`[Notification] No FCM Token for user ${userId} (User might be offline/logged out).`);
      return;
    }

    // 3. تجهيز رسالة FCM
    // تحويل الـ meta إلى String لأن FCM لا يقبل JSON متداخل في الـ data
    const stringifiedMeta = Object.keys(meta).reduce((acc, key) => {
      acc[key] = String(meta[key]);
      return acc;
    }, {});

    const messagePayload = {
      token: fcmToken,
      notification: {
        title: title,
        body: message,
      },
      // بيانات إضافية للتعامل معها برمجياً عند الضغط على الإشعار
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        type: type,
        userId: userId,
        ...stringifiedMeta
      },
      // إعدادات أندرويد لضمان الوصول
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'eduai_alerts', // تأكد من إنشاء هذه القناة في الفرونت إند
        }
      },
      // إعدادات iOS
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          }
        }
      }
    };

    // 4. الإرسال الفعلي
    await admin.messaging().send(messagePayload);
    logger.success(`[Notification] 📲 Push sent successfully to ${userId}`);

  } catch (err) {
    // التعامل مع التوكنات منتهية الصلاحية
    if (err.code === 'messaging/registration-token-not-registered') {
      logger.warn(`[Notification] Token invalid for user ${userId}. Removing from DB.`);
      await db.collection('users').doc(userId).update({
        fcmToken: admin.firestore.FieldValue.delete()
      });
    } else {
      logger.error(`[Notification] Failed to send push: ${err.message}`);
    }
  }
}
/**
 * 🕰️ خوارزمية الوقت الذهبي
 * تبحث في تاريخ المستخدم لتجد الساعة المفضلة لديه للدراسة
 */
async function getOptimalStudyTime(userId) {
  try {
    // 1. نفترض أن لديك كوليكشن analytics_logs (أو نستخدم أوقات الرسائل في chatSessions كبديل سريع)
    // هنا سنستخدم chatSessions لأنها ممتلئة بالبيانات بالفعل
    const sessions = await db.collection('chatSessions')
      .where('userId', '==', userId)
      .orderBy('updatedAt', 'desc')
      .limit(20) // نحلل آخر 20 جلسة
      .get();

    let bestHour = 19; // الافتراضي: 7 مساءً

    if (!sessions.empty) {
      const hourCounts = {};
      
      sessions.forEach(doc => {
        // نأخذ توقيت آخر رسالة
        const date = doc.data().updatedAt.toDate();
        // نأخذ الساعة (0-23)
        const h = date.getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      });

      // إيجاد الساعة الأكثر تكراراً
      bestHour = Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b);
    }

    // 2. تجهيز تاريخ الغد في هذه الساعة
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1); // غداً
    targetDate.setHours(parseInt(bestHour), 0, 0, 0); // في الساعة المفضلة

    // 3. (تحسين بسيط) إذا كانت الساعة المفضلة ميتة (مثل 3 صباحاً)، نجعلها 8 مساءً
    if (targetDate.getHours() >= 0 && targetDate.getHours() < 6) {
        targetDate.setHours(20, 0, 0, 0);
    }

    return targetDate;

  } catch (err) {
    logger.error('Error calculating optimal time:', err);
    // Fallback
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0);
    return d;
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
  generateSmartStudyStrategy
};
