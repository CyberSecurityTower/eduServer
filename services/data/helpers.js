// services/data/helpers.js
'use strict';

const supabase = require('./supabase');
const { toCamelCase, toSnakeCase, nowISO } = require('./dbUtils');
const LRUCache = require('./cache'); 
const CONFIG = require('../../config');
const { safeSnippet, extractTextFromResult, ensureJsonOrRepair } = require('../../utils');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const { runPlannerManager } = require('../ai/managers/plannerManager'); 
const { getAlgiersTimeContext } = require('../../utils'); // تأكد من المسار

// Dependencies Injection
let embeddingServiceRef;
let generateWithFailoverRef;

function initDataHelpers(dependencies) {
  if (!dependencies.embeddingService || !dependencies.generateWithFailover) {
    throw new Error('Data Helpers requires embeddingService and generateWithFailover.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Data Helpers initialized (Native Supabase Mode 🚀).');
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
    const profile = await getProfile(userId);
    return profile.facts?.firstName || 'Student';
  } catch (err) {
    return 'Student';
  }
}

async function getProfile(userId) {
  try {
    // 1. الكاش أولاً
    const cached = await cacheGet('profile', userId);
    if (cached) return cached;

    // 2. Native Supabase Query (Parallel)
    const [memoryRes, userRes] = await Promise.all([
      supabase.from('ai_memory_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('users').select('date_of_birth, first_name, gender, role, selected_path_id').eq('id', userId).single()
    ]);

    const memoryData = memoryRes.data || { facts: {}, profile_summary: '' };
    const userData = userRes.data || {};

    // حساب العمر
    let age = 'Unknown';
    if (userData.date_of_birth) {
      const dob = new Date(userData.date_of_birth);
      const diffMs = Date.now() - dob.getTime();
      const ageDate = new Date(diffMs);
      age = Math.abs(ageDate.getUTCFullYear() - 1970);
    }

    // دمج البيانات
    const finalProfile = {
      userId: userId,
      profileSummary: memoryData.profile_summary,
      aiAgenda: memoryData.ai_agenda,
      emotionalState: memoryData.emotional_state,
      facts: {
        ...(memoryData.facts || {}),
        age: age,
        firstName: userData.first_name,
        gender: userData.gender,
        role: userData.role
      },
      selectedPathId: userData.selected_path_id // ✅ إضافة مهمة للتوجيه
    };

    // تحديث الكاش
    await cacheSet('profile', userId, finalProfile);
    return finalProfile;

  } catch (err) {
    logger.error('getProfile Native Error:', err.message);
    return { facts: {} };
  }
}

// ============================================================================
// 2. Progress & Educational Paths
// ============================================================================

async function getProgress(userId) {
  try {
    const cached = await cacheGet('progress', userId);
    if (cached) return cached;

    // استعلام مباشر
    const { data, error } = await supabase
      .from('user_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
        logger.error('Supabase Progress Error:', error.message);
    }

    let val = { stats: { points: 0 }, streakCount: 0, pathProgress: {}, dailyTasks: { tasks: [] } };

    if (data) {
      // دعم الهيكلية القديمة (JSONB data) والجديدة (أعمدة منفصلة)
      if (data.data) {
        val = { ...val, ...data.data };
      } else {
        val = {
            stats: data.stats || val.stats,
            streakCount: data.streak_count || 0,
            pathProgress: data.path_progress || {},
            dailyTasks: data.daily_tasks || { tasks: [] }
        };
      }
    }

    await cacheSet('progress', userId, val);
    return val;

  } catch (err) {
    logger.error('getProgress Native Error:', err.message);
    return { stats: { points: 0 }, dailyTasks: { tasks: [] } };
  }
}

async function formatProgressForAI(userId) {
  try {
    const progress = await getProgress(userId); 
    const userProgressData = progress.pathProgress || {};
    
    if (Object.keys(userProgressData).length === 0) return 'User has not started any educational path yet.';

    const summaryLines = [];
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
      const { data: userData } = await supabase.from('users').select('selected_path_id, ai_discovery_missions').eq('id', userId).single();
      
      if (!userData) return [];
      
      const currentMissions = new Set(userData.ai_discovery_missions || []);
      const currentDailyTasksIds = new Set((progress.dailyTasks?.tasks || []).map(t => t.relatedLessonId).filter(Boolean));
      
      const candidates = [];
      const pathProgress = progress.pathProgress || {};

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
// 4. Chat History & Memory Logic
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
        author: m.role === 'model' ? 'bot' : m.role,
        text: m.text,
        timestamp: m.timestamp || nowISO(),
        type: m.type || 'text'
    }));

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
    if (error) {
        console.error("🚨 Error saving chat:", error.message);
    }
  } catch (error) {
    console.error(`Error saving session:`, error);
  }
}

async function analyzeAndSaveMemory(userId, history) {
  try {
      if (!generateWithFailoverRef) return;
      
      const profile = await getProfile(userId);
      const currentSummary = profile.profileSummary || '';
      
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
          await supabase.from('ai_memory_profiles').upsert({
              user_id: userId,
              profile_summary: parsed.updatedSummary,
              last_updated_at: nowISO()
          });
          await cacheDel('profile', userId);
      }
  } catch (e) {
      logger.warn('Memory Analysis Failed:', e.message);
  }
}

async function processSessionAnalytics(userId, sessionId) {
  try {
      await supabase.from('users').update({
          last_active_at: nowISO()
      }).eq('id', userId);
  } catch (e) {
      // ignore
  }
}

// ============================================================================
// 5. Notifications (Expo Push + Inbox)
// ============================================================================

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
    const type = notification.type || NOTIF_TYPES.SYSTEM;
    const meta = notification.meta || {};

    if ((type === NOTIF_TYPES.NEW_LESSON || type === NOTIF_TYPES.LESSON) && !meta.targetId) {
        console.warn(`⚠️ Warning: Notification of type '${type}' sent without 'targetId'.`);
    }

    // 1. Save to Inbox
    await supabase.from('user_notifications').insert({
        user_id: userId,
        box_type: 'inbox',
        title: notification.title,
        message: notification.message,
        type: type,
        target_id: meta.targetId || null,
        read: false,
        created_at: nowISO(),
        meta: meta
    });

    // 2. Send Push
    const { data: user } = await supabase
        .from('users')
        .select('fcm_token')
        .eq('id', userId)
        .single();

    if (!user || !user.fcm_token) return;
    const pushToken = user.fcm_token;

    if (!pushToken.startsWith('ExponentPushToken')) return;

    const message = {
      to: pushToken,
      sound: 'default',
      title: notification.title,
      body: notification.message,
      priority: 'high',
      data: {
        type: type, 
        targetId: meta.targetId,
        subjectId: meta.subjectId,
        actionId: meta.actionId || crypto.randomUUID(),
        ...meta
      }
    };

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([message]),
    });

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
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  return d;
}

async function scheduleSpacedRepetition(userId, topic, daysDelay) {
  const triggerDate = new Date();
  triggerDate.setDate(triggerDate.getDate() + daysDelay);
  
  const { data } = await supabase.from('ai_memory_profiles').select('ai_agenda').eq('user_id', userId).single();
  let agenda = data?.ai_agenda || [];
  
  const newTask = {
      id: `review_${Date.now()}`,
      type: 'spaced_review',
      content: `Ask the user a quick review question about: "${topic}" to test their memory.`,
      triggerDate: triggerDate.toISOString(),
      status: 'pending'
  };
  
  agenda.push(newTask);
  
  await supabase.from('ai_memory_profiles').update({ ai_agenda: agenda }).eq('user_id', userId);
  logger.info(`[Spaced Repetition] Scheduled review for ${topic} in ${daysDelay} days.`);
}

async function updateAiAgenda(userId, newAgenda) {
    return supabase
        .from('ai_memory_profiles')
        .update({ ai_agenda: newAgenda, last_updated_at: new Date().toISOString() })
        .eq('user_id', userId);
}

// ============================================================================
// 6. Task Management (Gravity Engine Integration)
// ============================================================================

/**
 * 🔥 دالة التحديث الشامل للمهام (God Mode)
 * تقوم بحذف المهام المعلقة القديمة واستبدالها بخطة الجاذبية الجديدة
 */
async function refreshUserTasks(userId) {
  try {
    logger.info(`🔄 Refreshing tasks for user: ${userId}...`);

    // 1. حذف المهام القديمة المعلقة (Pending) فقط
    // لا نحذف المكتملة لنحتفظ بالسجل، ولا نحذف ما كتبه المستخدم
    const { error: deleteError } = await supabase
      .from('user_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'pending')
      .neq('type', 'user_created');

    if (deleteError) {
        logger.error('Error clearing old tasks:', deleteError.message);
    }

    // 2. تشغيل محرك الجاذبية لحساب أفضل المهام حالياً
    const plan = await runPlannerManager(userId);
    const newTasks = plan.tasks || [];

    if (newTasks.length === 0) return [];

    // 3. تجهيز البيانات للإدخال
    const tasksToInsert = newTasks.map(t => ({
      user_id: userId,
      title: t.title,
      type: t.type || 'study',
      priority: 'high',
      status: 'pending',
      
      // 🔥 تخزين البيانات كاملة في الـ Meta ليقرأها الفرونت أند
      meta: { 
        relatedLessonId: t.meta.relatedLessonId,
        subjectId: t.meta.relatedSubjectId,    
        lessonTitle: t.meta.relatedLessonTitle, 
        score: t.score,
        source: 'gravity_engine'
      },
      created_at: new Date().toISOString()
    }));

    // 4. إدخال المهام الجديدة
    const { data } = await supabase.from('user_tasks').insert(tasksToInsert).select();
    
    // 🔥🔥🔥 الإصلاح هنا: تفجير الكاش لإجبار النظام على قراءة الجديد
    await cacheDel('progress', userId); 
    await cacheDel('profile', userId); // لأن الأجندة قد تكون مخزنة هنا أيضاً
    
    logger.success(`✅ Tasks refreshed & Cache cleared for ${userId}`);
    return data || [];

  } catch (err) {
    logger.error('refreshUserTasks Failed:', err.message);
    return [];
  }
}

/**
 * 🌉 جسر الذاكرة: يجلب سياق آخر محادثة للمستخدم
 * لربط الجلسات ببعضها إذا كانت قريبة زمنياً
 */
async function getLastActiveSessionContext(userId, currentSessionId) {
  try {
    // نجلب آخر جلسة تم تحديثها لهذا المستخدم (غير الجلسة الحالية)
    const { data: lastSession } = await supabase
      .from('chat_sessions')
      .select('messages, updated_at')
      .eq('user_id', userId)
      .neq('id', currentSessionId) // لا نريد الجلسة الحالية الفارغة
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (!lastSession || !lastSession.messages) return null;

    // التحقق من الزمن: هل المحادثة "طازجة"؟ (مثلاً أقل من ساعة)
    const lastTime = new Date(lastSession.updated_at).getTime();
    const now = Date.now();
    const diffMinutes = (now - lastTime) / (1000 * 60);

    // إذا مر أكثر من ساعتين، نعتبرها جلسة قديمة ولا ندمجها (نبدأ جديد)
    // يمكنك تعديل الرقم حسب رغبتك (مثلاً 120 دقيقة)
    if (diffMinutes > 120) return null; 

    // نأخذ آخر 6 رسائل فقط لتوفير السياق
    const recentMessages = lastSession.messages.slice(-6).map(m => ({
        role: m.author === 'bot' ? 'model' : 'user',
        text: m.text,
        timestamp: m.timestamp
    }));

    return { messages: recentMessages, timeSince: diffMinutes };

  } catch (err) {
    return null;
  }
}

/**
 * 📅 دالة الوعي بالجدول الزمني
 * تحدد هل الطالب في حصة، أو خرج للتو، أو لديه حصة قادمة
 */
async function getStudentScheduleStatus(groupId) {
  if (!groupId) return null;

  try {
    // 1. معرفة الوقت الحالي في الجزائر
    const algiersCtx = getAlgiersTimeContext(); // { dayName: 'Sunday', hour: 9, minute: 30 ... }
    
    // نحتاج تحويل الوقت الحالي إلى صيغة مقارنة (دقائق منذ منتصف الليل)
    const now = new Date();
    
    const currentHour = algiersCtx.hour;

    // 🛑 1. حماية الليل (Night Guard)
    // إذا كانت الساعة بين 8 ليلاً و 6 صباحاً، مستحيل تكون هناك حصة!
    if (currentHour >= 20 || currentHour < 6) {
        return {
            state: 'night_time',
            context: `🌑 **STATUS:** It is Night Time (${algiersCtx.fullTime}). NO CLASSES NOW. The student is likely at home/dorm.`
        };
    }
    // ملاحظة: getAlgiersTimeContext تعطينا الساعة، لكن للمقارنة الدقيقة نحتاج Date object
    // للتبسيط سنفترض أن السيرفر مضبوط أو نستخدم Intl كما في الدالة السابقة
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Algiers',
        hour12: false,
        weekday: 'long',
        hour: 'numeric',
        minute: 'numeric'
    });
    const parts = formatter.formatToParts(now);
    const currentDay = parts.find(p => p.type === 'weekday').value; // e.g., "Sunday"
    const currentHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const currentMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const currentTotalMinutes = (currentHour * 60) + currentMinute;

    // 2. جلب جدول اليوم لهذا الفوج
    const { data: schedule } = await supabase
      .from('group_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('day_of_week', currentDay)
      .order('start_time', { ascending: true });
    // 🛑 2. حماية الجدول الفارغ (Empty Schedule)
    if (!schedule || schedule.length === 0) {
        return { 
            state: 'no_data', 
            context: `📅 **STATUS:** No schedule data found for today. Assume the student is FREE or studying on their own.` 
        };
    }
    if (!schedule || schedule.length === 0) return { status: 'free_day', message: 'No classes today.' };

    let currentSession = null;
    let lastSession = null;
    let nextSession = null;

    for (const session of schedule) {
      // تحويل وقت الحصة إلى دقائق
      const [startH, startM] = session.start_time.split(':').map(Number);
      const [endH, endM] = session.end_time.split(':').map(Number);
      
      const startTotal = (startH * 60) + startM;
      const endTotal = (endH * 60) + endM;

      if (currentTotalMinutes >= startTotal && currentTotalMinutes <= endTotal) {
        currentSession = session;
      } else if (currentTotalMinutes > endTotal) {
        lastSession = session; // آخر حصة انتهت
      } else if (currentTotalMinutes < startTotal && !nextSession) {
        nextSession = session; // أول حصة قادمة
      }
    }

    // 3. صياغة السياق للذكاء الاصطناعي
    if (currentSession) {
      return {
        state: 'in_class',
        subject: currentSession.subject_name,
        type: currentSession.type,
        room: currentSession.room,
        context: `🚨 **REAL-TIME ALERT:** The student is CURRENTLY in a class: "${currentSession.subject_name}" (${currentSession.type}) in ${currentSession.room}.`
      };
    } else if (lastSession && (currentTotalMinutes - ((parseInt(lastSession.end_time.split(':')[0])*60) + parseInt(lastSession.end_time.split(':')[1]))) < 60) {
      // إذا انتهت الحصة منذ أقل من ساعة
      return {
        state: 'just_finished',
        subject: lastSession.subject_name,
        context: `ℹ️ **CONTEXT:** The student JUST finished "${lastSession.subject_name}". Ask them how it went!`
      };
    } else {
      return {
        state: 'free_time',
        next: nextSession ? nextSession.subject_name : 'No more classes',
        context: 'Student is currently free from university schedule.'
      };
    }

  } catch (err) {
    console.error('Schedule Helper Error:', err);
    return null;
  }
}
module.exports = {
  initDataHelpers,
  getUserDisplayName,
  getProfile,
  getProgress,
  formatProgressForAI,
  getCachedEducationalPathById,
  fetchUserWeaknesses,
  getSpacedRepetitionCandidates,
  generateSmartStudyStrategy,
  fetchRecentComprehensiveChatHistory,
  saveChatSession,
  analyzeAndSaveMemory,
  processSessionAnalytics,
  sendUserNotification,
  calculateSafeProgress,
  getOptimalStudyTime,
  scheduleSpacedRepetition,
  updateAiAgenda,
  refreshUserTasks, 
  cacheDel,
  getLastActiveSessionContext ,
  getStudentScheduleStatus
};
