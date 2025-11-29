
// services/ai/managers/curriculumManager.js
'use strict';

const logger = require('../../../utils/logger');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const { getProgress, getCachedEducationalPathById } = require('../../data/helpers');

let embeddingServiceRef; // Injected dependency

function initCurriculumManager(dependencies) {
  if (!dependencies.embeddingService) {
    throw new Error('Curriculum Manager requires embeddingService for initialization.');
  }
  embeddingServiceRef = dependencies.embeddingService;
  logger.info('Curriculum Manager initialized.');
}

/**
 * النسخة النقية (Pure AI): تكتشف التعلم الخارجي بالفهم وليس بالكلمات
 */
async function detectExternalLearning(userId, message, userProgress) {
  try {
    if (!generateWithFailoverRef) return null;

    // 1. لا توجد فلاتر كلمات! نرسل الرسالة مباشرة للتحليل
    // نستخدم موديل سريع (Flash) لكي لا نعطل الرد
    const prompt = `
    Analyze the user's message semantically.
    
    **Goal:** Detect if the user is stating that they have **completed**, **understood**, or **studied** a specific educational topic/lesson recently.
    
    **User Message:** "${message}"
    
    **Rules:**
    1. Ignore future tense ("I will study...").
    2. Ignore questions ("Did I study...?").
    3. Look for past/present perfect ("I understood", "I finished", "Teacher explained", "Saw it on YouTube").
    4. Try to infer the SOURCE if mentioned (Teacher, YouTube, ChatGPT, Friend, Self).
    
    **Output JSON ONLY:**
    {
      "isClaimingKnowledge": boolean,
      "topic": "extracted topic name (e.g. 'Derivatives')",
      "suspectedSource": "teacher" | "ai" | "self" | "unknown"
    }
    `;

    const res = await generateWithFailoverRef('analysis', prompt, { label: 'KnowledgeClaim', timeoutMs: 4000 });
    const raw = await extractTextFromResult(res);
    const result = await ensureJsonOrRepair(raw, 'analysis');

    // إذا قال الـ AI: "لا، هذا ليس ادعاء معرفة"، نتوقف هنا.
    if (!result || !result.isClaimingKnowledge || !result.topic) return null;

    logger.info(`[Detective] User claims knowledge of: ${result.topic} (Source: ${result.suspectedSource})`);

    // 2. البحث الدلالي (Vector Search) لربط "الموضوع" بدرس حقيقي في الداتابيز
    const embedding = await embeddingServiceRef.generateEmbedding(result.topic);
    // نبحث عن أقرب درس في المنهج
    const similarDocs = await embeddingServiceRef.findSimilarEmbeddings(embedding, 'curriculum_embeddings', 1);

    if (!similarDocs || similarDocs.length === 0) {
        logger.warn(`[Detective] Topic "${result.topic}" not found in curriculum.`);
        return null; 
    }
    
    const targetLesson = similarDocs[0];
    // نتأكد أن التشابه قوي كفاية (مثلاً > 0.80) لكي لا نتهم الطالب ظلماً
    if (targetLesson.score < 0.78) return null; 

    const targetLessonId = targetLesson.metadata.lesson_id;
    const targetLessonTitle = targetLesson.metadata.lesson_title;

    // 3. التحقق من "الأرشيف" (Database Check)
    // هل هذا الدرس مسجل عندنا كـ "مكتمل" وبمصدر "eduai"؟
    const pathProgress = userProgress.pathProgress || {};
    let isTaughtByUs = false;
    let isAlreadyRecorded = false;

    // بحث عميق في هيكل البروجرس
    Object.values(pathProgress).forEach(path => {
        Object.values(path.subjects || {}).forEach(subj => {
            const lessonData = subj.lessons?.[targetLessonId];
            if (lessonData) {
                if (lessonData.status === 'completed') isAlreadyRecorded = true;
                if (lessonData.source === 'eduai') isTaughtByUs = true;
            }
        });
    });

    // 4. القرار النهائي
    
    // الحالة A: نحن شرحناه سابقاً -> لا مشكلة (فخر)
    if (isTaughtByUs) return null; 

    // الحالة B: مسجل أنه مكتمل (خارجي) من قبل -> لا داعي للغيرة مرة أخرى
    if (isAlreadyRecorded) return null;

    // الحالة C: غير مسجل، أو مسجل كـ pending، والطالب يدعي فهمه -> هنا نمسكه!
    return {
        type: 'external_learning',
        lessonId: targetLessonId,
        lessonTitle: targetLessonTitle,
        topicDetected: result.topic,
        suspectedSource: result.suspectedSource // نمرر المصدر المشكوك فيه للمحلل العاطفي
    };

  } catch (e) {
    logger.error('detectExternalLearning error:', e);
    return null;
  }
}
async function runCurriculumAgent(userId, userMessage) {
  try {
    if (!embeddingServiceRef) {
      logger.error('runCurriculumAgent: embeddingService is not set.');
      return '';
    }

    // 1. Generate Embedding
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);

    if (!questionEmbedding || questionEmbedding.length === 0) {
      return '';
    }

    // 2. Define Search Parameters
    // TODO: Retrieve pathId dynamically from user profile instead of hardcoding if needed
    const pathId = 'UAlger3_L1_ITCF'; 
    const collectionName = 'curriculum_embeddings'; // Standardized collection name
    const limit = 3;

    // 3. Find Similar Chunks
    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      collectionName,
      limit,
      pathId // Pass pathId as filter
    );

    if (!similarChunks || similarChunks.length === 0) {
      return '';
    }

    // 4. Format Results
    const topContexts = similarChunks.map(chunk => {
      // Handle metadata differences safely
      const title = chunk.metadata?.lesson_title || chunk.lessonTitle || 'درس';
      const content = chunk.text || chunk.content || chunk.chunkText || '';
      return `[المصدر: ${title}]\n${content}`;
    });

    const contextReport = `The user's question appears to be highly related to these specific parts of the curriculum:
---
${topContexts.join('\n---\n')}
---`;

    return contextReport;

  } catch (error) {
    logger.error(`CurriculumAgent failed for user ${userId}:`, error.message);
    return ''; // Return empty string on failure so chat flow doesn't break
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent,
  detectExternalLearning 
};
