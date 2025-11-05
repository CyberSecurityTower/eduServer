
'use strict';

// هذا السكربت يُشغّل مرة واحدة لفهرسة محتوى المنهج الدراسي
// Usage: node scripts/indexCurriculum.js

require('dotenv').config(); // لقراءة المتغيرات من ملف .env
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- الإعدادات ---
const COLLECTION_TO_READ = 'educationalPaths';
const COLLECTION_TO_WRITE = 'curriculumEmbeddings';
const EMBEDDING_MODEL = 'text-embedding-004';
const CHUNK_SIZE = 500; // حجم القطعة النصية (بالأحرف) التي سنحولها لمتجه

// --- تهيئة Firebase Admin ---
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
  process.exit(1);
}
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
  console.error('Firebase Admin initialization failed.', e.message);
  process.exit(1);
}
const db = admin.firestore();

// --- تهيئة Google AI ---
const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY_1;
if (!apiKey) {
  console.error('No Google API Key found. Exiting.');
  process.exit(1);
}
const googleAiClient = new GoogleGenerativeAI(apiKey);
const model = googleAiClient.getGenerativeModel({ model: EMBEDDING_MODEL });

/**
 * دالة لإنشاء متجه من نص
 */
async function generateEmbedding(text) {
  try {
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    console.error(`Failed to create embedding for: "${text.substring(0, 50)}..."`, err.message);
    return null;
  }
}

/**
 * دالة لتقسيم النص إلى قطع صغيرة
 */
function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.substring(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/**
 * الدالة الرئيسية لتشغيل الفهرسة
 */
async function startIndexing() {
  console.log('🚀 Starting curriculum indexing process...');

  const pathsSnapshot = await db.collection(COLLECTION_TO_READ).get();
  if (pathsSnapshot.empty) {
    console.warn('No educational paths found to index.');
    return;
  }

  let totalChunks = 0;
  for (const pathDoc of pathsSnapshot.docs) {
    const pathData = pathDoc.data();
    console.log(`\nProcessing Path: ${pathData.displayName || pathDoc.id}`);

    for (const subject of pathData.subjects || []) {
      for (const lesson of subject.lessons || []) {
        const lessonContent = lesson.content || ''; // افترض أن محتوى الدرس هنا
        if (!lessonContent) continue;

        const textChunks = chunkText(lessonContent);

        for (const chunk of textChunks) {
          const embedding = await generateEmbedding(chunk);
          if (embedding) {
            await db.collection(COLLECTION_TO_WRITE).add({
              pathId: pathDoc.id,
              subjectId: subject.id,
              lessonId: lesson.id,
              chunkText: chunk,
              embedding: embedding,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            totalChunks++;
            process.stdout.write(`\rIndexed Chunks: ${totalChunks}`);
          }
          // تأخير بسيط لتجنب تجاوز حدود الـ API
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }
  }

  console.log(`\n\n✅ Indexing complete! Total chunks indexed: ${totalChunks}`);
}

startIndexing().catch(console.error);
