
// index.js
'use strict';

const app = require('./app');
const CONFIG = require('./config');
const logger = require('./utils/logger');
const { setGenerateWithFailover } = require('./utils');
const { initializeFirestore } = require('./services/data/firestore');
const embeddingService = require('./services/embeddings');
const { initializeModelPools } = require('./services/ai');
const generateWithFailover = require('./services/ai/failover');
const { initDataHelpers } = require('./services/data/helpers');
const { initJobWorker, jobWorkerLoop, stopWorker } = require('./services/jobs/worker');

const { initSessionAnalyzer } = require('./services/ai/managers/sessionAnalyzer'); 
const { checkScheduledActions } = require('./services/jobs/worker'); 

const { initChatController, handleGeneralQuestion } = require('./controllers/chatController');
const { initAdminController } = require('./controllers/adminController');

// Managers
const { initConversationManager } = require('./services/ai/managers/conversationManager');
const { initCurriculumManager } = require('./services/ai/managers/curriculumManager');
const { initMemoryManager } = require('./services/ai/managers/memoryManager');
const { initSuggestionManager } = require('./services/ai/managers/suggestionManager'); // ✅ تمت الإعادة

async function boot() {
  try {
    const db = initializeFirestore();
    initializeModelPools();
    setGenerateWithFailover(generateWithFailover);
    embeddingService.init({ db, CONFIG });
    initDataHelpers({ embeddingService, generateWithFailover });
    initSessionAnalyzer({ generateWithFailover }); 
    // Initialize Managers
    initMemoryManager({ db, embeddingService });
    initConversationManager({ generateWithFailover });
    initCurriculumManager({ embeddingService });
    initSuggestionManager({ generateWithFailover }); // ✅ تهيئة مدير الاقتراحات

    // Initialize Controllers
    const memoryManager = require('./services/ai/managers/memoryManager');
    initChatController({ 
      generateWithFailover, 
      saveMemoryChunk: memoryManager.saveMemoryChunk 
    });
    initAdminController({ generateWithFailover });

    initJobWorker({ handleGeneralQuestion });

    setTimeout(jobWorkerLoop, 1000);
    // 🔥 تشغيل الـ Ticker كل 60 ثانية (1 دقيقة)
    // هذا هو القلب النابض الذي سيفحص المواعيد بدقة
    setInterval(() => {
      checkScheduledActions().catch(e => logger.error('Ticker failed:', e));
    }, 60 * 1000);
    const server = app.listen(CONFIG.PORT, () => {
      logger.success(`EduAI Brain V2.1 (Production) running on port ${CONFIG.PORT}`);
    });

    process.on('SIGINT', () => {
      stopWorker();
      server.close(() => process.exit(0));
    });

  } catch (err) {
    logger.error('❌ Fatal error during boot:', err.stack || err);
    process.exit(1);
  }
}

boot();

module.exports = { app };
