
// index.js
'use strict';
const app = require('./app');
const CONFIG = require('./config');
const logger = require('./utils/logger');
const { setGenerateWithFailover } = require('./utils'); // For utils/index.js ensureJsonOrRepair
const { initializeFirestore, getFirestoreInstance } = require('./services/data/firestore');
const embeddingService = require('./services/embeddings');
const memoryManager = require('./services/ai/managers/memoryManager'); // Renamed from memoryManager.js
const { initializeModelPools } = require('./services/ai');
const generateWithFailover = require('./services/ai/failover');
const { initDataHelpers } = require('./services/data/helpers');
const { initJobWorker, jobWorkerLoop, stopWorker } = require('./services/jobs/worker');

// Import controllers and managers for initialization
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


// ---------------- BOOT & INIT ----------------
async function boot() {
  // 1. Initialize Firestore
  const db = initializeFirestore();

  // 2. Initialize AI Model Pools
  initializeModelPools();

  // 3. Inject generateWithFailover into utils for ensureJsonOrRepair
  setGenerateWithFailover(generateWithFailover);

  // 4. Initialize Embedding Service
  try {
    embeddingService.init({ db, CONFIG });
  } catch (err) {
    logger.error('❌ Embedding Service initialization failed:', err.message);
    process.exit(1);
  }

  // 5. Initialize AI Managers (order matters for dependencies)
  try {
    memoryManager.init({ db, embeddingService }); // memoryManager depends on embeddingService
    initDataHelpers({ embeddingService, generateWithFailover }); // data/helpers depends on embeddingService & generateWithFailover

    initConversationManager({ generateWithFailover });
    initCurriculumManager({ embeddingService });
    initNotificationManager({ generateWithFailover, getProgress: require('./services/data/helpers').getProgress }); // Circular dep, pass function
    initPlannerManager({ generateWithFailover });
    initQuizManager({ generateWithFailover });
    initReviewManager({ generateWithFailover });
    initSuggestionManager({ generateWithFailover });
    initTrafficManager({ generateWithFailover });
    initToDoManager({ generateWithFailover });

    // ChatController depends on many managers, so initialize it last
    initChatController({ generateWithFailover, saveMemoryChunk: memoryManager.saveMemoryChunk });
    initAdminController({ generateWithFailover }); // AdminController also needs generateWithFailover

    // Job worker needs handleGeneralQuestion from chatController, so initialize after chatController
    initJobWorker({ handleGeneralQuestion });

  } catch (err) {
    logger.error('❌ AI Manager initialization failed:', err.message);
    process.exit(1);
  }

  // 6. Start job worker loop
  setTimeout(jobWorkerLoop, 1000); // Start after a small delay

  // 7. Start the server
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

  // 8. Handle graceful shutdown
  function shutdown(sig) {
    logger.info(`Received ${sig}, shutting down...`);
    stopWorker(); // Stop the job worker
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

module.exports = { app, server: null }; // server will be set after boot
