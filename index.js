
// index.js
'use strict';

// ❌ تم الحذف: require('dotenv').config();

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
