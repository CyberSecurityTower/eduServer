// services/engines/ghostTeacher.js
'use strict';

const supabase = require('../data/supabase');
const { extractTextFromResult } = require('../../utils');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

// حقن التبعية (Dependency Injection) لتجنب التكرار
function initGhostEngine(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * المعلم الشبح: يقوم بتوليد محتوى للدروس الفارغة
 * @param {string} lessonId - معرف الدرس
 * @param {string} userId - معرف الطالب (لتخصيص الشرح مستقبلاً)
 */
async function explainLessonContent(lessonId, userId) {
  try {
    // 1. جلب بيانات الدرس للتحقق مما إذا كان مشروحاً مسبقاً
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('title, subjects(title), ai_memory')
      .eq('id', lessonId)
      .single();

    if (error || !lesson) throw new Error('Lesson not found');

    // 2. فحص الكاش (هل شرحناه من قبل؟)
    // ai_memory هو حقل JSONB في الداتابيز نخزن فيه الشرح
    if (lesson.ai_memory && lesson.ai_memory.ghost_explanation) {
      logger.info(`👻 Ghost Teacher: Served from cache for lesson ${lessonId}`);
      return {
        content: lesson.ai_memory.ghost_explanation,
        isGenerated: false
      };
    }

    // 3. التوليد (إذا لم يكن موجوداً)
    logger.info(`👻 Ghost Teacher: Generating new content for "${lesson.title}"...`);

    const prompt = `
    You are the "Ghost Teacher" (المعلم الشبح) for an Algerian student.
    
    **Context:**
    - Subject: ${lesson.subjects?.title || 'General'}
    - Lesson Title: ${lesson.title}
    - The official content is missing, so you must save the day.

    **Task:**
    Write a structured, engaging lesson explanation in **Algerian Derja mixed with Academic Arabic**.
    
    **Structure:**
    1. **Introduction (المقدمة):** Hook the student immediately.
    2. **Core Concept (الزبدة):** Explain the main idea simply.
    3. **Example (مثال حي):** A real-world example from Algeria if possible.
    4. **Summary (الخلاصة):** Bullet points.

    **Tone:** Smart, funny, like a genius older brother. Use emojis.
    **Output:** ONLY the explanation text.
    `;

    if (!generateWithFailoverRef) throw new Error('AI Service not initialized');

    const modelResp = await generateWithFailoverRef('chat', prompt, { label: 'GhostTeacher', timeoutMs: 40000 });
    const explanation = await extractTextFromResult(modelResp);

    // 4. الحفظ في الذاكرة (Hive Mind Update)
    // نحفظ الشرح لكي لا ندفع تكلفة التوليد مرة أخرى لنفس الدرس
    await supabase
      .from('lessons')
      .update({
        ai_memory: { 
          ...lesson.ai_memory, // نحافظ على البيانات القديمة إن وجدت
          ghost_explanation: explanation,
          generated_at: new Date().toISOString()
        }
      })
      .eq('id', lessonId);

    return {
      content: explanation,
      isGenerated: true
    };

  } catch (err) {
    logger.error('Ghost Teacher Error:', err.message);
    return { content: "عذراً، المعلم الشبح في استراحة قهوة حالياً ☕. حاول لاحقاً.", isError: true };
  }
}

module.exports = { initGhostEngine, explainLessonContent };
