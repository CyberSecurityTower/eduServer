
// services/data/helpers.js
'use strict';

const supabase = require('./supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('./dbUtils');
const LRUCache = require('./cache'); 
const CONFIG = require('../../config');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../utils');
const logger = require('../../utils/logger');
const crypto = require('crypto'); // مهم لتوليد IDs

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
    // 1. نحاول جلب البروفايل من الكاش
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    // 2. نجلب بيانات الذاكرة (AI Memory) + بيانات المستخدم الأساسية (Users Table)
    // نستخدم Promise.all للسرعة
    const [memoryResult, userResult] = await Promise.all([
      supabase.from('ai_memory_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('users').select('date_of_birth, first_name, gender').eq('id', userId).single()
    ]);

    const memoryData = memoryResult.data || { facts: {}, profileSummary: '' };
    const userData = userResult.data || {};

    // 3. 🔥 حساب العمر (The Age Fix) 🔥
    let age = 'Unknown';
    if (userData.date_of_birth) {
      const dob = new Date(userData.date_of_birth);
      const diffMs = Date.now() - dob.getTime();
      const ageDate = new Date(diffMs);
      age = Math.abs(ageDate.getUTCFullYear() - 1970);
    }

    // 4. دمج البيانات
    let finalProfile = toCamelCase(memoryData);
    if (!finalProfile.facts) finalProfile.facts = {};

    // حقن المعلومات الأساسية في الحقائق (Facts) ليراها الـ AI
    finalProfile.facts.age = age;
    finalProfile.facts.firstName = userData.first_name;
    finalProfile.facts.gender = userData.gender;

    // حفظ في الكاش
    await cacheSet('profile', userId, finalProfile);
    
    return finalProfile;

  } catch (err) {
    logger.error('getProfile error:', err.message);
    return { profileSummary: 'Error fetching profile.', facts: {} };
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
      .eq('user_id', userId)
      .single();

    if (data) {
      let val = toCamelCase(data);
      // 🔥 UNWRAP: فك عمود 'data' لأنه JSONB يحتوي على كل شيء
      if (val.data) {
          val = { ...val, ...val.data };
      }
      await cacheSet('progress', userId, val);
      return val;
    }
  } catch (err) {
    logger.error('getProgress error:', err.message);
  }
  return { stats: { points: 0 }, streakCount: 0, pathProgress: {}, dailyTasks: { tasks: [] } };
}

async function formatProgressForAI(userId) {
  try {
    const progress = await getProgress(userId); 
    const userProgressData = progress.pathProgress || {};
    
    if (Object.keys(userProgressData).length === 0) return 'User has not started any educational path yet.';

    const summaryLines = [];
    // نستخدم Set لتجنب تكرار الطلبات
    const requestedPaths = new Set(Object.keys(userProgressData));

    for (const pathId of requestedPaths) {
      const educationalPath = await getCachedEducationalPathById(pathId);
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
    const progress = await getProgress(userId);
    const userProgressData = progress.pathProgress || {};
    const weaknesses = [];

    for (const pathId in userProgressData) {
      const educationalPath = await getCachedEducationalPathById(pathId);
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
    logger.error('fetchUserWeaknesses error:', err.message);
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
          // يجب أن يكون الدرس مكتملاً وله درجة
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
    logger.error('Error in Spaced Repetition:', error.message);
    return [];
  }
}

async function generateSmartStudyStrategy(userId) {
  try {
      const progress = await getProgress(userId);
      // جلب Path ID من جدول Users
      const { data: userData } = await supabase.from('users').select('selected_path_id, ai_discovery_missions').eq('id', userId).single();
      
      if (!userData) return [];
      
      const currentMissions = new Set(userData.ai_discovery_missions || []);
      const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
      
      const candidates = [];
      const pathProgress = progress.pathProgress || {};

      // منطق بسيط: البحث عن نقاط الضعف
      Object.keys(pathProgress).forEach(pId => {
        const subjects = pathProgress[pId].subjects || {};
        Object.keys(subjects).forEach(subjId => {
          const lessons = subjects[subjId].lessons || {};
          Object.keys(lessons).forEach(lessonId => {
            const lesson = lessons[lessonId];
            if (lesson.masteryScore !== undefined && lesson.masteryScore < 65) {
                 const missionText = `review_weakness:${lessonId}|${lesson.title || 'درس'}`; 
                 if (!currentMissions.has(missionText) && !currentDailyTasksIds.has(lessonId)) {
                   candidates.push(missionText);
                 }
            }
          });
        });
      });
      return candidates;
  } catch (e) {
      logger.error('Strategy Error', e.message);
      return [];
  }
}

// ============================================================================
// 4. Chat History & Memory Logic (كانت ناقصة سابقاً)
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
        if (Array.isArray(doc.messages)) {
            combinedMessages.push(...doc.messages);
        }
      });
    }

    if (combinedMessages.length === 0) return 'لا توجد محادثات حديثة.';
    
    // ترتيب زمني
    combinedMessages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

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
    const storableMessages = (messages || []).slice(-30).map(m => ({
        author: m.role === 'model' ? 'bot' : m.role, // توحيد التسميات
        text: m.text,
        timestamp: m.timestamp || nowISO(),
        type: m.type || 'text'
    }));

    const payload = {
      id: sessionId,
      user_id: userId,
      title: title,
      messages: storableMessages, // JSONB array
      type: type,
      context: context, 
      updated_at: nowISO(),
    };
    const { error } = await supabase.from('chat_sessions').upsert(payload);
    if (error) {
        console.error("🚨 كارثة في حفظ الشات:", error.message); // سيطبع لك السبب الحقيقي
        console.error("Payload:", payload); // لترى ماذا حاولت أن ترسل
    } else {
        console.log("✅ تم حفظ الشات بنجاح ID:", sessionId);
    }

  } catch (error) {
    console.error(`Error saving session:`, error);
  }
}

// 🔥 تم ملء هذه الدالة الآن بشكل كامل
async function analyzeAndSaveMemory(userId, history) {
  try {
      if (!generateWithFailoverRef) return;
      
      const profile = await getProfile(userId);
      const currentSummary = profile.profileSummary || '';
      
      // نأخذ آخر جزء من المحادثة
      const recentChat = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');

      const prompt = `
      You are an AI Memory Analyst. Update the user's profile summary based on the new chat.
      Current Profile: "${safeSnippet(currentSummary, 500)}"
      New Chat:
      ${recentChat}
      
      Instructions:
      - Merge new facts (names, goals, struggles) into the profile.
      - Keep it concise (max 100 words).
      - Output JSON ONLY: { "updatedSummary": "..." }
      `;

      const res = await generateWithFailoverRef('analysis', prompt, { label: 'MemoryUpdate' });
      const text = await extractTextFromResult(res);
      const parsed = await ensureJsonOrRepair(text, 'analysis');

      if (parsed && parsed.updatedSummary) {
          // تحديث Supabase
          await supabase.from('ai_memory_profiles').upsert({
              user_id: userId,
              profile_summary: parsed.updatedSummary,
              last_updated_at: nowISO()
          });
          // تنظيف الكاش
          await cacheDel('profile', userId);
      }
  } catch (e) {
      logger.warn('Memory Analysis Failed:', e.message);
  }
}

// 🔥 تم ملء هذه الدالة الآن
async function processSessionAnalytics(userId, sessionId) {
  // هذه الدالة يمكن تطويرها لاحقاً لحساب مدة الجلسة بدقة
  // حالياً سنكتفي بتحديث "وقت آخر نشاط"
  try {
      await supabase.from('users').update({
          last_active_at: nowISO() // تأكد من وجود هذا العمود أو تجاهل الخطوة
      }).eq('id', userId);
  } catch (e) {
      // ignore
  }
}

// ============================================================================
// 5. Notifications (Expo Push + Inbox)
// ============================================================================

// تعريف الأنواع لضمان عدم الخطأ في الكتابة (اختياري لكن مفيد)
const NOTIF_TYPES = {
  NEW_LESSON: 'new_lesson',
  LESSON: 'lesson',
  TASK_REMINDER: 'task_reminder',
  TASKS: 'tasks',
  QUIZ_REMINDER: 'quiz_reminder',
  QUIZ: 'quiz',
  SYSTEM: 'system',
  ALERT: 'alert',
  CHAT: 'chat'
};

async function sendUserNotification(userId, notification) {
  try {
    // 1. التحقق من البيانات المطلوبة حسب الـ Cheat Sheet
    const type = notification.type || NOTIF_TYPES.SYSTEM;
    const meta = notification.meta || {};

    // تحقق خاص لدرس جديد (يجب توفر المعرفات)
    if ((type === NOTIF_TYPES.NEW_LESSON || type === NOTIF_TYPES.LESSON) && !meta.targetId) {
        console.warn(`⚠️ Warning: Notification of type '${type}' sent without 'targetId'. Navigation might fail.`);
    }

    // 2. الحفظ في قاعدة البيانات (Inbox)
    // نحفظ البيانات الخام كما هي ليتم عرضها في صفحة الإشعارات داخل التطبيق
    await supabase.from('user_notifications').insert({
        user_id: userId,
        box_type: 'inbox',
        title: notification.title,
        message: notification.message,
        type: type,
        target_id: meta.targetId || null, // مهم جداً للتنقل
        read: false,
        created_at: nowISO(),
        meta: meta // نحفظ باقي البيانات هنا
    });

    // 3. الإرسال عبر Expo Push Notification
    const { data: user } = await supabase
        .from('users')
        .select('fcm_token')
        .eq('id', userId)
        .single();

    if (!user || !user.fcm_token) return;
    const pushToken = user.fcm_token;

    if (!pushToken.startsWith('ExponentPushToken')) return;

    // تجهيز الـ Payload حسب الجدول
    const message = {
      to: pushToken,
      sound: 'default',
      title: notification.title,
      body: notification.message,
      priority: 'high',
      data: {
        // هذه البيانات هي التي يقرأها الفرونت أند للتوجيه
        type: type, 
        targetId: meta.targetId, // (Lesson ID)
        subjectId: meta.subjectId, // (Subject ID)
        actionId: meta.actionId || crypto.randomUUID(),
        ...meta // دمج أي بيانات إضافية
      }
    };

    // الإرسال الفعلي
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([message]),
    });

    // logger.success(`[Notification] Sent '${type}' to ${userId}`);

  } catch (error) {
    logger.error(`[Notification] Error for ${userId}:`, error.message);
  }
}
function calculateSafeProgress(completed, total) {
  const c = Number(completed) || 0;
  const t = Number(total) || 1;
  return Math.min(100, Math.round((c / t) * 100));
}

async function getOptimalStudyTime(userId) {
  // منطق بسيط: العودة بـ 8 مساءً
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  return d;
}

async function scheduleSpacedRepetition(userId, topic, daysDelay) {
  const db = require('./firestore').getFirestoreInstance(); // أو Supabase مباشرة
  
  // حساب التاريخ القادم
  const triggerDate = new Date();
  triggerDate.setDate(triggerDate.getDate() + daysDelay);
  
  // إضافة المهمة إلى "أجندة الـ AI" وليس كإشعار Push
  // لأننا نريد أن يسأله الـ AI في الشات: "شفيت على الدرس الفلاني؟"
  
  // 1. نجلب الأجندة الحالية
  const { data } = await supabase.from('ai_memory_profiles').select('ai_agenda').eq('user_id', userId).single();
  let agenda = data?.ai_agenda || [];
  
  // 2. نضيف مهمة المراجعة
  const newTask = {
      id: `review_${Date.now()}`,
      type: 'spaced_review',
      content: `Ask the user a quick review question about: "${topic}" to test their memory.`,
      triggerDate: triggerDate.toISOString(),
      status: 'pending'
  };
  
  agenda.push(newTask);
  
  // 3. نحفظ
  await supabase.from('ai_memory_profiles').update({ ai_agenda: agenda }).eq('user_id', userId);
  
  logger.info(`[Spaced Repetition] Scheduled review for ${topic} in ${daysDelay} days.`);
}
async function updateAiAgenda(userId, newAgenda) {
    return supabase
        .from('ai_memory_profiles')
        .update({ ai_agenda: newAgenda, last_updated_at: new Date().toISOString() })
        .eq('user_id', userId);
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
  getOptimalStudyTime,
  scheduleSpacedRepetition,
  updateAiAgenda   
};
