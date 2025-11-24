
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const { escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const logger = require('../utils/logger');
// ✅ استيراد استراتيجية الدراسة الذكية
const { generateSmartStudyStrategy } = require('../services/data/helpers'); 
const embeddingService = require('../services/embeddings');

let generateWithFailoverRef; 

function initAdminController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Admin Controller requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

const db = getFirestoreInstance();

// --- 1. THE NIGHTLY BRAIN (LOGIC) ---

async function runNightlyAnalysisForUser(userId) {
  try {
    // A. 🧠 تشغيل الاستراتيجية الذكية (إضافة مهام سرية)
    const newMissions = await generateSmartStudyStrategy(userId);

    if (newMissions && newMissions.length > 0) {
       await db.collection('users').doc(userId).update({
         // إضافة المهام الجديدة للقائمة الحالية
         aiDiscoveryMissions: admin.firestore.FieldValue.arrayUnion(...newMissions)
       }).catch(err => {
         // في حال كان الحقل غير موجود، ننشئه
         return db.collection('users').doc(userId).set({
            aiDiscoveryMissions: newMissions
         }, { merge: true });
       });
       
       logger.success(`[NightlyStrategy] 🎯 Added ${newMissions.length} strategic missions for user ${userId}`);
    } else {
        logger.info(`[NightlyStrategy] No new missions needed for user ${userId}`);
    }

    // B. 🔔 منطق إعادة التفاعل (للغائبين فقط)
    // نتحقق من آخر ظهور لإرسال إشعار إذا لزم الأمر
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;
    
    // (يمكنك إضافة شروط هنا إذا أردت إرسال إشعار push notification)

  } catch (error) {
    logger.error(`Nightly analysis failed for user ${userId}:`, error);
  }
}

// --- 2. THE CRON TRIGGER (ROUTE) ---

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // الرد الفوري للكرون
    res.status(202).json({ message: 'Nightly analysis job started.' });

    logger.log('🚀 [CRON START] Nightly analysis triggered manually...');

    // 🔥 وضع الاختبار: تم تعطيل شرط الوقت ليعمل عليك الآن
    // const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    
    const usersSnapshot = await db.collection('userProgress')
      // .where('lastLogin', '<', twoDaysAgo.toISOString()) // ❌ معطل للاختبار
      .limit(10) // نحدد العدد للتجربة
      .get();

    logger.log(`🔎 [CRON] Found ${usersSnapshot.size} users to analyze.`);

    if (usersSnapshot.empty) {
      logger.log('No users found. Job finished.');
      return;
    }

    const analysisPromises = [];
    usersSnapshot.forEach(doc => {
      logger.log(`⚡ [CRON] Processing user: ${doc.id}`);
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    logger.success(`✅ [CRON] Nightly analysis finished for ${usersSnapshot.size} users.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
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

module.exports = {
  initAdminController,
  indexSpecificLesson,
  runNightlyAnalysis,
  enqueueJobRoute,
  generateTitleRoute,
};
