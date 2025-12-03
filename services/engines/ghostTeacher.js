// services/engines/ghostTeacher.js
'use strict';

const supabase = require('../data/supabase');
const { extractTextFromResult } = require('../../utils');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

// Dependency Injection
function initGhostEngine(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * المعلم الشبح: يقوم بتوليد محتوى للدروس الفارغة
 */
async function explainLessonContent(lessonId, userId) {
  try {
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('title, subjects(title), ai_memory')
      .eq('id', lessonId)
      .single();

    if (error || !lesson) throw new Error('Lesson not found');

    // CACHE CHECK
    if (lesson.ai_memory && lesson.ai_memory.ghost_explanation) {
      logger.info(`👻 Ghost Teacher: Served from cache for lesson ${lessonId}`);
      return {
        content: lesson.ai_memory.ghost_explanation,
        isGenerated: false
      };
    }

    // GENERATE NEW EXPLANATION
    logger.info(`👻 Ghost Teacher: Generating new content for "${lesson.title}"...`);

    const prompt = `
    You are the "Ghost Teacher" for an Algerian student.

    Subject: ${lesson.subjects?.title || 'General'}
    Lesson Title: ${lesson.title}

    Write a structured, engaging lesson explanation in Algerian Derja mixed with Academic Arabic.

    Structure:
    1. مقدمة
    2. الزبدة
    3. مثال حي جزائري
    4. خلاصة

    Tone: Smart, funny older brother. Use emojis.
    Output: ONLY the explanation text.
    `;

    if (!generateWithFailoverRef) throw new Error('AI Service not initialized');

    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GhostTeacher', timeoutMs: 40000 });
    const explanation = await extractTextFromResult(modelResp);

    // SAVE IN MEMORY
    await supabase
      .from('lessons')
      .update({
        ai_memory: {
          ...lesson.ai_memory,
          ghost_explanation: explanation,
          generated_at: new Date().toISOString(),
        }
      })
      .eq('id', lessonId);

    return {
      content: explanation,
      isGenerated: true
    };

  } catch (err) {
    logger.error('Ghost Teacher Error:', err.message);
    return { content: "عذراً، المعلم الشبح راهو شارب قهوة ☕. حاول لاحقاً.", isError: true };
  }
}


/**
 * 🕵️‍♂️ Scanner for empty lessons
 */
async function scanAndFillEmptyLessons() {
  logger.info('👻 Ghost Teacher Scanner Started...');

  const { data: emptyLessons, error } = await supabase
    .from('lessons')
    .select('id, title, subjects(title)')
    .eq('has_content', false)
    .limit(5);

  if (error) {
    logger.error('Scanner Error:', error.message);
    return;
  }

  if (!emptyLessons || emptyLessons.length === 0) {
    logger.info('👻 No empty lessons found.');
    return;
  }

  logger.info(`👻 Found ${emptyLessons.length} empty lessons. Generating content...`);

  for (const lesson of emptyLessons) {
    await generateAndSaveLessonContent(lesson);
  }
}


/**
 * Generate lesson Markdown and save it in DB
 */
async function generateAndSaveLessonContent(lesson) {
  try {
    const subjectTitle = lesson.subjects?.title || 'General';

    const prompt = `
    You are an expert Professor writing educational content.
    Target: Algerian University Students.

    Subject: ${subjectTitle}
    Lesson: "${lesson.title}"

    Write a full explanation in Markdown:
    
    # ${lesson.title}

    ## 1. الفكرة الأساسية
    Explain the concept clearly.

    ## 2. مثال تطبيقي جزائري
    Provide an Algerian example.

    ## 3. خلاصة
    - Point 1
    - Point 2

    Use **bold**, ## headings, and simple Derja where helpful.
    Output ONLY Markdown.
    `;

    if (!generateWithFailoverRef) throw new Error('AI generator not initialized');

    // Generate content
    const aiResp = await generateWithFailoverRef('chat', prompt, { label: 'GhostTeacherV2', timeoutMs: 40000 });
    const content = await extractTextFromResult(aiResp);

    if (!content || content.length < 50) {
      logger.error(`❌ AI Returned Empty Content for: ${lesson.title}`);
      return;
    }

    // Save Markdown
    const { error: contentError } = await supabase
      .from('lessons_content')
      .upsert(
        {
          lesson_id: lesson.id,
          content: content,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'lesson_id' }
      );

    if (contentError) {
      logger.error(`❌ DB Save Failed for ${lesson.title}:`, contentError.message);
    } else {
      logger.info(`✅ Content saved for: ${lesson.title}`);
    }

    // Update lesson status
    await supabase
      .from('lessons')
      .update({
        has_content: true,
        ai_memory: {
          generated_by: 'ghost_teacher_v2',
          generated_at: new Date().toISOString(),
          is_ai_generated: true
        }
      })
      .eq('id', lesson.id);

  } catch (err) {
    logger.error(`❌ Error generating lesson content: ${err.message}`);
  }
}


module.exports = {
  initGhostEngine,
  explainLessonContent,
  generateAndSaveLessonContent,
  scanAndFillEmptyLessons
};
