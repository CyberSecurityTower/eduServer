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

/**
 * 🕵️‍♂️ الماسح الضوئي للدروس الفارغة
 * يمكن استدعاؤه من Admin Controller أو Cron Job
 */
async function scanAndFillEmptyLessons() {
    logger.info('👻 Ghost Teacher Scanner Started...');
    
    // 1. البحث عن الدروس التي ليس لها محتوى (أو has_content = false)
    // نحدد عدداً صغيراً (مثلاً 5) في كل مرة لتجنب الضغط على الـ API
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
        logger.info('👻 No empty lessons found. Good job!');
        return;
    }

    logger.info(`👻 Found ${emptyLessons.length} empty lessons. Generating content...`);

    for (const lesson of emptyLessons) {
        await generateAndSaveLessonContent(lesson);
    }
}

/**
 * التوليد والحفظ بتنسيق Markdown مخصص
 */
async function generateAndSaveLessonContent(lesson) {
    try {
        const subjectTitle = lesson.subjects?.title || 'General';
        
        // 🔥 البرومبت المصمم خصيصاً للستايل الخاص بك
        const prompt = `
        You are an expert Professor creating content for an app.
        Target: Algerian University Student.
        Subject: ${subjectTitle}
        Lesson: "${lesson.title}"

        **Task:** Write a comprehensive lesson explanation.
        
        **STRICT FORMATTING RULES (Markdown for React Native):**
        1. Use **# Title** for the main title (Matches 'heading1').
        2. Use **## Subtitle** for sections (Matches 'heading2').
        3. Use **bold** for key terms (Matches 'strong').
        4. Use \`code\` for technical terms or formulas (Matches 'code_inline').
        5. Use lists (- item) for bullet points.
        6. **Language:** Mix of Academic Arabic and clear Algerian Derja for examples.
        
        **Content Structure:**
        # ${lesson.title}
        (Intro paragraph...)
        
        ## 1. الفكرة الأساسية (The Core Concept)
        (Explanation...)
        
        ## 2. مثال تطبيقي (Real Example)
        (Use a local Algerian example...)
        
        ## 3. خلاصة (Summary)
        - Point 1
        - Point 2
        
        Output ONLY the Markdown content.
        `;

        if (content && content.length > 100) {
            // 1. حفظ المحتوى
            const { error: contentError } = await supabase.from('lessons_content').upsert({
                lesson_id: lesson.id, // تأكد أن هذا العمود هو Primary Key أو Unique في Supabase
                content: content,
                updated_at: new Date().toISOString()
            }, { onConflict: 'lesson_id' }); // 👈 مهم جداً: تحديد عمود التعارض

            if (contentError) {
                logger.error(`❌ DB Save Failed for ${lesson.title}:`, contentError.message);
            } else {
                logger.success(`✅ Content saved to DB for: ${lesson.title}`);
            }

            // 2. تحديث الحالة
            const { error: updateError } = await supabase.from('lessons').update({
                has_content: true,
                ai_memory: { 
                    generated_by: 'ghost_teacher_v2', 
                    generated_at: new Date().toISOString(),
                    is_ai_generated: true 
                }
            }).eq('id', lesson.id);
            
            if (updateError) logger.error(`❌ Lesson Status Update Failed:`, updateError.message);
        }


module.exports = { initGhostEngine, explainLessonContent, generateAndSaveLessonContent, scanAndFillEmptyLessons };
