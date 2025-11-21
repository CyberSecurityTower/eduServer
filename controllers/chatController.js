
// controllers/adminController.js
'use strict';

const CONFIG = require('../config');
const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { enqueueJob } = require('../services/jobs/queue');
const embeddingService = require('../services/embeddings'); // ✅ هام جداً للفهرسة
const { escapeForPrompt, safeSnippet, extractTextFromResult } = require('../utils');
const logger = require('../utils/logger');
const PROMPTS = require('../config/ai-prompts');

let generateWithFailoverRef; // Injected dependency

function initAdminController(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Admin Controller requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Admin Controller initialized.');
}

const db = getFirestoreInstance();

// ============================================================================
// 1. FCM TOKEN MANAGEMENT (تحديث توكن الإشعارات)
// ============================================================================

async function updateFcmToken(req, res) {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ error: 'userId and token are required.' });
    }

    // حفظ التوكن في وثيقة المستخدم (Merge لعدم حذف البيانات الأخرى)
    await db.collection('users').doc(userId).set({
      fcmToken: token,
      lastTokenUpdate: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    logger.info(`FCM Token updated for user ${userId}`);
    res.status(200).json({ success: true });

  } catch (error) {
    logger.error('Error updating FCM token:', error);
    res.status(500).json({ error: 'Failed to update token' });
  }
}

// ============================================================================
// 2. CURRICULUM INDEXING (تحديث درس محدد في الـ RAG)
// ============================================================================

async function indexSpecificLesson(req, res) {
  try {
    const { lessonId, lessonTitle, pathId } = req.body;
    
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    // 1. جلب محتوى الدرس من قاعدة البيانات
    const contentDoc = await db.collection('lessonsContent').doc(lessonId).get();
    if (!contentDoc.exists) return res.status(404).json({ error: 'Content not found' });
    
    const text = contentDoc.data().content || '';
    if (!text) return res.status(400).json({ error: 'Lesson is empty' });

    // 2. تقسيم النص (Chunking)
    // نقسم النص إلى أجزاء صغيرة (حوالي 1000 حرف) لضمان دقة البحث
    const chunks = text.match(/[\s\S]{1,1000}/g) || [text]; 

    const batch = db.batch();
    
    // 3. مسح الـ Embeddings القديمة لهذا الدرس (لتجنب التكرار عند التعديل)
    const oldEmbeddings = await db.collection('curriculumEmbeddings').where('lessonId', '==', lessonId).get();
    oldEmbeddings.forEach(doc => batch.delete(doc.ref));

    // 4. إنشاء وحفظ Embeddings جديدة
    for (const chunk of chunks) {
      const vec = await embeddingService.generateEmbedding(chunk);
      
      if (vec && vec.length > 0) {
        const newRef = db.collection('curriculumEmbeddings').doc();
        batch.set(newRef, {
          lessonId,
          lessonTitle: lessonTitle || 'Updated Lesson', 
          pathId: pathId || 'Unknown Path',
          chunkText: chunk,
          embedding: vec,
          type: 'curriculum', // نميزه أنه منهج دراسي
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    await batch.commit();
    logger.success(`Indexed ${chunks.length} chunks for lesson ${lessonId}`);
    return res.json({ success: true, message: `Successfully indexed ${chunks.length} chunks.` });

  } catch (e) {
    logger.error('Indexing failed:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ============================================================================
// 3. UTILITY ROUTES (أدوات مساعدة: العناوين، الجدولة اليدوية)
// ============================================================================

async function generateTitleRoute(req, res) {
  try {
    const { message, language = 'Arabic' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    // استخدام البرومبت المركزي
    const prompt = PROMPTS.chat.generateTitle(message, language);

    if (!generateWithFailoverRef) {
      // Fallback في حالة عدم تهيئة النموذج
      return res.json({ title: message.substring(0, 30) });
    }

    const modelResp = await generateWithFailoverRef('titleIntent', prompt, {
      label: 'GenerateTitle',
      timeoutMs: 5000,
    });

    const title = await extractTextFromResult(modelResp);
    
    // تنظيف العنوان من علامات التنصيص
    const cleanTitle = (title || message.substring(0, 30)).replace(/["']/g, '');
    
    return res.json({ title: cleanTitle });

  } catch (err) {
    logger.error('/generate-title error:', err.stack);
    const fallbackTitle = req.body.message ? req.body.message.substring(0, 30) : 'New Chat';
    return res.status(500).json({ title: fallbackTitle });
  }
}

async function enqueueJobRoute(req, res) {
  try {
    const job = req.body;
    if (!job) return res.status(400).json({ error: 'job body required' });
    const id = await enqueueJob(job);
    return res.json({ jobId: id });
  } catch (err) { 
    res.status(500).json({ error: String(err) }); 
  }
}

// ============================================================================
// 4. LEGACY SUPPORT (التحليل الليلي القديم)
// ============================================================================

async function runNightlyAnalysis(req, res) {
  try {
    const providedSecret = req.headers['x-job-secret'];
    if (providedSecret !== CONFIG.NIGHTLY_JOB_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // ⚠️ ملاحظة: تم نقل المنطق الذكي إلى worker.js (Real-time Scheduler)
    // هذه الدالة موجودة فقط للتوافق مع أي CRON JOB قديم
    
    logger.log(`Legacy Nightly Analysis triggered (Skipping heavy operations in favor of Ticker).`);
    res.status(202).json({ message: 'Legacy job skipped. Use Ticker for real-time scheduling.' });

  } catch (error) {
    logger.error('[/run-nightly-analysis] error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  initAdminController,
  enqueueJobRoute,
  runNightlyAnalysis,
  generateTitleRoute,
  indexSpecificLesson, // ✅ المصدر الجديد للفهرسة
  updateFcmToken       // ✅ المصدر الجديد للتوكن
};
