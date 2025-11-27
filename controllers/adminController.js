
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const logger = require('../utils/logger');
const { generateSmartStudyStrategy } = require('../services/data/helpers'); 
const db = getFirestoreInstance(); 
const embeddingService = require('../services/embeddings'); 

let generateWithFailoverRef; 

function initAdminController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

// --- 1. Helper: حساب وقت الذروة للمستخدم ---
async function calculateUserPrimeTime(userId) {
   // (تم الإبقاء على الدالة كما هي، مع الافتراض أنها تستخدم getFirestoreInstance الصحيح)
   return 20; 
}

// --- 2. THE NIGHTLY BRAIN ---

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    // تأكد من ضبط NIGHTLY_JOB_SECRET في Environment Variables في Render
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    res.status(202).json({ message: 'Nightly analysis job started.' });
    
    // استخدام FirestoreAdapter الذي كتبناه
    const db = getFirestoreInstance();
    // Supabase query to get active users (simulation)
    // ملاحظة: FirestoreAdapter يرجع docs. data() يرجع الصف
    const snapshot = await db.collection('userProgress').limit(50).get(); 

    if (snapshot.empty) {
      logger.log('[CRON] No users found to analyze.');
      return;
    }

    const analysisPromises = [];
    snapshot.forEach(doc => {
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    logger.success(`[CRON] Finished analysis.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
  }
}

// --- 3. THE WORKER (FIXED) ---


async function runNightlyAnalysisForUser(userId) {
  try {
    const db = getFirestoreInstance();

    // A) Smart Strategy
    const newMissions = await generateSmartStudyStrategy(userId);
    if (newMissions && newMissions.length > 0) {
       // 🔥 MANUAL ARRAY MERGE FOR SUPABASE
       const userDoc = await db.collection('users').doc(userId).get();
       if (userDoc.exists) {
           const userData = userDoc.data();
           const currentMissions = userData.aiDiscoveryMissions || [];
           // Merge unique
           const updated = [...new Set([...currentMissions, ...newMissions])];
           
           await db.collection('users').doc(userId).update({
             aiDiscoveryMissions: updated
           });
       }
    }
    // ب) إشعار إعادة التفاعل الذكي
    const userDoc = await db.collection('userProgress').doc(userId).get();
    if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData.lastLogin) {
            const lastLogin = new Date(userData.lastLogin);
            const daysInactive = (Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24);

            // تحديد الشدة حسب مدة الغياب
            let intensity = null;
            if (daysInactive >= 2 && daysInactive < 3) intensity = 'gentle';
            else if (daysInactive >= 5 && daysInactive < 6) intensity = 'motivational';
            else if (daysInactive >= 10 && daysInactive < 11) intensity = 'urgent';

            if (intensity) {
                // 🔥 1. توليد الرسالة المخصصة (بالذكاء الاصطناعي)
                const reEngagementMessage = await runReEngagementManager(userId, intensity);
                
                 if (reEngagementMessage) {
                    const primeHour = await calculateUserPrimeTime(userId);
                    const scheduleTime = new Date();
                    scheduleTime.setHours(primeHour, 0, 0, 0);
                    if (scheduleTime < new Date()) scheduleTime.setDate(scheduleTime.getDate() + 1);

                    // 🔥 هنا نضع الهيكل (JSON) الذي سألت عنه
                    await enqueueJob({
                        type: 'scheduled_notification',
                        userId: userId,
                        sendAt: admin.firestore.Timestamp.fromDate(scheduleTime),
                        payload: {
                            title: intensity === 'urgent' ? 'وين راك؟ 😢' : 'تذكير للدراسة',
                            message: reEngagementMessage,
                            type: 're_engagement', // ✅ النوع
                            // ✅ نحفظ النص والشدة لنستخدمهم لما يرجع المستخدم
                            meta: { 
                                originalMessage: reEngagementMessage,
                                intensity: intensity
                            }
                        }
                    });
                    logger.info(`[Nightly] Scheduled re-engagement for ${userId}`);
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
    const { lessonId } = req.body;
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    const contentDoc = await db.collection('lessonsContent').doc(lessonId).get();
    if (!contentDoc.exists) return res.status(404).json({ error: 'Content not found' });
    
    const text = contentDoc.data().content || '';
    if (!text) return res.status(400).json({ error: 'Lesson is empty' });

    const chunks = text.match(/[\s\S]{1,1000}/g) || [text]; 
    const batch = db.batch();
    
    const oldEmbeddings = await db.collection('curriculumEmbeddings').where('lessonId', '==', lessonId).get();
    oldEmbeddings.forEach(doc => batch.delete(doc.ref));

    for (const chunk of chunks) {
      const vec = await embeddingService.generateEmbedding(chunk);
      const newRef = db.collection('curriculumEmbeddings').doc();
      batch.set(newRef, {
        lessonId,
        lessonTitle: req.body.lessonTitle || 'Unknown Title', 
        pathId: req.body.pathId || 'Unknown Path',
        chunkText: chunk,
        embedding: vec,
        type: 'curriculum',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
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

    if (!generateWithFailoverRef) return res.status(500).json({ title: message.substring(0, 30) });
    
    const modelResp = await generateWithFailoverRef('titleIntent', prompt, { label: 'GenerateTitle', timeoutMs: 5000 });
    const title = await extractTextFromResult(modelResp);

    return res.json({ title: title ? title.replace(/["']/g, '') : message.substring(0, 30) });
  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    return res.status(500).json({ title: req.body.message ? req.body.message.substring(0, 30) : 'New Chat' });
  }
}

async function calculateUserPrimeTime(userId) {
  try {
    const db = getFirestoreInstance();
    // نجلب آخر 50 حدث "فتح تطبيق"
    const eventsSnapshot = await db.collection('userBehaviorAnalytics')
      .doc(userId)
      .collection('events')
      .where('name', '==', 'app_open') // أو session_start
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    if (eventsSnapshot.empty) return 20; // الافتراضي: 8 مساءً

    // حساب الساعة الأكثر تكراراً
    const hourCounts = {};
    eventsSnapshot.forEach(doc => {
      const date = doc.data().timestamp.toDate();
      // نعدل التوقيت حسب المنطقة الزمنية للجزائر (UTC+1) تقريباً
      // أو نعتمد على ساعة السيرفر إذا كانت مضبوطة
      const hour = date.getHours(); 
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    // إيجاد الساعة ذات أعلى تكرار
    const primeHour = Object.keys(hourCounts).reduce((a, b) => hourCounts[a] > hourCounts[b] ? a : b);
    
    return parseInt(primeHour);
  } catch (e) {
    return 20; // Fallback
  }
}

module.exports = {
  initAdminController,
  indexSpecificLesson,
  runNightlyAnalysis,
  enqueueJobRoute,
  generateTitleRoute,
};
