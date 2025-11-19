
'use strict';

// --- التعديل الذكي ---
// نحاول استدعاء dotenv، إذا لم نجدها (نحن في Render)، نتجاهل الخطأ ونكمل
try {
  require('dotenv').config();
} catch (e) {
  // لا مشكلة، نحن في بيئة الإنتاج (Render) والمفاتيح موجودة في Environment Variables
}
// ---------------------

const app = require('./app');
const CONFIG = require('./config');
const logger = require('./utils/logger');
const { setGenerateWithFailover } = require('./utils');
const { initializeFirestore } = require('./services/data/firestore');
const embeddingService = require('./services/embeddings');
const memoryManager = require('./services/ai/managers/memoryManager');
const { initializeModelPools } = require('./services/ai');
const generateWithFailover = require('./services/ai/failover');
const { initDataHelpers } = require('./services/data/helpers');
// استيراد resetStuckJobs
const { initJobWorker, jobWorkerLoop, stopWorker, resetStuckJobs } = require('./services/jobs/worker');

// ... (Imports controllers) ...
const { initChatController, handleGeneralQuestion } = require('./controllers/chatController');
const { initAdminController } = require('./controllers/adminController');
const { initConversationManager } = require('./services/ai/managers/conversationManager');
const { initCurriculumManager } = require('./services/ai/managers/curriculumManager');
const { initNotificationManager } = require('./services/ai/managers/notificationManager');
const { initPlannerManager } = require('./services/ai/managers/plannerManager');
const { initQuizManager } = require('./services/ai/managers/quizManager');
const { initReviewManager } = require('./services/ai/managers/reviewManager');
const { initSuggestionManager } = require('./services/ai/managers/suggestionManager');
const { initTrafficManager } = require('./services/ai/managers/trafficManager');
const { initToDoManager } = require('./services/ai/managers/todoManager');

async function boot() {
  // 1. Initialize Firestore
  const db = initializeFirestore();

  // 2. Initialize AI Model Pools
  initializeModelPools();

  // 3. Inject generateWithFailover
  setGenerateWithFailover(generateWithFailover);

  // 4. Initialize Embedding Service
  try {
    embeddingService.init({ db, CONFIG });
  } catch (err) {
    logger.error('❌ Embedding Service initialization failed:', err.message);
    process.exit(1);
  }

  // 5. Initialize AI Managers
  try {
    memoryManager.init({ db, embeddingService });
    initDataHelpers({ embeddingService, generateWithFailover });

    initConversationManager({ generateWithFailover });
    initCurriculumManager({ embeddingService });
    initNotificationManager({ generateWithFailover, getProgress: require('./services/data/helpers').getProgress });
    initPlannerManager({ generateWithFailover });
    initQuizManager({ generateWithFailover });
    initReviewManager({ generateWithFailover });
    initSuggestionManager({ generateWithFailover });
    initTrafficManager({ generateWithFailover });
    initToDoManager({ generateWithFailover });

    initChatController({ generateWithFailover, saveMemoryChunk: memoryManager.saveMemoryChunk });
    initAdminController({ generateWithFailover });

    initJobWorker({ handleGeneralQuestion });

  } catch (err) {
    logger.error('❌ AI Manager initialization failed:', err.message);
    process.exit(1);
  }

  // 6. Reset Stuck Jobs (CRITICAL FIX)
  // نقوم بتنظيف المهام العالقة قبل بدء استقبال الطلبات أو تشغيل الـ Worker Loop
  await resetStuckJobs();

  // 7. Start job worker loop
  setTimeout(jobWorkerLoop, 1000);

  // 8. Start the server
  const server = app.listen(CONFIG.PORT, () => {
    logger.success(`EduAI Brain V18.0 running on port ${CONFIG.PORT}`);
    (async () => {
      try {
        await generateWithFailover('titleIntent', 'ping', { label: 'warmup', timeoutMs: 2000 });
        logger.info('💡 Model warmup done.');
      } catch (e) {
        logger.warn('💡 Model warmup failed (non-fatal):', e.message);
      }
    })();
  });

  // ... (Shutdown logic remains the same) ...
  function shutdown(sig) {
    logger.info(`Received ${sig}, shutting down...`);
    stopWorker();
    server.close((err) => {
      if (err) {
        logger.error('Error closing HTTP server:', err);
        process.exit(1);
      }
      logger.info('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => logger.error('unhandledRejection', r));
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', err.stack || err);
    process.exit(1);
  });
}

boot().catch(err => {
  logger.error('Fatal error during boot:', err.stack || err);
  process.exit(1);
});

module.exports = { app, server: null };
