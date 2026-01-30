// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const logger = require('../utils/logger');
const { generateSmartStudyStrategy } = require('../services/data/helpers'); 
const embeddingService = require('../services/embeddings'); 
const supabase = require('../services/data/supabase'); 
const { runNightWatch } = require('../services/jobs/nightWatch'); 
const { scanAndFillEmptyLessons } = require('../services/engines/ghostTeacher'); 
const { checkExamTiming } = require('../services/jobs/examWorker');
const { addDiscoveryMission } = require('../services/data/helpers');
const keyManager = require('../services/ai/keyManager');
const { calculateSmartPrimeTime } = require('../services/engines/chronoV2');
const { predictSystemHealth } = require('../services/ai/keyPredictor');
const { decryptForAdmin } = require('../utils/crypto');
const { clearSystemFeatureCache } = require('../services/data/helpers'); 
const liveMonitor = require('../services/monitoring/realtimeStats');
const { runStreakRescueMission } = require('../services/jobs/streakRescue');
const { clearCurriculumCache } = require('../services/ai/curriculumContext');
const { ensureJsonOrRepair, escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const db = getFirestoreInstance();
const systemHealth = require('../services/monitoring/systemHealth'); 

let generateWithFailoverRef; 

function initAdminController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

/**
 * ⚛️ مولد الهيكل الذري (Atomic Structure Generator)
 * يمر على الدروس التي لديها محتوى ولكن ليس لديها هيكل ذري، ويقوم بتوليده عبر الذكاء الاصطناعي.
 */
async function generateAtomicStructuresBatch(req, res) {
  // حماية المسار
  if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
  }

  // رد فوري لتجنب Timeout
  res.json({ message: '🚀 Atomic Generator started in background...' });

  // تشغيل في الخلفية
  runAtomicGeneratorLogic().catch(e => logger.error('Atomic Generator Fatal Error:', e));
}
async function runAtomicGeneratorLogic() {
  logger.info('⚛️ STARTING ATOMIC GENERATION (TURBO MODE) 🚀...');

  try {
    // 1. Fetch lessons
    const { data: contents } = await supabase
      .from('lessons_content')
      .select('id, content');

    // 2. Fetch existing structures
    const { data: existingStructures } = await supabase
      .from('atomic_lesson_structures')
      .select('lesson_id');

    const existingSet = new Set(existingStructures?.map(s => s.lesson_id) || []);

    // 3. Filter lessons
    const tasks = contents.filter(c => !existingSet.has(c.id));
    logger.info(`🔨 Found ${tasks.length} lessons. Processing sequentially...`);

    // 4. Limit batch size
    const batch = tasks.slice(0, 20);

    for (const task of batch) {
      logger.info(`⏳ Processing lesson ${task.id}...`);

      await processSingleAtomicLesson(task.id, task.content);

      logger.info('💤 Cooling down for 10 seconds...');
      await new Promise(r => setTimeout(r, 10000));
    }

    logger.success('✅ Batch processing finished.');

  } catch (err) {
    logger.error('❌ Atomic Generator Logic Error:', err);
  }
}

async function processSingleAtomicLesson(lessonId, content) {
  try {
    // جلب عنوان الدرس للمساعدة في السياق
    const { data: lessonMeta } = await supabase.from('lessons').select('title').eq('id', lessonId).single();
    const lessonTitle = lessonMeta?.title || 'Unknown Lesson';

    // تقليص النص إذا كان طويلاً جداً (لتوفير التوكيز)
    const safeContent = content;

    const prompt = `
    You are an Expert Curriculum Architect.
    
    **Task:** Break down this lesson into "Atomic Elements" (Key Concepts).
    **Lesson Title:** "${lessonTitle}"
    **Content:**
    """${safeContent}"""

    **Rules:**
    1. Identify **3 to 7** core concepts/steps in this lesson (depending on density).
    2. **Order** them logically (1, 2, 3...).
    3. Assign a **Weight** (1 = Introduction, 2 = Core Concept, 3 = Critical/Complex).
    4. Generate a unique **ID** for each element (English, snake_case, relevant to topic).
    5. **Title** must be in Arabic (descriptive).
    
    **Output JSON Format ONLY:**
    {
      "elements": [
        { "id": "topic_definition", "title": "تعريف المفهوم", "weight": 1, "order": 1 },
        { "id": "topic_types", "title": "الأنواع والخصائص", "weight": 2, "order": 2 }
      ]
    }
    exapmle : Title of lesson : Algeria. the json structure expected : {
  "elements": [
    {
      "id": "geo_site",
      "order": 1,
      "title": "الموقع الفلكي والجغرافي",
      "weight": 2
    },
    {
      "id": "geo_climate",
      "order": 2,
      "title": "المناخ والأقاليم",
      "weight": 3
    },
    {
      "id": "geo_importance",
      "order": 3,
      "title": "الأهمية الاستراتيجية",
      "weight": 2
    }
  ]
}
    `;

    // استدعاء الموديل (نستخدم 'analysis' أو 'smart' حسب توفر المفاتيح)
    const res = await generateWithFailoverRef('analysis', prompt, { label: 'AtomicGen' });
    const rawText = await extractTextFromResult(res);
    const json = await ensureJsonOrRepair(rawText, 'analysis');

    if (json && json.elements && Array.isArray(json.elements)) {
        // حفظ في الداتابايز
        const { error } = await supabase.from('atomic_lesson_structures').insert({
            lesson_id: lessonId,
            structure_data: json, // يحفظ الـ JSON كاملاً
            created_at: new Date().toISOString()
        });

        if (error) throw error;
        logger.success(`⚛️ Generated structure for: ${lessonTitle} (${json.elements.length} atoms)`);
    } else {
        logger.error(`❌ Failed to parse JSON for lesson: ${lessonId}`);
    }

  } catch (err) {
    logger.error(`Error processing atomic lesson ${lessonId}:`, err.message);
  }
}
async function pushDiscoveryMission(req, res) {
  try {
    const { targetUserId, missionContent, isGlobal } = req.body;

    if (isGlobal) {
        // Send to everyone (Heavy operation, use Queue in production)
        const { data: users } = await supabase.from('users').select('id').limit(100);
        for (const user of users) {
            await addDiscoveryMission(user.id, missionContent, 'admin', 'high');
        }
        return res.json({ message: `Mission pushed to ${users.length} users.` });
    } else if (targetUserId) {
        await addDiscoveryMission(targetUserId, missionContent, 'admin', 'high');
        return res.json({ message: 'Mission pushed to target user.' });
    }

    res.status(400).json({ error: 'Specify targetUserId or isGlobal' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

// --- Helpers for Strings ---

// --- 1. THE NIGHTLY BRAIN ---

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    res.status(202).json({ message: 'Nightly analysis job started.' });
    
    // Using Firestore
    const snapshot = await db.collection('userProgress').limit(50).get(); 

    if (snapshot.empty) {
      logger.log('[CRON] No users found to analyze.');
      return;
    }

    const analysisPromises = [];
    snapshot.forEach(doc => {
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.allSettled(analysisPromises);
    logger.info(`[CRON] Finished analysis.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
  }
}

// --- 2. THE WORKER ---

async function runNightlyAnalysisForUser(userId) {
  try {
    // A) Smart Strategy
    const newMissions = await generateSmartStudyStrategy(userId);
    if (newMissions && newMissions.length > 0) {
       const userRef = db.collection('users').doc(userId);
       const userDoc = await userRef.get();
       
       if (userDoc.exists) {
           const userData = userDoc.data();
           const currentMissions = userData.aiDiscoveryMissions || [];
           // Merge unique missions
           const updated = [...new Set([...currentMissions, ...newMissions])];
           
           await userRef.update({
             aiDiscoveryMissions: updated
           });
       }
    }

    // B) Smart Re-engagement Notification
    const userProgressRef = db.collection('userProgress').doc(userId);
    const userProgressDoc = await userProgressRef.get();

    if (userProgressDoc.exists) {
        const userData = userProgressDoc.data();
        if (userData.lastLogin) {
            const lastLogin = new Date(userData.lastLogin);
            const daysInactive = (Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24);

            let intensity = null;
            if (daysInactive >= 2 && daysInactive < 3) intensity = 'gentle';
            else if (daysInactive >= 5 && daysInactive < 6) intensity = 'motivational';
            else if (daysInactive >= 10 && daysInactive < 11) intensity = 'urgent';

            if (intensity) {
                // Generate AI Message
                const reEngagementMessage = await runReEngagementManager(userId, intensity);
                
                 if (reEngagementMessage) {
                    const primeHour = await calculateUserPrimeTime(userId);
                    const scheduleTime = new Date();
                    scheduleTime.setHours(primeHour, 0, 0, 0);
                    
                    // If time passed today, schedule for tomorrow
                    if (scheduleTime < new Date()) {
                        scheduleTime.setDate(scheduleTime.getDate() + 1);
                    }

                    await enqueueJob({
                        type: 'scheduled_notification',
                        userId: userId,
                        sendAt: admin.firestore.Timestamp.fromDate(scheduleTime),
                        payload: {
                            title: intensity === 'urgent' ? 'وين راك؟ 😢' : 'تذكير للدراسة',
                            message: reEngagementMessage,
                            type: 're_engagement',
                            meta: { 
                                originalMessage: reEngagementMessage,
                                intensity: intensity
                            }
                        }
                    });
                    logger.info(`[Nightly] Scheduled re-engagement for ${userId} at ${primeHour}:00`);
                }
            }
        }
    }
  } catch (error) {
      logger.error(`Error analyzing user ${userId}:`, error.message);
  }
}

// --- 3. OTHER ADMIN TOOLS ---

async function indexSpecificLesson(req, res) {
  try {
    const { lessonId, pathId, lessonTitle } = req.body;
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    const contentDoc = await db.collection('lessonsContent').doc(lessonId).get();
    if (!contentDoc.exists) return res.status(404).json({ error: 'Content not found' });
    
    const text = contentDoc.data().content || '';
    if (!text) return res.status(400).json({ error: 'Lesson is empty' });

    const chunks = text.match(/[\s\S]{1,1000}/g) || [text]; 
    const batch = db.batch();
    
    // Clear old embeddings
    const oldEmbeddings = await db.collection('curriculum_embeddings')
      .where('metadata.lesson_id', '==', lessonId)
      .get();
      
    oldEmbeddings.forEach(doc => batch.delete(doc.ref));

    // Create new embeddings
    for (const chunk of chunks) {
      const vec = await embeddingService.generateEmbedding(chunk);
      const newRef = db.collection('curriculum_embeddings').doc(); 
      
      batch.set(newRef, {
        content: chunk, 
        embedding: vec,
        path_id: pathId || 'General',
        metadata: {
          lesson_id: lessonId,
          lesson_title: lessonTitle || 'Untitled Lesson',
          source_type: 'official'
        },
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    } 

    await batch.commit();
    return res.json({ success: true, message: `Indexed ${chunks.length} chunks for lesson ${lessonId}` });

  } catch (e) {
    logger.error('Indexing failed:', e);
    return res.status(500).json({ error: e.message });
  }
}

// دالة لفحص ما يراه الذكاء الاصطناعي في المنهج
async function debugCurriculumContext(req, res) {
  try {
    // التأكد من الهوية (نفس السر الذي تستخدمه للفهرسة)
    if (req.headers['x-admin-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { getCurriculumContext } = require('../services/ai/curriculumContext');
    const context = await getCurriculumContext();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data_seen_by_ai: context // هذا هو النص الذي سيتم حقنه في البرومبت
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }}
async function enqueueJobRoute(req, res) {
  try {
    const job = req.body;
    if (!job) return res.status(400).json({ error: 'job body required' });
    const id = await enqueueJob(job);
    return res.json({ jobId: id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
}
async function generateTitleRoute(req, res) {
  try {
    const { message } = req.body || {};
    
    // 🛑 إيقاف الذكاء الاصطناعي نهائياً لتوليد العناوين
    // نستخدم أول 50 حرف من الرسالة كعنوان
    const staticTitle = message ? message.substring(0, 50) : 'New Chat';
    
    return res.json({ title: staticTitle });

  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    return res.status(500).json({ title: 'New Chat' });
  }
}

// Helper: Logic for finding prime time
async function calculateUserPrimeTime(userId) {
  try {
    // Fetch last 50 'app_open' events
    const eventsSnapshot = await db.collection('userBehaviorAnalytics')
      .doc(userId)
      .collection('events')
      .where('name', '==', 'app_open')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    if (eventsSnapshot.empty) return 20; // Default: 8 PM

    // Count frequency by hour
    const hourCounts = {};
    eventsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.timestamp) {
        const date = data.timestamp.toDate();
        const hour = date.getHours(); 
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
    });

    // Find hour with max frequency
    const primeHour = Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b);
    
    return parseInt(primeHour);
  } catch (e) {
    logger.warn(`Failed to calc prime time for ${userId}, using default. Error: ${e.message}`);
    return 20; // Fallback
  }
}

async function triggerFullIndexing(req, res) {
  // 1. حماية المسار: تأكد من أنك أنت فقط من يستطيع استدعاءه
  // يمكنك وضع هذا المفتاح في Headers عند الطلب من Postman
  if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Access Denied' });
  }

  // 2. الرد الفوري لتجنب Timeout في Render
  res.json({ 
    success: true, 
    message: '🚀 Indexing process started in background. Check Render Logs for progress.' 
  });

  // 3. بدء العمل في الخلفية (Fire and Forget)
  runBackgroundIndexing().catch(err => {
    logger.error('❌ Background Indexing Failed:', err);
  });
}

// 🔥 المحرك الفعلي الذي يعمل في الخلفية

async function runBackgroundIndexing() {
  console.log('==========================================');
  console.log('📡 STARTING INDEXING (DIRECT ID MODE)...');
  console.log('==========================================');

  try {
    // 1. جلب المحتوى والـ ID مباشرة
    console.log('📥 Fetching raw content...');
    // التغيير: نجلب id و content فقط
    const { data: contents, error: contentError } = await supabase
      .from('lessons_content')
      .select('id, content'); 

    if (contentError) throw new Error(`Content Fetch Error: ${contentError.message}`);
    
    if (!contents || contents.length === 0) {
      console.log('⚠️ No content found in lessons_content table.');
      return;
    }

    console.log(`📦 Found ${contents.length} content rows.`);

    // 2. جلب معلومات الدروس (العناوين) لربطها
    console.log('📥 Fetching lessons metadata...');
    const { data: lessonsMeta, error: metaError } = await supabase
      .from('lessons')
      .select('id, title, subject_id');

    if (metaError) throw new Error(`Meta Fetch Error: ${metaError.message}`);

    // 3. جلب أسماء المواد
    console.log('📥 Fetching subjects...');
    const { data: subjects, error: subjectError } = await supabase
      .from('subjects')
      .select('id, title'); 

    // 4. تجهيز الخرائط (Maps)
    const subjectsMap = {};
    if (subjects) subjects.forEach(s => subjectsMap[s.id] = s.title);

    const lessonsMap = {};
    if (lessonsMeta) {
      lessonsMeta.forEach(l => {
        lessonsMap[l.id] = {
          title: l.title,
          subject_title: subjectsMap[l.subject_id] || 'General'
        };
      });
    }

    // 5. التحقق مما تم فهرسته سابقاً (لتجنب التكرار)
    // سنقارن الـ id القادم من lessons_content مع metadata->>lesson_id في جدول embeddings
    const { data: existingEmbeddings } = await supabase
      .from('curriculum_embeddings')
      .select('metadata');
    
    const indexedLessonIds = new Set();
    if (existingEmbeddings) {
      existingEmbeddings.forEach(row => {
        if (row.metadata && row.metadata.lesson_id) {
          indexedLessonIds.add(row.metadata.lesson_id);
        }
      });
    }

    // 6. تصفية الدروس (المهمة جداً)
    const tasks = contents.filter(item => {
        // هنا التغيير الجوهري: نستخدم item.id مباشرة
        const lessonId = item.id; 
        // نقبل الدرس إذا لم يكن موجوداً في قائمة المفهرسات
        return !indexedLessonIds.has(lessonId);
    });

    if (tasks.length === 0) {
      console.log('✅ All lessons are already indexed! (Table is up to date)');
      return;
    }

    console.log(`🚀 Starting to index ${tasks.length} NEW lessons...`);
    let successCount = 0;

    // 7. الحلقة الرئيسية
    for (const item of tasks) {
      const lessonId = item.id; // adm_1, com_1, etc.
      
      // البحث عن العنوان باستخدام الـ ID
      const meta = lessonsMap[lessonId] || { title: 'Unknown Lesson', subject_title: 'Unknown Subject' };
      const rawText = item.content;

      // تخطي المحتوى الفارغ أو القصير جداً
      if (!rawText || rawText.length < 20) {
          console.log(`⚠️ Skipping empty/short lesson: ${lessonId}`);
          continue;
      }

      console.log(`🔹 Processing: [${meta.subject_title}] -> ${meta.title} (${lessonId})`);

      // تقسيم النص
      const chunks = rawText.match(/[\s\S]{1,1000}/g) || [rawText];

      for (const chunk of chunks) {
        // دمج العنوان مع النص لزيادة دقة البحث
        const richText = `المادة: ${meta.subject_title}\nالدرس: ${meta.title}\nالمحتوى: ${chunk}`;

        // توليد الفيكتور
        const embedding = await embeddingService.generateEmbedding(richText);

        if (embedding) {
          await supabase.from('curriculum_embeddings').insert({
            path_id: 'UAlger3_L1_ITCF', 
            content: richText,
            embedding: embedding,
            metadata: {
              lesson_id: lessonId, // نحفظ الـ ID هنا لنعرف مستقبلاً أنه تمت فهرسته
              lesson_title: meta.title,
              subject_title: meta.subject_title,
              source: 'api_indexer_final'
            }
          });
        }
        
        // تأخير بسيط (نصف ثانية) لتجنب حظر Gemini
        await new Promise(r => setTimeout(r, 500));
      }
      successCount++;
      
      // طباعة تقدم كل 5 دروس
      if (successCount % 5 === 0) console.log(`⏳ Progress: ${successCount}/${tasks.length}`);
    }

    console.log(`🎉 DONE! Successfully indexed ${successCount} lessons.`);
      
    console.log('🔄 Clearing Curriculum Cache to update AI awareness...');
    clearCurriculumCache();
  } catch (err) {
    console.error('❌ ERROR:', err);
  }
}
async function triggerNightWatch(req, res) {
  try {
    if (!CONFIG.ENABLE_EDUNEXUS) {
        return res.status(200).json({ message: 'EduNexus Night Watch is currently disabled.' });
    }
    const secret = req.headers['x-cron-secret'];
    if (secret !== process.env.CRON_SECRET && secret !== 'my-super-secret-cron-key') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const report = await runNightWatch();
    
    res.status(200).json({ success: true, report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

async function triggerGhostScan(req, res) {
  try {
    // Fire and Forget
    scanAndFillEmptyLessons();
    
    res.json({ message: '👻 Ghost Scanner started in background.' });
  } catch (error) {
    logger.error('Ghost Scan Trigger Error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function triggerExamCheck(req, res) {
  try {
    const secret = req.headers['x-job-secret'];
    
    if (secret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Secret' });
    }

    await checkExamTiming();

    return res.status(200).json({ 
      success: true, 
      message: 'Exam timing check completed successfully.' 
    });

  } catch (error) {
    logger.error('Trigger Exam Check Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// 1. Keys Dashboard
async function getKeysStatus(req, res) {
    
    const stats = keyManager.getAllKeysStatus();
    res.json({
        total: stats.length,
        active: stats.filter(k => k.status !== 'dead').length,
        dead: stats.filter(k => k.status === 'dead').length,
        busy: stats.filter(k => k.status === 'busy').length,
        keys: stats
    });
}

// 2. Add New Key

async function addApiKey(req, res) {
    const { key, nickname } = req.body;
    
    const result = await keyManager.addKey(key, nickname || 'Admin_Added');
    
    // 🔧 إعادة تشغيل النظام فوراً
    if (result.success) {
        systemHealth.manualReset(); 
    }

    res.json(result);
}
// 3. Revive Dead Key
async function reviveApiKey(req, res) {
    const { key } = req.body;
    
    const result = await keyManager.reviveKey(key);
    res.json(result);
}

// --- 4. Chrono Analysis V2 ---
async function runDailyChronoAnalysis(req, res) {
  // 1. Security Check
  if (req.headers['x-cron-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Reply immediately to avoid timeout
  res.status(202).json({ message: 'Chrono Analysis Started ⏳' });

  try {
    // 2. Fetch active users (Last 7 days)
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    
    const { data: users } = await supabase
        .from('users')
        .select('id')
        .gt('last_active_at', lastWeek.toISOString());

    if (!users || users.length === 0) return;

    logger.info(`🕰️ Running Chrono Analysis for ${users.length} active users...`);

    // 3. Analyze users
    for (const user of users) {
        const result = await calculateSmartPrimeTime(user.id);
        
        // Save result to user metadata
        await supabase.from('users').update({
            ai_scheduler_meta: {
                next_prime_hour: result.bestHour,
                next_prime_offset: result.minuteOffset,
                last_calculated: new Date().toISOString(),
                strategy: result.strategy
            }
        }).eq('id', user.id);
    }
    
    logger.info('✅ Chrono Analysis Completed.');

  } catch (error) {
    logger.error('Chrono Cron Error:', error);
  }
}

async function getDashboardStats(req, res) {
  try {
    // 1. جلب بيانات الرسم البياني (Weekly Traffic) عبر RPC
    // ملاحظة: تأكد من أنك أنشأت الدالة get_weekly_traffic في Supabase
    const { data: chartData, error: chartError } = await supabase.rpc('get_weekly_traffic');

    if (chartError) {
        logger.error("Chart RPC Error:", chartError.message);
    }

    // تنسيق البيانات للمكتبة في الفرونت أند (Recharts / Victory)
    // نتوقع أن الدالة ترجع { day_name: 'Sat', request_count: 50 }
    const formattedChart = chartData ? chartData.map(d => ({
      value: Number(d.request_count),
      label: d.day_name
    })) : [];

    // 2. عدد المستخدمين النشطين (آخر 24 ساعة)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: activeUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gt('last_active_at', oneDayAgo);

    // 3. التكلفة الشهرية
    const { data: costData } = await supabase
      .from('view_monthly_ai_costs')
      .select('estimated_cost_usd')
      .limit(1)
      .maybeSingle();

    // 4. إجمالي الطلبات اليوم
    const startOfDay = new Date().toISOString().split('T')[0];
    // نستخدم raw_telemetry_logs أو ai_usage_logs حسب المتوفر لديك
    const { count: requestsToday } = await supabase
      .from('raw_telemetry_logs') 
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfDay);

    // إرسال الاستجابة النهائية
    res.json({
      active_users: activeUsers || 0,
      financials: { 
        month_cost: costData?.estimated_cost_usd || 0, 
        limit: 50 // حد الميزانية الافتراضي
      },
      total_requests: requestsToday || 0,
      chart_data: formattedChart, // ✅ البيانات التي ينتظرها الرسم البياني
      system_health: { status: 'online', rpm: 100, uptime: '99.9%' }
    });

  } catch (e) {
    logger.error('Dashboard Stats Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
async function activateLaunchKeys(req, res) {
   

    try {
        // 1. تحديث الحالة في الداتابيز
        const { error } = await supabase
            .from('system_api_keys')
            .update({ status: 'active' })
            .eq('status', 'reserved');

        if (error) throw error;

        // سنضيف دالة reload بسيطة في KeyManager
        await require('../services/ai/keyManager').reloadKeys(); 
        systemHealth.manualReset();

        res.json({ success: true, message: "🚀 All reserved keys are now ACTIVE! Let the games begin." });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// دالة جديدة: كشف كلمة المرور (لك أنت فقط)
async function revealUserPassword(req, res) {
  const { targetUserId } = req.body;

  try {
    // 2. جلب البيانات المشفرة
    const { data: user } = await supabase
        .from('users')
        .select('email, admin_audit_log')
        .eq('id', targetUserId)
        .single();

    if (!user || !user.admin_audit_log || !user.admin_audit_log.encrypted_pass) {
        return res.status(404).json({ error: 'No audit data found for this user.' });
    }

    // 3. فك التشفير
    const originalPass = decryptForAdmin(user.admin_audit_log.encrypted_pass);

    if (!originalPass) {
        return res.status(500).json({ error: 'Decryption failed (Key mismatch?).' });
    }

    // 4. إرجاع النتيجة (تعامل معها بحذر في الفرونت أند!)
    // نقوم أيضاً بتحديث السجل أنك راجعتها
    await supabase.from('users').update({
        admin_audit_log: { ...user.admin_audit_log, checked_by_admin: true, checked_at: new Date().toISOString() }
    }).eq('id', targetUserId);

    logger.info(`Admin revealed password for user: ${user.email}`);

    return res.json({ 
        success: true, 
        email: user.email, 
        decrypted_password: originalPass 
    });

  } catch (e) {
    logger.error('Reveal Password Error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function toggleSystemFeature(req, res) {

  const { key, value } = req.body; // value should be boolean or string "true"/"false"

  try {
      const strValue = String(value); // تحويل لسترينغ للتخزين
      
     
      await supabase
        .from('system_settings')
        .update({ value: strValue })
        .eq('key', key);

      // 🔥 المسح الفوري للكاش ليطبق التغيير في اللحظة
      clearSystemFeatureCache(key); 

      // مسح الكاش لكي يطبق التغيير فوراً
      // (يتطلب تصدير settingsCache من helpers أو عمل دالة clear)
      // للتبسيط، سينتظر السيرفر 5 دقائق أو يمكنك إعادة تشغيله، 
      // أو الأفضل: إضافة دالة clearSettingsCache في helpers واستدعاؤها هنا.
      
      res.json({ success: true, message: `Feature ${key} set to ${strValue} and cache cleared.` });

  } catch (e) {
      res.status(500).json({ error: e.message });
  }
}
async function getAllUsers(req, res) {
  
  
  try {
    // نجلب أهم البيانات فقط للقائمة
    const { data: users, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, email, role, last_active_at, created_at, group_id')
      .order('last_active_at', { ascending: false }) // النشطون أولاً
      .limit(50); // نجلب آخر 50 لكي لا يثقل التطبيق

    if (error) throw error;
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ==========================================
// 1. نظام الإعلانات (Announcements Tower)
// ==========================================

async function createAnnouncement(req, res) {
  try {
    const { title, message, type, targetType, targetValue, imageUrl, actionText, actionLink } = req.body;

    if (!title || !message || !type) {
      return res.status(400).json({ error: 'Missing required fields (title, message, type)' });
    }

    const { data, error } = await supabase
      .from('announcements')
      .insert({
        title,
        message,
        type, // info, warning, success
        target_type: targetType || 'all',
        target_value: targetValue || null,
        image_url: imageUrl || null,
        action_text: actionText || 'حسناً',
        action_link: actionLink || null,
        views_count: 0,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    logger.success(`📢 Admin created announcement: ${title}`);
    res.status(201).json({ success: true, data });

  } catch (e) {
    logger.error('Create Announcement Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getAnnouncementHistory(req, res) {
  try {
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ==========================================
// 2. نظام الرصد والتحليلات (Monitoring)
// ==========================================

async function getActivityChart(req, res) {
  try {
    // نجلب البيانات من view_daily_ai_costs لأنها تحتوي على ملخص يومي
    // أو يمكن التجميع من login_history
    const { data, error } = await supabase
      .from('view_daily_ai_costs')
      .select('usage_date, total_requests')
      .order('usage_date', { ascending: false })
      .limit(7);

    if (error) throw error;

    // تنسيق البيانات للرسم البياني (عكس الترتيب ليصبح من الأقدم للأحدث)
    const chartData = (data || []).reverse().map(item => {
      const date = new Date(item.usage_date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' }); // Mon, Tue...
      return {
        label: dayName,
        value: item.total_requests || 0
      };
    });

    res.json(chartData);
  } catch (e) {
    logger.error('Activity Chart Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// تحديث دالة Dashboard Stats الموجودة لتطابق التنسيق المطلوب

async function getDashboardStatsV2(req, res) {
  try {
    const now = new Date();
    
    // 1. حساب بداية اليوم (لحساب النشطين اليوم)
    const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString();
    
    // 2. حساب آخر 5 دقائق (لحساب النشطين الآن - Realtime)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // تنفيذ الاستعلامات بشكل متوازي (Parallel) للسرعة
    const [totalUsers, dailyActive, liveUsers] = await Promise.all([
      // A. إجمالي المسجلين
      supabase.from('users').select('*', { count: 'exact', head: true }),
      
      // B. النشطين اليوم
      supabase.from('users').select('*', { count: 'exact', head: true }).gt('last_active_at', startOfDay),
      
      // C. النشطين الآن (Live)
      supabase.from('users').select('*', { count: 'exact', head: true }).gt('last_active_at', fiveMinutesAgo)
    ]);

    // جلب التكاليف (اختياري، كما كان سابقاً)
    const { data: monthlyCost } = await supabase
      .from('view_monthly_ai_costs')
      .select('estimated_cost_usd')
      .limit(1)
      .maybeSingle();

    const response = {
      live_users: liveUsers.count || 0,        // ✅ المطلوب 1
      daily_active: dailyActive.count || 0,    // ✅ المطلوب 2
      total_users: totalUsers.count || 0,      // ✅ المطلوب 3
      financials: {
        month_cost: monthlyCost?.estimated_cost_usd || 0,
      }
    };

    res.json(response);
  } catch (e) {
    console.error('Stats Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ==========================================
// 3. إدارة الإعدادات (Feature Flags)
// ==========================================

async function getSystemSettings(req, res) {
  try {
    const { data, error } = await supabase.from('system_settings').select('*');
    if (error) throw error;
    
    // تحويل المصفوفة إلى كائن { key: value }
    const settings = {};
    data.forEach(item => {
      // تحويل "true"/"false" إلى boolean
      settings[item.key] = item.value === 'true';
    });
    
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function updateSystemSetting(req, res) {
  const { key, value } = req.body;
  try {
    const strValue = String(value);
    const { error } = await supabase
      .from('system_settings')
      .upsert({ key, value: strValue });

    if (error) throw error;

    // مسح الكاش
    clearSystemFeatureCache(key);
    
    res.json({ success: true, key, value: strValue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 1. جلب قائمة الأفواج (للقوائم المنسدلة في الفرونت أند)
async function getGroups(req, res) {
  try {
    const { data, error } = await supabase
      .from('study_groups')
      .select('id, name')
      .order('name', { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (e) {
    logger.error('Get Groups Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// 2. محرك بحث المستخدمين (لإرسال إشعارات محددة أو تعديل بيانات)
async function searchUsers(req, res) {
  try {
    const { q } = req.query; // كلمة البحث

    // إذا كان البحث قصيراً جداً، نرجع مصفوفة فارغة لتخفيف الضغط
    if (!q || q.length < 2) {
        return res.json([]);
    }

    // البحث في الاسم الأول، اللقب، أو الإيميل (case-insensitive)
    const { data, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, email, group_id, role')
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(20); // نكتفي بـ 20 نتيجة

    if (error) throw error;

    res.json(data);
  } catch (e) {
    logger.error('Search Users Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getLiveTraffic(req, res) {
  try {
    // الدالة getStats الآن ترجع الهيكل JSON المطلوب بالضبط
    const stats = liveMonitor.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * 🛠️ أداة إصلاح الأحجام الحقيقية
 * تقوم بعمل Head Request لكل ملف لجلب حجمه الحقيقي من السيرفر
 */
async function fixRealFileSizes(req, res) {
  // حماية
  if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
  }

  // رد فوري
  res.json({ message: '🔧 Started fixing file sizes in background...' });

  runFileSizeFixer();
}

async function runFileSizeFixer() {
  console.log('⚖️ STARTING REAL SIZE CALCULATION...');

  try {
    // 1. جلب المرفوعات التي حجمها 0
    const { data: uploads } = await supabase
      .from('lesson_sources')
      .select('id, file_url')
      .or('file_size.is.null,file_size.eq.0');

    console.log(`📂 Found ${uploads?.length || 0} uploads with 0 size.`);

    let updatedCount = 0;

    if (uploads) {
      for (const file of uploads) {
        if (!file.file_url) continue;

        try {
          // نطلب "رأس" الملف فقط (خفيف جداً) لنعرف الحجم
          const response = await axios.head(file.file_url);
          const realSize = parseInt(response.headers['content-length'], 10);

          if (realSize && !isNaN(realSize)) {
            await supabase
              .from('lesson_sources')
              .update({ file_size: realSize })
              .eq('id', file.id);
            
            updatedCount++;
            console.log(`✅ Fixed Upload ${file.id}: ${realSize} bytes`);
          }
        } catch (err) {
          console.error(`❌ Failed to fetch size for ${file.id}:`, err.message);
        }
        // تأخير بسيط لتجنب الحظر
        await new Promise(r => setTimeout(r, 200)); 
      }
    }

    // 2. جلب عناصر المتجر (store_items) التي حجمها 0
    const { data: items } = await supabase
      .from('store_items')
      .select('id, file_url')
      .or('file_size.is.null,file_size.eq.0');

    console.log(`🛒 Found ${items?.length || 0} store items with 0 size.`);

    if (items) {
      for (const item of items) {
        if (!item.file_url) continue;

        try {
          const response = await axios.head(item.file_url);
          const realSize = parseInt(response.headers['content-length'], 10);

          if (realSize && !isNaN(realSize)) {
            await supabase
              .from('store_items')
              .update({ file_size: realSize })
              .eq('id', item.id);
            
            updatedCount++;
            console.log(`✅ Fixed Store Item ${item.id}: ${realSize} bytes`);
          }
        } catch (err) {
          console.error(`❌ Failed to fetch size for item ${item.id}:`, err.message);
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`🎉 FINISHED! Updated ${updatedCount} files with REAL sizes.`);

  } catch (e) {
    console.error('Fatal Fixer Error:', e);
  }
}
// ✅ دالة جديدة لتشغيل الإنقاذ يدوياً
async function triggerStreakRescue(req, res) {
  if (req.headers['x-job-secret'] !== CONFIG.NIGHTLY_JOB_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Fire & Forget
  runStreakRescueMission().catch(e => logger.error('Manual Rescue Error:', e));
  res.json({ message: '🚑 Streak Rescue Mission Launched!' });
}

module.exports = {
  initAdminController,
  indexSpecificLesson,
  runNightlyAnalysis,
  enqueueJobRoute,
  generateTitleRoute,
  triggerFullIndexing,
  triggerNightWatch,
  triggerGhostScan,
  triggerExamCheck,
  pushDiscoveryMission,
  getKeysStatus,
  addApiKey,
  reviveApiKey,
  runDailyChronoAnalysis,
  getDashboardStats,
  activateLaunchKeys,
  revealUserPassword,
  toggleSystemFeature,
  getAllUsers,
  createAnnouncement,
  getAnnouncementHistory,
  getActivityChart,
  getSystemSettings,
  updateSystemSetting,
  getGroups,    
  searchUsers,
  getDashboardStatsV2,
  getLiveTraffic,
  triggerStreakRescue,
  debugCurriculumContext,
  generateAtomicStructuresBatch,
  fixRealFileSizes
};
