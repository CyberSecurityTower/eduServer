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

const db = getFirestoreInstance();

let generateWithFailoverRef; 

function initAdminController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

async function pushDiscoveryMission(req, res) {
  try {
    const { targetUserId, missionContent, isGlobal } = req.body;
    
    // Simple protection
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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
function escapeForPrompt(str) {
  return str ? str.replace(/"/g, '\\"').replace(/\n/g, ' ') : '';
}
function safeSnippet(str, length) {
  return str && str.length > length ? str.substring(0, length) + '...' : str;
}
async function extractTextFromResult(result) {
  return result?.text || result?.content || result || '';
}

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
    const { message, language = 'Arabic' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text. Message: "${escapeForPrompt(safeSnippet(message, 300))}"`;

    if (!generateWithFailoverRef) return res.status(200).json({ title: message.substring(0, 30) });
    
    const modelResp = await generateWithFailoverRef('titleIntent', prompt, { label: 'GenerateTitle', timeoutMs: 5000 });
    const title = await extractTextFromResult(modelResp);

    return res.json({ title: title ? title.replace(/["']/g, '') : message.substring(0, 30) });
  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    return res.status(500).json({ title: req.body.message ? req.body.message.substring(0, 30) : 'New Chat' });
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
  if (req.headers['x-admin-secret'] !== 'my-secret-islam-123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ message: 'Started Contextual Indexing (V3)...' });

  try {
    console.log('🚨 STARTING CONTEXTUAL INDEXING 🚨');

    // 1. Fetch Content
    const { data: contents, error: contentError } = await supabase
      .from('lessons_content')
      .select('*');

    if (contentError || !contents) {
      console.error('❌ Error fetching content:', contentError);
      return;
    }

    // 2. Fetch Titles (Meta Data)
    const { data: lessonsMeta, error: metaError } = await supabase
      .from('lessons')
      .select('id, title');

    if (metaError) console.error('⚠️ Could not fetch titles:', metaError);

    const titlesMap = {};
    if (lessonsMeta) {
        lessonsMeta.forEach(l => { titlesMap[l.id] = l.title; });
    }

    console.log(`✅ Found ${contents.length} lessons content to process.`);

    let totalChunks = 0;

    for (const item of contents) {
      const rawContent = item.content;
      const lessonId = item.id;
      
      const lessonTitle = titlesMap[lessonId] || 'درس تعليمي'; 

      if (!rawContent || rawContent.length < 5) continue;

      const chunks = rawContent.match(/[\s\S]{1,1000}/g) || [rawContent];

      for (const chunk of chunks) {
        
        // Enrich context with title
        const richText = `عنوان الدرس: ${lessonTitle}\n---\n${chunk}`;

        const vector = await embeddingService.generateEmbedding(richText);

        if (!vector || vector.length === 0) continue;

        const { error: insertError } = await supabase
          .from('curriculum_embeddings')
          .insert({
            path_id: 'UAlger3_L1_ITCF',
            content: richText,
            embedding: vector,
            metadata: {
              lesson_id: lessonId,
              lesson_title: lessonTitle,
              subject_id: item.subject_id,
              source: 'contextual_indexer'
            },
            created_at: new Date().toISOString()
          });

        if (!insertError) {
           totalChunks++;
           if (totalChunks % 5 === 0) console.log(`💾 Indexed ${totalChunks} contextual chunks...`);
        }
        
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`🎉 FINISHED V3! Total contextual chunks: ${totalChunks}`);

  } catch (err) {
    console.error('❌ FATAL ERROR:', err);
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
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
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
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) return res.status(401).send('Forbidden');
    
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
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) return res.status(401).send('Forbidden');
    const { key, nickname } = req.body;
    
    const result = await keyManager.addKey(key, nickname || 'Admin_Added');
    res.json(result);
}

// 3. Revive Dead Key
async function reviveApiKey(req, res) {
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) return res.status(401).send('Forbidden');
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
  // حماية المسار
  if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. جلب التكاليف (من الـ Views التي أنشأناها)
    const { data: dailyCosts } = await supabase
        .from('view_daily_ai_costs')
        .select('*')
        .limit(7); // آخر 7 أيام

    const { data: monthlyCosts } = await supabase
        .from('view_monthly_ai_costs')
        .select('*')
        .limit(1); // الشهر الحالي

    // 2. جلب التنبؤات الصحية (الخوارزمية الذكية)
    const healthCheck = await predictSystemHealth();

    // 3. تجميع البيانات
    const dashboardData = {
        financials: {
            today_cost: dailyCosts[0]?.estimated_cost_usd || 0,
            month_cost: monthlyCosts[0]?.estimated_cost_usd || 0,
            daily_history: dailyCosts, // للرسم البياني (Chart)
            currency: 'USD'
        },
        system_health: healthCheck,
        keys_summary: {
            total: healthCheck.metrics.activeKeys + healthCheck.metrics.deadKeys,
            active: healthCheck.metrics.activeKeys,
            dead: healthCheck.metrics.deadKeys
        }
    };

    res.json(dashboardData);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
async function activateLaunchKeys(req, res) {
    // حماية
    if (req.headers['x-admin-secret'] !== process.env.NIGHTLY_JOB_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // 1. تحديث الحالة في الداتابيز
        const { error } = await supabase
            .from('system_api_keys')
            .update({ status: 'active' })
            .eq('status', 'reserved');

        if (error) throw error;

        // سنضيف دالة reload بسيطة في KeyManager
        await require('../services/ai/keyManager').reloadKeys(); 

        res.json({ success: true, message: "🚀 All reserved keys are now ACTIVE! Let the games begin." });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
  activateLaunchKeys
};
