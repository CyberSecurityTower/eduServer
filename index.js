
// index.js
'use strict';

require('dotenv').config();

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

// ✅ استيراد المتحكمات والمدراء (فقط الذين أبقينا عليهم)
const { initChatController, handleGeneralQuestion } = require('./controllers/chatController');
const { initAdminController } = require('./controllers/adminController');

// ✅ استيراد المدراء الأساسيين (RAG Context Managers)
const { initConversationManager } = require('./services/ai/managers/conversationManager');
const { initCurriculumManager } = require('./services/ai/managers/curriculumManager');
const { initMemoryManager } = require('./services/ai/managers/memoryManager'); // تأكد من الاسم الصحيح للملف

// ---------------- BOOT & INIT ----------------
async function boot() {
  try {
    // 1. Initialize Firestore
    const db = initializeFirestore();

    // 2. Initialize AI Model Pools
    initializeModelPools();

    // 3. Inject Dependencies
    setGenerateWithFailover(generateWithFailover);

    // 4. Initialize Embedding Service
    embeddingService.init({ db, CONFIG });

    // 5. Initialize Helpers
    initDataHelpers({ embeddingService, generateWithFailover });

    // 6. Initialize AI Managers (فقط الأساسية للسياق)
    // ملاحظة: حذفنا todo, planner, quiz, notification, review, suggestion, traffic
    // لأن منطقهم أصبح مدمجاً أو غير ضروري للتشغيل الأساسي الآن.
    
    // تأكد أن ملفات managers هذه موجودة ولم تحذفها
    initMemoryManager({ db, embeddingService }); 
    initConversationManager({ generateWithFailover });
    initCurriculumManager({ embeddingService });

    // 7. Initialize Controllers
    // ChatController هو العقل المدبر الآن
    // نحتاج تمرير saveMemoryChunk له، وهي موجودة في memoryManager
    const memoryManager = require('./services/ai/managers/memoryManager');
    
    initChatController({ 
      generateWithFailover, 
      saveMemoryChunk: memoryManager.saveMemoryChunk 
    });
    
    initAdminController({ generateWithFailover });

    // 8. Initialize Job Worker
    initJobWorker({ handleGeneralQuestion });

    // 9. Start Job Loop
    setTimeout(jobWorkerLoop, 1000);

    // 10. Start Server
    const server = app.listen(CONFIG.PORT, () => {
      logger.success(`EduAI Brain V2.0 (GenUI) running on port ${CONFIG.PORT}`);
    });

    // Graceful Shutdown
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
