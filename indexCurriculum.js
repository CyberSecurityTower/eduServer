
// indexCurriculum.js (Updated)
'use strict';
/**
 * =====================================================================================
 * EduAI Advanced Curriculum Indexer v2.0
 * =====================================================================================
 *
 * This script reads educational content, splits it into meaningful chunks,
 * generates vector embeddings using Google's AI, and saves them to Firestore
 * for semantic search.
 *
 * --- FEATURES ---
 * - Command-Line Interface: Control behavior with flags.
 * - Batch Processing: Writes to Firestore in batches for high efficiency.
 * - Smart Chunking: Splits text by paragraphs and sentences to preserve context.
 * - Resilient API Calls: Automatically retries failed API requests with exponential backoff.
 * - Visual Progress Bar: Real-time feedback on the indexing process.
 * - Targeted Indexing: Process all paths or specify a single one.
 * - Cleanup Mode: Option to wipe the existing index before starting.
 * - Dry Run Mode: Simulate the process without making actual changes.
 *
 * --- USAGE ---
 *
 * # Index all educational paths:
 * node indexCurriculum.js
 *
 * # Clean the old index and re-index everything:
 * node indexCurriculum.js --clean
 *
 * # Index only a specific educational path:
 * node indexCurriculum.js --pathId "UAlger3_L1_ITCF"
 *
 * # Simulate the process for a specific path without writing data:
 * node indexCurriculum.js --pathId "UAlger3_L1_ITCF" --dry-run
 *
 * =====================================================================================
 */

// Core Modules
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cliProgress = require('cli-progress');

// Import from new structure
const CONFIG = require('./config'); // Use the centralized config
const { initializeFirestore, admin } = require('./services/data/firestore'); // Use centralized Firestore init
const logger = require('./utils/logger'); // Use centralized logger
const { sleep } = require('./utils'); // Use centralized sleep utility

// --- CONFIGURATION (Overrides or additions specific to this script) ---
const CURRICULUM_CONFIG = {
  collections: {
    sourcePaths: 'educationalPaths',
    sourceContent: 'lessonsContent',
    destination: 'curriculumEmbeddings',
  },
  model: {
    embedding: CONFIG.MODEL.embedding, // Use embedding model from main config
  },
  chunking: {
    maxChunkSize: 1000,
  },
  firestore: {
    batchSize: 100,
  },
  api: {
    maxRetries: 5,
    initialDelayMs: 1000,
  },
};

function parseArgs() {
  const args = process.argv.slice(2).reduce((acc, arg) => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=');
      acc[key.substring(2)] = value === undefined ? true : value;
    }
    return acc;
  }, {});
  return args;
}

function validateEnv() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_API_KEY) {
    logger.error('Missing required environment variables: FIREBASE_SERVICE_ACCOUNT_KEY, GOOGLE_API_KEY');
    process.exit(1);
  }
}

// --- INITIALIZATION ---
let db, googleAiClient;
try {
  validateEnv();
  db = initializeFirestore(); // Initialize Firestore
  googleAiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
} catch (e) {
  logger.error(`Initialization failed: ${e.message}`);
  process.exit(1);
}

// --- CORE FUNCTIONS ---

async function generateEmbeddingWithRetry(text, model) {
  for (let i = 0; i < CURRICULUM_CONFIG.api.maxRetries; i++) {
    try {
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      logger.warn(`Embedding failed (attempt ${i + 1}/${CURRICULUM_CONFIG.api.maxRetries}). Retrying in ${CURRICULUM_CONFIG.api.initialDelayMs * 2 ** i}ms...`);
      await sleep(CURRICULUM_CONFIG.api.initialDelayMs * 2 ** i);
    }
  }
  throw new Error(`Failed to generate embedding for text after ${CURRICULUM_CONFIG.api.maxRetries} attempts.`);
}

function intelligentChunker(text) {
  if (!text) return [];
  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  for (const p of paragraphs) {
    if (p.length <= CURRICULUM_CONFIG.chunking.maxChunkSize) {
      chunks.push(p);
    } else {
      const sentences = p.match(/[^.!?]+[.!?]*/g) || [p];
      let currentChunk = '';
      for (const s of sentences) {
        if ((currentChunk + s).length > CURRICULUM_CONFIG.chunking.maxChunkSize) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        currentChunk += s + ' ';
      }
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
    }
  }
  return chunks;
}

async function cleanCollection(collectionName) {
  logger.info(`Cleaning collection: ${collectionName}...`);
  const snapshot = await db.collection(collectionName).limit(500).get();
  if (snapshot.empty) {
    logger.info('Collection is already empty.');
    return;
  }
  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  await cleanCollection(collectionName);
}

// --- MAIN EXECUTION ---

async function main() {
  const startTime = Date.now();
  const args = parseArgs();
  logger.log('=====================================================');
  logger.info('EduAI Advanced Curriculum Indexer Initializing...');
  logger.log('=====================================================');

  if (args['dry-run']) {
    logger.warn('--- DRY RUN MODE ENABLED: No data will be written. ---');
  }

  if (args.clean) {
    if (!args['dry-run']) {
      await cleanCollection(CURRICULUM_CONFIG.collections.destination);
    } else {
      logger.info(`[Dry Run] Would have cleaned collection: ${CURRICULUM_CONFIG.collections.destination}`);
    }
  }

  const embeddingModel = googleAiClient.getGenerativeModel({ model: CURRICULUM_CONFIG.model.embedding });
  let pathQuery = db.collection(CURRICULUM_CONFIG.collections.sourcePaths);
  if (args.pathId) {
    logger.info(`Targeting specific path ID: ${args.pathId}`);
    pathQuery = pathQuery.where(admin.firestore.FieldPath.documentId(), '==', args.pathId);
  }

  const pathsSnapshot = await pathQuery.get();
  if (pathsSnapshot.empty) {
    logger.warn('No educational paths found to index.');
    return;
  }

  logger.info(`Found ${pathsSnapshot.size} educational path(s) to process.`);
  const tasks = [];

  for (const pathDoc of pathsSnapshot.docs) {
    const pathData = pathDoc.data();
    for (const subject of pathData.subjects || []) {
      for (const lesson of subject.lessons || []) {
        if (lesson.id) {
          tasks.push({
            pathId: pathDoc.id,
            subjectId: subject.id,
            lessonId: lesson.id,
            lessonTitle: lesson.title || 'Untitled',
          });
        }
      }
    }
  }

  if (tasks.length === 0) {
    logger.warn('No lessons with valid IDs found in the specified paths.');
    return;
  }

  logger.info(`Found a total of ${tasks.length} lessons to index.`);
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(tasks.length, 0);

  let totalChunks = 0;
  let batch = db.batch();
  let batchCounter = 0;

  for (const task of tasks) {
    const contentDoc = await db.collection(CURRICULUM_CONFIG.collections.sourceContent).doc(task.lessonId).get();
    if (contentDoc.exists) {
      const content = contentDoc.data().content || '';
      const textChunks = intelligentChunker(content);

      for (const chunk of textChunks) {
        if (args['dry-run']) {
          totalChunks++;
          continue;
        }

        const embedding = await generateEmbeddingWithRetry(chunk, embeddingModel);
        const docRef = db.collection(CURRICULUM_CONFIG.collections.destination).doc();
        batch.set(docRef, {
          ...task,
          chunkText: chunk,
          embedding: embedding,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        batchCounter++;
        totalChunks++;

        if (batchCounter >= CURRICULUM_CONFIG.firestore.batchSize) {
          await batch.commit();
          batch = db.batch();
          batchCounter = 0;
        }
      }
    }
    progressBar.increment();
  }

  if (batchCounter > 0 && !args['dry-run']) {
    await batch.commit();
  }

  progressBar.stop();
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  logger.log('=====================================================');
  logger.success('Indexing Complete!');
  logger.log('=====================================================');
  logger.log(`- Total Paths Processed: ${pathsSnapshot.size}`);
  logger.log(`- Total Lessons Scanned: ${tasks.length}`);
  logger.log(`- Total Chunks Indexed: ${totalChunks}`);
  logger.log(`- Duration: ${duration} seconds`);
  if (args['dry-run']) {
    logger.warn('--- Reminder: This was a DRY RUN. No data was written. ---');
  }
}

main().catch(err => {
  logger.error(`A critical error occurred: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
