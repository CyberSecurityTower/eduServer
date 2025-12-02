// controllers/lessonController.js
'use strict';

const supabase = require('../services/data/supabase');
const { explainLessonContent } = require('../services/engines/ghostTeacher');
const logger = require('../utils/logger');

/**
 * دالة ذكية تجلب محتوى الدرس.
 * - إذا كان المحتوى موجوداً (has_content = true): ترجعه فوراً.
 * - إذا كان فارغاً: تستدعي المعلم الشبح لتوليده.
 */
async function getLessonDetails(req, res) {
  const { lessonId, userId } = req.body; // أو req.params حسب تصميمك

  if (!lessonId || !userId) {
    return res.status(400).json({ error: 'lessonId and userId are required' });
  }

  try {
    // 1. جلب بيانات الدرس الأساسية
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('*, subjects(title)') // نجلب اسم المادة أيضاً
      .eq('id', lessonId)
      .single();

    if (error || !lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    // 2. السيناريو الأول: الدرس له محتوى رسمي
    // ملاحظة: افترضنا أن المحتوى مخزن في جدول منفصل lessons_content كما في الكود القديم
    // أو في نفس الجدول. سأفترض هنا أنه في جدول منفصل للترتيب.
    if (lesson.has_content) {
      const { data: contentData } = await supabase
        .from('lessons_content')
        .select('content')
        .eq('id', lessonId) // عادة الـ ID متطابق
        .single();

      if (contentData && contentData.content) {
        return res.json({
          source: 'official',
          title: lesson.title,
          subject: lesson.subjects?.title,
          content: contentData.content,
          isGhost: false
        });
      }
      // إذا كان has_content=true لكن لم نجد النص، ننتقل للخطة ب (الشبح)
      logger.warn(`Lesson ${lessonId} marked has_content but empty. Calling Ghost.`);
    }

    // 3. السيناريو الثاني: المعلم الشبح (Ghost Teacher)
    const ghostResult = await explainLessonContent(lessonId, userId);

    if (ghostResult.isError) {
      return res.status(500).json({ error: ghostResult.content });
    }

    return res.json({
      source: ghostResult.isGenerated ? 'ghost_generated' : 'ghost_cached',
      title: lesson.title,
      subject: lesson.subjects?.title,
      content: ghostResult.content,
      isGhost: true // علامة للفرونت أند ليظهر أيقونة الشبح 👻
    });

  } catch (err) {
    logger.error('getLessonDetails Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = { getLessonDetails };
