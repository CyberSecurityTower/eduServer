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
 * Generate lesson Markdown and save it in DB
 */
async function generateAndSaveLessonContent(lesson) {
  try {
    const subjectTitle = lesson.subjects?.title || 'General';

    const prompt = `
    You are a distinguished University Professor.
    Subject: ${subjectTitle}
    Lesson Title: "${lesson.title}"

    **Task:** Write a comprehensive academic lesson in **Formal Arabic**.

    **Markdown structure:**

    # ${lesson.title}
    (Introduction...)

    ## 1. المفاهيم الأساسية
    (Detailed explanation...)

    ## 2. الشرح التفصيلي
    (Extended explanation...)

    ## 3. خلاصة الدرس
    - Key point 1
    - Key point 2

    Output ONLY the Markdown text.
    `;

    if (!generateWithFailoverRef)
      throw new Error('AI generator not initialized');

    // Generate content
    const aiResp = await generateWithFailoverRef(
      'chat', 
      prompt, 
      { label: 'GhostGenerator', timeoutMs: 90000 }
    );

    const content = await extractTextFromResult(aiResp);

    if (!content || content.length < 50) {
      logger.error(`❌ AI Returned Empty Content for: ${lesson.title}`);
      return;
    }

    // Save Markdown into lessons_content
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
      logger.error(`❌ DB Save Failed for ${lesson.title}: ${contentError.message}`);
      return;
    }

    logger.success(`✅ Content saved for: ${lesson.title}`);

    // Update lesson flags
    const { error: updateError } = await supabase
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

    if (updateError)
      logger.error(`❌ Failed to update lesson status for ${lesson.title}: ${updateError.message}`);

  } catch (err) {
    logger.error(`❌ Error generating lesson content: ${err.message}`);
  }
}

/**
 * المعلم الشبح
 */
async function explainLessonContent(lessonId, userId) {
  try {
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('title, subjects(title), ai_memory')
      .eq('id', lessonId)
      .single();

    if (error || !lesson) throw new Error('Lesson not found');

    // Cache check
    if (lesson.ai_memory?.ghost_explanation) {
      logger.info(`👻 Using cached explanation for ${lessonId}`);
      return { content: lesson.ai_memory.ghost_explanation, isGenerated: false };
    }

    // Generate explanation
    const prompt = `
    You are the Ghost Teacher. Explain the lesson in Derja + Academic Arabic.

    Subject: ${lesson.subjects?.title}
    Lesson: ${lesson.title}

    Structure:
    1. مقدمة
    2. الزبدة
    3. مثال جزائري
    4. خلاصة
    `;

    const modelResp = await generateWithFailoverRef('chat', prompt);
    const explanation = await extractTextFromResult(modelResp);

    await supabase
      .from('lessons')
      .update({
        ai_memory: {
          ...lesson.ai_memory,
          ghost_explanation: explanation,
          generated_at: new Date().toISOString()
        }
      })
      .eq('id', lessonId);

    return { content: explanation, isGenerated: true };

  } catch (err) {
    logger.error(`Failed to generate for lesson ${lesson.id}:\n`, err.message);
    return {
      content: 'عذراً، المعلم الشبح راهو شارب قهوة ☕',
      isError: true
    };
  }
}

/**
 * Scanner for empty lessons
 */
async function scanAndFillEmptyLessons() {
  logger.info('👻 Ghost Teacher Scanner Started...');

  const { data: lessons, error } = await supabase
    .from('lessons')
    .select('id, title, subjects(title)')
    .eq('has_content', false)
    .limit(5);

  if (error) return logger.error(error.message);

  for (const lesson of lessons) {
    await generateAndSaveLessonContent(lesson);
  }
}

module.exports = {
  initGhostEngine,
  explainLessonContent,
  generateAndSaveLessonContent,
  scanAndFillEmptyLessons
};
