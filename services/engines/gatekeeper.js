// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * ينفذ إشارة إكمال الدرس
 */
async function markLessonComplete(userId, lessonId, score = 100) {
  try {
    logger.info(`🔐 Gatekeeper: Marking lesson ${lessonId} as complete for ${userId}`);

    // 1. تحديث حالة الدرس الحالي
    const { error } = await supabase
      .from('user_progress')
      .upsert({
        user_id: userId,
        lesson_id: lessonId,
        status: 'completed',
        mastery_score: score,
        last_interaction: new Date().toISOString()
      }, { onConflict: 'user_id, lesson_id' });

    if (error) throw error;

    // 2. (اختياري) فتح الدروس التالية المغلقة
    // هذا يتطلب منطقاً معقداً لفحص المتطلبات (Prerequisites)
    // للمرحلة الحالية (MVP)، سنكتفي بتسجيل الإنجاز.
    
    // 3. إضافة نقاط XP للمستخدم (Gamification)
    await supabase.rpc('increment_user_xp', { x: 50, uid: userId }); // تأكد من وجود دالة RPC أو تحديث مباشر

    return { success: true, message: "Lesson unlocked!" };

  } catch (err) {
    logger.error('Gatekeeper Error:', err.message);
    return { success: false };
  }
}

module.exports = { markLessonComplete };
