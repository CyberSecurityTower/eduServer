
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const logger = require('../utils/logger');
const { generateSmartStudyStrategy } = require('../services/data/helpers'); 
const embeddingService = require('../services/embeddings'); 

const db = getFirestoreInstance(); 
let generateWithFailoverRef; 

function initAdminController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

// --- Helpers for Strings (Added to prevent ReferenceErrors) ---
function escapeForPrompt(str) {
  return str ? str.replace(/"/g, '\\"').replace(/\n/g, ' ') : '';
}
function safeSnippet(str, length) {
  return str && str.length > length ? str.substring(0, length) + '...' : str;
}
async function extractTextFromResult(result) {
  // Adjust based on your actual AI response structure
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

    await Promise.allSettled(analysisPromises); // Use allSettled so one error doesn't stop others
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
      .where('metadata.lesson_id', '==', lessonId) // Updated to match structure below
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
    } // <--- Fixed: Missing closing brace added here

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
  // حماية بسيطة بكلمة سر في الهيدر
  if (req.headers['x-admin-secret'] !== 'my-secret-islam-123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // رد سريع عشان ما يصير Timeout في Postman
  res.json({ message: 'Indexing started in background...' });

  try {
    const { getFirestoreInstance } = require('../services/data/firestore');
    const embeddingService = require('../services/embeddings');
    const db = getFirestoreInstance();

    // 1. جلب كل المسارات
    const pathsSnapshot = await db.collection('educationalPaths').get();
    let totalLessons = 0;

    // سنستخدم حلقة تكرارية بسيطة (ليست الأسرع لكنها الأضمن)
    // ملاحظة: هذا الكود ثقيل، في Render المجاني قد يتوقف إذا كانت البيانات ضخمة
    // لكنه سيعمل لعدد قليل من الدروس
    
    // هذا مجرد Pseudo-code للمنطق، عليك تكييفه مع هيكلة بياناتك
    /* 
      Loop paths -> Loop subjects -> Loop lessons
      Get content from 'lessonsContent'
      Generate Embedding
      Save to 'curriculumEmbeddings'
    */
    
    logger.info('Background indexing finished');
  } catch (e) {
    logger.error('Indexing failed', e);
  }
}
module.exports = {
  initAdminController,
  indexSpecificLesson,
  runNightlyAnalysis,
  enqueueJobRoute,
  generateTitleRoute,
  triggerFullIndexing 
};
