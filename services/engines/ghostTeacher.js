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
 * 🕵️‍♂️ الماسح الضوئي الذكي (Smart Scanner)
 * يبحث عن الدروس التي ليس لها سجل في جدول المحتوى
 */
async function scanAndFillEmptyLessons() {
  logger.info('👻 Ghost Teacher Scanner Started (Direct Check Mode)...');
  
  // 1. Fetch all lessons
  const { data: allLessons, error: lessonsError } = await supabase
    .from('lessons')
    .select('id, title, subject_id, subjects(title)');

  if (lessonsError || !allLessons) {
    logger.error('❌ Error loading lessons:', lessonsError?.message);
    return;
  }

  // 2. Fetch existing lesson content IDs
  const { data: existingContents, error: contentError } = await supabase
    .from('lessons_content')
    .select('lesson_id');

  if (contentError) {
    logger.error('❌ Error loading lesson contents:', contentError.message);
    return;
  }

  const existingIds = new Set(existingContents?.map(x => x.lesson_id) || []);

  // 3. Filter empty lessons
  const emptyLessons = allLessons.filter(l => !existingIds.has(l.id));

  if (emptyLessons.length === 0) {
    logger.info('👻 All lessons have content. System is clean.');
    return;
  }

  logger.info(`👻 Found ${emptyLessons.length} truly empty lessons. Processing batch of 5...`);

  for (const lesson of emptyLessons.slice(0, 5)) {
    await generateAndSaveLessonContent(lesson);
  }
}


/**
 * Generate lesson Markdown and save it in DB
 */
async function generateAndSaveLessonContent(lesson) {
  try {
      const subjectTitle = lesson.subjects?.title || 'General';
      
      // 🔥 البرومبت المعدل: محتوى خام مباشر (Direct Content)
      const prompt = `
      You are an Academic Content Generator.
      Subject: ${subjectTitle}
      Lesson: "${lesson.title}"

      **Task:** Generate the lesson content in **Formal Arabic (الفصحى)**.
      
      **STRICT RULES:**
      1. **NO INTRODUCTIONS:** Do NOT say "Welcome students", "Today we discuss", or "In this lesson".
      2. **START IMMEDIATELY:** Start directly with the Markdown Title.
      3. **FORMAT:** Use clean Markdown.
      
      **Required Structure:**
      # ${lesson.title}
      
      (Write a direct definition/intro to the concept here...)
      
      ## 1. المحاور الأساسية
      (Details...)
      
      ## 2. شرح معمق
      (Details...)
      
      ## 3. خلاصة
      - Point 1
      - Point 2
      
      Output ONLY the Markdown.
      `;

      if (!generateWithFailoverRef)
        throw new Error('AI generator not initialized');

      // نستخدم 'chat' (الذي يجب أن يكون مربوطاً بـ Pro أو Flash حسب رصيدك)
      const res = await generateWithFailoverRef('chat', prompt, { 
          label: 'GhostGenerator', 
          timeoutMs: 90000 
      });
      
      const content = await extractTextFromResult(res);

     if (content && content.length > 100) {
            logger.info(`💾 Saving content for lesson: ${lesson.id}...`);

            // 1. الحفظ في lessons_content
            const { error: insertError } = await supabase
                .from('lessons_content')
                .upsert({
                    lesson_id: lesson.id, 
                    subject_id: lesson.subject_id, 
                    content: content,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'lesson_id' });
          if (insertError) {
              logger.error(`❌ DB Insert Error:`, insertError.message);
              return;
          }

          // 2. تحديث العلامة في جدول lessons (لأغراض الـ UI فقط)
          await supabase.from('lessons').update({
              has_content: true,
              ai_memory: { 
                generated_by: 'ghost_teacher_v2',
                generated_at: new Date().toISOString(),
                is_ai_generated: true
              }
          }).eq('id', lesson.id);

          logger.success(`✅ Generated & Saved: ${lesson.title}`);
      } else {
          logger.error(`❌ AI Returned Empty or Short Content for: ${lesson.title}`);
      }

  } catch (err) {
      logger.error(`Failed to generate for lesson ${lesson.id}:`, err.message);
  }
}

/**
 * المعلم الشبح (للشرح بالدارجة)
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
    logger.error(`Failed to explain lesson ${lessonId}:\n`, err.message);
    return {
      content: 'عذراً، المعلم الشبح راهو شارب قهوة ☕',
      isError: true
    };
  }
}

module.exports = {
  initGhostEngine,
  explainLessonContent,
  generateAndSaveLessonContent,
  scanAndFillEmptyLessons
};
