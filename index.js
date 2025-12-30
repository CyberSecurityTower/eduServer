
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
const { initGhostEngine } = require('./services/engines/ghostTeacher'); 
const { initChatController, handleGeneralQuestion } = require('./controllers/chatController');
const { initAdminController } = require('./controllers/adminController');
const { initExamWorker } = require('./services/jobs/examWorker');

// Managers
const { initConversationManager } = require('./services/ai/managers/conversationManager');
const { initCurriculumManager } = require('./services/ai/managers/curriculumManager');
const { initMemoryManager } = require('./services/ai/managers/memoryManager');
const { initSuggestionManager } = require('./services/ai/managers/suggestionManager');
const { initNotificationManager } = require('./services/ai/managers/notificationManager');
const { initQuizManager } = require('./services/ai/managers/quizManager');
const { initReviewManager } = require('./services/ai/managers/reviewManager');
const { initTodoManager } = require('./services/ai/managers/todoManager');
const { initTrafficManager } = require('./services/ai/managers/trafficManager');

//    استيراد منقذ الستريك (تم ايقافه مؤقتا)
//const { initStreakRescue, runStreakRescueMission } = require('./services/jobs/streakRescue');

async function boot() {
  try {
    const db = initializeFirestore();
    initializeModelPools();
    setGenerateWithFailover(generateWithFailover);
    initGhostEngine({ generateWithFailover }); 

    embeddingService.init({ db, CONFIG });
    initDataHelpers({ embeddingService, generateWithFailover });
    initSessionAnalyzer({ generateWithFailover }); 
    initExamWorker({ generateWithFailover });

    // Initialize Managers
    initNotificationManager({ 
      generateWithFailover, 
      getProgress: require('./services/data/helpers').getProgress 
    });
    initMemoryManager({ db, embeddingService, generateWithFailover  });
    initConversationManager({ generateWithFailover });
    initCurriculumManager({ embeddingService });
    initSuggestionManager({ generateWithFailover });
    initQuizManager({ generateWithFailover });
    initReviewManager({ generateWithFailover });
    initTodoManager({ generateWithFailover });
    initTrafficManager({ generateWithFailover });
    
    // ✅ تهيئة منقذ الستريك
    //initStreakRescue({ generateWithFailover });

    // Initialize Controllers
    const memoryManager = require('./services/ai/managers/memoryManager');
    initChatController({ 
      generateWithFailover, 
      saveMemoryChunk: memoryManager.saveMemoryChunk 
    });
    initAdminController({ generateWithFailover });

    initJobWorker({ handleGeneralQuestion });

    setTimeout(jobWorkerLoop, 1000);
    
    // 🔥 Ticker: فحص المواعيد كل دقيقة
    setInterval(() => {
      checkScheduledActions().catch(e => logger.error('Ticker failed:', e));
    }, 60 * 1000);
/*
    // 🔥 Cron: فحص الستريك كل ساعة
    setInterval(() => {
      logger.log('⏰ Hourly Cron: Checking for streaks at risk...');
      runStreakRescueMission().catch(e => logger.error('Streak Cron failed:', e));
    }, 60 * 60 * 1000);
*/
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
