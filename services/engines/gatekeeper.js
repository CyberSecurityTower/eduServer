// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * ينفذ إشارة إكمال الدرس
 * يمتلك ذكاءً لتصحيح الـ ID إذا أرسل الـ AI العنوان بالخطأ
 */
async function markLessonComplete(userId, lessonIdentifier, score = 100) {
  try {
    let finalLessonId = lessonIdentifier;

    // 🕵️‍♂️ التحقق الذكي: هل ما وصلنا هو ID أم عنوان؟
    // إذا كان النص يحتوي على مسافات أو حروف عربية، فهو غالباً عنوان وليس ID
    const isTitle = /[\u0600-\u06FF\s]/.test(lessonIdentifier) || lessonIdentifier.length > 50;

    if (isTitle) {
        logger.warn(`🔐 Gatekeeper: AI sent a title ("${lessonIdentifier}") instead of ID. Searching for ID...`);
        
        // البحث عن الـ ID الحقيقي باستخدام العنوان
        const { data: lesson } = await supabase
            .from('lessons')
            .select('id')
            .ilike('title', `%${lessonIdentifier}%`) // بحث مرن
            .limit(1)
            .maybeSingle();

        if (lesson) {
            finalLessonId = lesson.id;
            logger.success(`🔐 Gatekeeper: Resolved title to ID: ${finalLessonId}`);
        } else {
            logger.error(`🔐 Gatekeeper: Could not find lesson with title: "${lessonIdentifier}"`);
            return { success: false, reason: 'lesson_not_found' };
        }
    }

    logger.info(`🔐 Gatekeeper: Marking lesson ${finalLessonId} as complete for ${userId}`);

    // 1. تحديث حالة الدرس
    const { error } = await supabase
      .from('user_progress')
      .upsert({
        user_id: userId,
        lesson_id: finalLessonId,
        status: 'completed',
        mastery_score: score,
        last_interaction: new Date().toISOString()
      }, { onConflict: 'user_id, lesson_id' }); // الآن سيعمل لأننا أضفنا القيد في SQL

    if (error) throw error;

    // 2. زيادة نقاط الخبرة (XP)
    // نستخدم try-catch هنا لكي لا نوقف العملية إذا فشلت زيادة النقاط
    try {
        await supabase.rpc('increment_user_xp', { x: 50, uid: userId });
    } catch (xpError) {
        logger.warn('XP Increment failed (minor):', xpError.message);
    }

    return { success: true, message: "Lesson unlocked!" };

  } catch (err) {
    logger.error('Gatekeeper Error:', err.message);
    return { success: false };
  }
}

module.exports = { markLessonComplete };
