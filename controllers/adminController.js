
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const { runReEngagementManager } = require('../services/ai/managers/notificationManager');
const { escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const logger = require('../utils/logger');
const { generateSmartStudyStrategy } = require('../services/data/helpers');

let generateWithFailoverRef; // Injected dependency
const embeddingService = require('../services/embeddings'); // تأكد من المسار

// دالة لفهرسة درس واحد فقط عند الطلب
async function indexSpecificLesson(req, res) {
  try {
    const { lessonId } = req.body; // نرسل الـ ID
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    const db = getFirestoreInstance();
    
    // 1. جلب محتوى الدرس
    const contentDoc = await db.collection('lessonsContent').doc(lessonId).get();
    if (!contentDoc.exists) return res.status(404).json({ error: 'Content not found' });
    
    const text = contentDoc.data().content || '';
    if (!text) return res.status(400).json({ error: 'Lesson is empty' });

    // 2. التقسيم (Chunking) - نفس منطق indexCurriculum
    // (للتبسيط هنا سنفترض دالة تقسيم بسيطة أو نعيد استخدام تلك الموجودة)
    const chunks = text.match(/[\s\S]{1,1000}/g) || [text]; 

    const batch = db.batch();
    
    // 3. مسح الـ Embeddings القديمة لهذا الدرس (لتجنب التكرار عند التحديث)
    const oldEmbeddings = await db.collection('curriculumEmbeddings').where('lessonId', '==', lessonId).get();
    oldEmbeddings.forEach(doc => batch.delete(doc.ref));

    // 4. إنشاء Embeddings جديدة
    for (const chunk of chunks) {
      const vec = await embeddingService.generateEmbedding(chunk);
      const newRef = db.collection('curriculumEmbeddings').doc();
      batch.set(newRef, {
        lessonId,
        // أضفنا العنوان والمسار هنا ليعرف النظام السياق
        lessonTitle: req.body.lessonTitle || 'Unknown Title', 
        pathId: req.body.pathId || 'Unknown Path',
        chunkText: chunk,
        embedding: vec,
        type: 'curriculum', // نميزه أنه منهج
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
function initAdminController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Admin Controller requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

const db = getFirestoreInstance();


async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // الرد الفوري للكرون (هذا ما رأيته في الصورة 1)
    res.status(202).json({ message: 'Nightly analysis job started.' });

    // 🔥 أضفنا هذا اللوج لنرى البداية بوضوح
    logger.log('🚀 [CRON START] Nightly analysis triggered manually...');

    // --- التعديل للاختبار ---
    // const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    
    // سنلغي شرط الوقت مؤقتاً لكي يعمل عليك أنت!
    const inactiveUsersSnapshot = await db.collection('userProgress')
      // .where('lastLogin', '<', twoDaysAgo.toISOString()) // ❌ عطلنا هذا السطر
      .limit(5) // نحدد العدد بـ 5 فقط للتجربة
      .get();

    logger.log(`🔎 [CRON] Found ${inactiveUsersSnapshot.size} potential users to analyze.`);

    if (inactiveUsersSnapshot.empty) {
      logger.log('No users found. Job finished.');
      return;
    }

    const analysisPromises = [];
    inactiveUsersSnapshot.forEach(doc => {
      logger.log(`⚡ [CRON] Processing user: ${doc.id}`); // لنعرف من يتم تحليله
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    logger.success(`✅ [CRON] Nightly analysis finished for ${inactiveUsersSnapshot.size} users.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
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

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    res.status(202).json({ message: 'Nightly analysis job started.' });

    logger.log(`Starting nightly analysis...`);

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const inactiveUsersSnapshot = await db.collection('userProgress')
      .where('lastLogin', '<', twoDaysAgo.toISOString()) // Ensure string comparison
      .get();

    if (inactiveUsersSnapshot.empty) {
      logger.log('No inactive users found. Job finished.');
      return;
    }

    const analysisPromises = [];
    inactiveUsersSnapshot.forEach(doc => {
      analysisPromises.push(runNightlyAnalysisForUser(doc.id));
    });

    await Promise.all(analysisPromises);
    logger.log(`Nightly analysis finished for ${inactiveUsersSnapshot.size} users.`);

  } catch (error) {
    logger.error('[/run-nightly-analysis] Critical error:', error);
  }
}

async function generateTitleRoute(req, res) {
  try {
    const { message, language = 'Arabic' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    const prompt = `Generate a very short, descriptive title (2-4 words) for the following user message. The title should be in ${language}. Respond with ONLY the title text, no JSON or extra words.\n\nMessage: "${escapeForPrompt(safeSnippet(message, 300))}"\n\nTitle:`;

    if (!generateWithFailoverRef) {
      logger.error('generateTitleRoute: generateWithFailover is not set.');
      return res.status(500).json({ title: message.substring(0, 30) });
    }
    const modelResp = await generateWithFailoverRef('titleIntent', prompt, {
      label: 'GenerateTitle',
      timeoutMs: 5000,
    });

    const title = await extractTextFromResult(modelResp);

    if (!title) {
      return res.json({ title: message.substring(0, 30) });
    }

    return res.json({ title: title.replace(/["']/g, '') });
  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    const fallbackTitle = req.body.message ? req.body.message.substring(0, 30) : 'New Chat';
    return res.status(500).json({ title: fallbackTitle });
  }
}

module.exports = {
  initAdminController,
  enqueueJobRoute,
  runNightlyAnalysis,
  generateTitleRoute,
};
