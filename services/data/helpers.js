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

/**
 * حساب الإحصائيات الأكاديمية للمسار
 */
async function getAcademicStats(pathId, completedLessonIdsSet) {
  try {
    // نستخدم الكاش للمسار التعليمي لتجنب الضغط على القاعدة
    const pathData = await getCachedEducationalPathById(pathId);
    if (!pathData || !pathData.subjects) return null;

    let totalLessons = 0;
    let totalCompleted = 0;
    let subjectStats = {};

    pathData.subjects.forEach(subject => {
      const subjectLessons = subject.lessons || [];
      const subTotal = subjectLessons.length;
      let subCompleted = 0;

      subjectLessons.forEach(l => {
        if (completedLessonIdsSet.has(l.id)) subCompleted++;
      });

      totalLessons += subTotal;
      totalCompleted += subCompleted;

      subjectStats[subject.title] = {
        total: subTotal,
        done: subCompleted,
        percentage: subTotal > 0 ? Math.round((subCompleted / subTotal) * 100) : 0
      };
    });

    return {
      totalLessons,
      totalCompleted,
      globalPercentage: totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0,
      details: subjectStats
    };

  } catch (e) {
    logger.error('Stats Calc Error:', e);
    return null;
  }
}
/**
 * تنسيق تقرير التقدم للذكاء الاصطناعي
 */
async function formatProgressForAI(userId) {
  try {
    // 1. جلب الإعدادات (السداسي الحالي) + التقدم + البروفايل
    const [settingsRes, progress, profile] = await Promise.all([
        supabase.from('system_settings').select('value').eq('key', 'current_semester').single(),
        getProgress(userId),
        getProfile(userId)
    ]);

    const currentSemester = settingsRes.data?.value || 'S1'; 
    const pathId = profile.selectedPathId || 'UAlger3_L1_ITCF';
    const userProgressData = progress.pathProgress || {};
    
    if (Object.keys(userProgressData).length === 0) return 'User has not started any path yet.';

    // 2. بناء مجموعة الدروس المكتملة للإحصائيات
    const completedSet = new Set();
    for (const pId in userProgressData) {
        const subjects = userProgressData[pId].subjects || {};
        for (const sId in subjects) {
            const lessons = subjects[sId].lessons || {};
            for (const lId in lessons) {
                if (lessons[lId].status === 'completed') {
                    completedSet.add(lId);
                }
            }
        }
    }

    // 3. حساب الإحصائيات العامة
    const stats = await getAcademicStats(pathId, completedSet);
    let statsReport = "";
    if (stats) {
        statsReport = `📊 **ACADEMIC STATS:**\n- Global Progress: ${stats.globalPercentage}% (${stats.totalCompleted}/${stats.totalLessons} lessons).\n`;
        Object.entries(stats.details).forEach(([subj, det]) => {
            if (det.percentage > 0) { 
                statsReport += `- ${subj}: ${det.percentage}% (${det.done}/${det.total})\n`;
            }
        });
    }

    // 4. تحليل التفاصيل (Active vs Archive)
    let activeSemesterText = "";
    let academicArchiveText = "";

    const requestedPaths = new Set(Object.keys(userProgressData));

    for (const pId of requestedPaths) {
      const educationalPath = await getCachedEducationalPathById(pId);
      if (!educationalPath) continue;

      const subjectsProgress = userProgressData[pId]?.subjects || {};
      
      for (const subjectId in subjectsProgress) {
        const subjectData = educationalPath.subjects?.find(s => s.id === subjectId);
        if (!subjectData) continue;

        const subjectTitle = subjectData.title || subjectId;
        const subjectSemester = subjectData.semester || 'S1'; // افتراضياً S1
        const lessonsProgress = subjectsProgress[subjectId]?.lessons || {};
        
        // تحليل حالة الدروس
        const completedTitles = [];
        let nextLessonTitle = null;
        const sortedLessons = (subjectData.lessons || []).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));

        for (const lesson of sortedLessons) {
            const lProg = lessonsProgress[lesson.id];
            if (lProg && lProg.status === 'completed') {
                completedTitles.push(lesson.title);
            } else if (!nextLessonTitle) {
                nextLessonTitle = lesson.title;
            }
        }

        // 🔥 الفرز الذكي (Active vs Archive) 🔥
        if (subjectSemester === currentSemester) {
            // --- المواد الحالية (Active Focus) ---
            let statusLine = `📌 **Subject: ${subjectTitle} (${subjectSemester})**\n`;
            
            if (completedTitles.length > 0) {
                statusLine += `   - ✅ DONE: ${completedTitles.join(', ')}.\n`;
            } else {
                statusLine += `   - ⚪ Fresh Start (No lessons done yet).\n`; 
            }

            if (nextLessonTitle) {
                statusLine += `   - 🎯 CURRENT TARGET: "${nextLessonTitle}" (Focus on this now).`; 
            }
            
            activeSemesterText += statusLine + "\n\n";

        } else {
            // --- الأرشيف (Context Only) ---
            if (completedTitles.length > 0) {
                academicArchiveText += `🗂️ **${subjectTitle} (${subjectSemester}):** Finished ${completedTitles.length} lessons. (Use for analogies/context only).\n`;
            }
        }
      }
    }

    // 5. دمج التقرير النهائي
    let finalReport = statsReport + "\n";
    if (activeSemesterText) {
        finalReport += `📝 **CURRENT SEMESTER (${currentSemester}) - ACTIVE FOCUS:**\n${activeSemesterText}`;
    }
    if (academicArchiveText) {
        finalReport += `\n📚 **ACADEMIC BACKGROUND (PREVIOUS SEMESTERS):**\n${academicArchiveText}`;
    }

    return finalReport || 'No progress data available.';

  } catch (err) {
    logger.error('Error in formatProgressForAI:', err.stack);
    return 'Error reading progress.';
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

async function sendUserNotification(userId, notification, cachedToken = null) {
  try {
    const type = notification.type || NOTIF_TYPES.SYSTEM;
    const meta = notification.meta || {};

    // 1. الحفظ في صندوق الوارد (Inbox) - هذا يحدث دائماً لكي يرى المستخدم الإشعار داخل التطبيق
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

    // 2. التحقق من التوكن (Push Notification)
    let pushToken = cachedToken;

    // إذا لم يتم تمرير التوكن، نحاول جلبه من القاعدة (كخطة بديلة)
    if (!pushToken) {
        const { data: user } = await supabase
            .from('users')
            .select('fcm_token')
            .eq('id', userId)
            .single();
        pushToken = user?.fcm_token;
    }

    // 🛑 نقطة التفتيش: إذا لم يوجد توكن، نتوقف هنا ولا نرسل للـ Expo
    if (!pushToken || !pushToken.startsWith('ExponentPushToken')) {
        // logger.warn(`[Notification] Skipped Push for ${userId}: No valid token.`);
        return; 
    }

    // 3. الإرسال الفعلي عبر Expo
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

    // 1. جلب البروفايل لمعرفة المسار (Path ID)
    const profile = await getProfile(userId);
    const pathId = profile.selectedPathId || 'UAlger3_L1_ITCF'; // القيمة الافتراضية

    // 2. حذف المهام القديمة المعلقة
    await supabase
      .from('user_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'pending')
      .neq('type', 'user_created');

    // 3. تشغيل محرك الجاذبية مع المسار الصحيح
    const plan = await runPlannerManager(userId, pathId); // 👈 تمرير pathId هنا
    const newTasks = plan.tasks || [];

    if (newTasks.length === 0) return [];

    // 4. إدخال المهام
    const tasksToInsert = newTasks.map(t => ({
      user_id: userId,
      title: t.title,
      type: t.type || 'study',
      priority: 'high',
      status: 'pending',
      meta: { 
        relatedLessonId: t.meta.relatedLessonId,
        relatedSubjectId: t.meta.relatedSubjectId, // تأكدنا من الاسم هنا
        lessonTitle: t.meta.relatedLessonTitle, 
        score: t.score,
        isExamPrep: t.meta.isExamPrep, // 👈 مهم جداً للفرونت أند
        source: 'gravity_engine'
      },
      created_at: new Date().toISOString()
    }));

    const { data } = await supabase.from('user_tasks').insert(tasksToInsert).select();
    
    // تفريغ الكاش
    await cacheDel('progress', userId); 
    
    logger.success(`✅ Tasks refreshed for ${userId} (Top: ${newTasks[0]?.title})`);
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
 
 * 🕵️‍♂️ Super-Chrono: رادار الوقت والأساتذة
 */
async function getStudentScheduleStatus(groupId) {
  if (!groupId) return null;

  try {
    // 1. تحديد الوقت واليوم بدقة (توقيت الجزائر)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Algiers',
      hour12: false,
      weekday: 'long',
      hour: 'numeric',
      minute: 'numeric'
    });
    
    const parts = formatter.formatToParts(now);
    const currentDay = parts.find(p => p.type === 'weekday').value.trim(); 
    const currentHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const currentMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const currentTotalMins = (currentHour * 60) + currentMinute;

    console.log(`🕒 EduChrono Check: Group=${groupId}, Day=${currentDay}, Time=${currentHour}:${currentMinute}`);

    // 2. جلب الجدول
    const { data: schedule, error } = await supabase
      .from('group_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('day_of_week', currentDay) 
      .order('start_time', { ascending: true });

    if (error) {
        console.error("❌ DB Error:", error.message);
        return null;
    }

    if (!schedule || schedule.length === 0) {
        console.log("⚠️ No schedule found for today.");
        return { state: 'free_day', context: `It is ${currentDay}, a free day. No classes found in DB.` };
    }

    console.log(`✅ Found ${schedule.length} classes today.`);

    // 3. التحليل الدقيق
    for (let i = 0; i < schedule.length; i++) {
      const session = schedule[i];
      const [sH, sM] = session.start_time.split(':').map(Number);
      const [eH, eM] = session.end_time.split(':').map(Number);
      
      const startMins = (sH * 60) + sM;
      const endMins = (eH * 60) + eM;
      
      const profName = session.professor_name ? `Prof. ${session.professor_name}` : 'الشيخ';
      
      // حساب الفرق (تم تعريفه هنا ليتم استخدامه في الشروط)
      const diff = startMins - currentTotalMins;

      // A. أثناء الحصة (Inside Class)
     if (currentTotalMins >= startMins && currentTotalMins < endMins) {
        return {
          state: 'IN_CLASS',
          subject: session.subject_name,
          prof: profName, // ✅ تأكد أن هذا السطر موجود
          room: session.room,
          type: session.type,
          // نضيف السياق النصي أيضاً كاحتياط
          context: `User is in class: ${session.subject_name} (${session.type}). Teacher: ${profName}. Room: ${session.room}.`
        };
      }

      // B. قبل الحصة القادمة (Waiting Mode)
      // إذا كان الوقت الحالي قبل بداية هذه الحصة، فهذه هي الحصة القادمة
      if (currentTotalMins < startMins) {
          return {
              state: 'FREE_GAP',
              nextSubject: session.subject_name,
              duration: diff,
              context: `☕ **WAITING:** User has class "${session.subject_name}" (${session.type}) at ${session.start_time}. Current time is ${currentHour}:${currentMinute}. They have ${Math.floor(diff/60)}h ${diff%60}m free. Suggest preparing.`
          };
      }
      
      // إذا كان الوقت الحالي بعد نهاية الحصة، تستمر الحلقة للحصة التالية
    }

    // C. انتهى اليوم (إذا انتهت الحلقة ولم نجد حصة حالية أو قادمة)
    const lastSession = schedule[schedule.length - 1];
    return { 
        state: 'DAY_OVER', 
        context: `University is over for today. Last class was ${lastSession.subject_name}.` 
    };

  } catch (err) { // <--- تم إصلاح القوس المفقود هنا
    console.error('EduChrono Logic Error:', err);
    return null;
  }
}
/**
 * 🧠 EduChrono: الخوارزمية الصارمة للوعي الزمني
 * تعيد سياقاً جاهزاً للـ AI بناءً على القواعد المنطقية
 */
async function runEduChrono(userId, groupId) {
  // 1. جلب الوقت الحالي (الجزائر)
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Algiers', hour12: false, weekday: 'long', hour: 'numeric', minute: 'numeric' });
  const parts = formatter.formatToParts(now);
  const currentDay = parts.find(p => p.type === 'weekday').value; 
  const currentHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const currentMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const currentTotalMins = (currentHour * 60) + currentMinute;

  // 2. جلب جدول اليوم من الداتابايز
  const { data: schedule } = await supabase
    .from('group_schedules')
    .select('*')
    .eq('group_id', groupId)
    .eq('day_of_week', currentDay)
    .order('start_time', { ascending: true });

  if (!schedule || schedule.length === 0) {
      // حالة: يوم عطلة أو لا توجد دراسة
      if (currentHour >= 18) return { status: 'EVENING_REVIEW', context: "It's evening on a free day. Ask if they studied anything." };
      return { status: 'FREE_DAY', context: "It's a free day. Encourage light study or hobbies." };
  }

  // 3. التحليل الدقيق (The Logic)
  for (let i = 0; i < schedule.length; i++) {
    const session = schedule[i];
    const [sH, sM] = session.start_time.split(':').map(Number);
    const [eH, eM] = session.end_time.split(':').map(Number);
    const startMins = (sH * 60) + sM;
    const endMins = (eH * 60) + eM;

    // A. الطالب وسط الحصة
    if (currentTotalMins >= startMins && currentTotalMins < endMins) {
        return {
            status: 'IN_CLASS',
            context: `User is currently in class: ${session.subject_name} (${session.type}). Be brief. Ask if they are following.`,
            meta: session
        };
    }

    // B. الطالب في "راحة" (Gap) بين حصتين
    // نتحقق إذا كانت هناك حصة قادمة والفرق بين انتهاء هذه وبداية القادمة أقل من ساعتين
    if (i < schedule.length - 1) {
        const nextSession = schedule[i+1];
        const [nsH, nsM] = nextSession.start_time.split(':').map(Number);
        const nextStartMins = (nsH * 60) + nsM;

        if (currentTotalMins >= endMins && currentTotalMins < nextStartMins) {
            return {
                status: 'BREAK_TIME',
                context: `User is in a BREAK. Just finished ${session.subject_name}. Next is ${nextSession.subject_name} in ${(nextStartMins - currentTotalMins)} mins. Tell them to grab coffee or review quickly.`,
                meta: { prev: session, next: nextSession }
            };
        }
    }
  }

  // C. انتهى الدوام الدراسي لليوم (Post-School)
  const lastSession = schedule[schedule.length - 1];
  const [leH, leM] = lastSession.end_time.split(':').map(Number);
  const lastEndMins = (leH * 60) + leM;

  if (currentTotalMins >= lastEndMins) {
      // إذا مر أقل من 3 ساعات على النهاية
      if (currentTotalMins - lastEndMins < 180) {
          return {
              status: 'JUST_FINISHED_DAY',
              context: `User finished university for today. Last class was ${lastSession.subject_name}. Ask: "كيفاش جاز النهار؟ (How was the day?)". Don't ask to study immediately, let them rest.`,
              meta: { subjectsToday: schedule.map(s => s.subject_name) }
          };
      } else {
          // المساء/الليل
          return {
              status: 'EVENING_ROUTINE',
              context: `It's evening. User studied: ${schedule.map(s => s.subject_name).join(', ')} today. Ask if they want to prepare for tomorrow.`,
              meta: { subjectsToday: schedule.map(s => s.subject_name) }
          };
      }
  }

  // D. الصباح قبل البداية
  return { status: 'MORNING_PREP', context: "Morning before classes. Wish them luck." };
}

/**
 * جلب الامتحانات التي مرت حديثاً (آخر 7 أيام)
 * لكي يسأل عنها الـ AI
 */
async function getRecentPastExams(groupId) {
  if (!groupId) return [];

  const now = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(now.getDate() - 7);

  try {
    const { data: exams, error } = await supabase
      .from('exams')
      .select('id, subject_id, exam_date, type, subjects(title)')
      .eq('group_id', groupId)
      .lt('exam_date', now.toISOString()) // أقل من الآن (ماضي)
      .gte('exam_date', sevenDaysAgo.toISOString()) // أكبر من قبل 7 أيام
      .order('exam_date', { ascending: false }); // الأحدث أولاً

    if (error) throw error;
    return exams || [];
  } catch (err) {
    console.error('getRecentPastExams Error:', err.message);
    return [];
  }
}

// ✅ إضافة مهمة استكشاف جديدة
async function addDiscoveryMission(userId, content, source = 'auto', priority = 'low') {
  const { data: user } = await supabase.from('users').select('ai_discovery_missions').eq('id', userId).single();
  let missions = user?.ai_discovery_missions || [];

  // منع التكرار
  if (missions.some(m => m.content === content)) return;

  const newMission = {
    id: crypto.randomUUID(),
    content: content,
    source: source, // 'admin' or 'auto'
    priority: priority, // 'high' (Admin) or 'low' (Auto)
    created_at: new Date().toISOString()
  };

  // مهام الأدمين دائماً في المقدمة
  if (source === 'admin') {
      missions.unshift(newMission);
  } else {
      missions.push(newMission);
  }

  await supabase.from('users').update({ ai_discovery_missions: missions }).eq('id', userId);
}

// ✅ حذف مهمة (عند اكتمالها)
async function completeDiscoveryMission(userId, missionContentPartial) {
  const { data: user } = await supabase.from('users').select('ai_discovery_missions').eq('id', userId).single();
  let missions = user?.ai_discovery_missions || [];

  const initialLength = missions.length;
  // نحذف المهمة التي يحتوي نصها على الكلمة المفتاحية (بحث ذكي)
  missions = missions.filter(m => !m.content.includes(missionContentPartial));

  if (missions.length !== initialLength) {
      await supabase.from('users').update({ ai_discovery_missions: missions }).eq('id', userId);
      console.log(`✅ Mission Completed & Removed for ${userId}`);
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
  getStudentScheduleStatus,
  getRecentPastExams,
   addDiscoveryMission,
  completeDiscoveryMission
};
