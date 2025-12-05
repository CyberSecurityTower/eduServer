// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * ⏱️ دالة تتبع الوقت التراكمي (للشات أو القراءة)
 * تضيف وقتاً للرصيد الحالي ولا تمس حالة الإكمال
 */
async function trackStudyTime(userId, lessonId, secondsToAdd) {
  if (!userId || !lessonId || !secondsToAdd) return;

  try {
    // 1. جلب السجل الحالي لمعرفة الوقت السابق
    const { data: current } = await supabase
      .from('user_progress')
      .select('time_spent_seconds, status')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .maybeSingle();

    const oldTime = current?.time_spent_seconds || 0;
    const newTime = oldTime + secondsToAdd;
    
    // إذا لم يكن هناك سجل، الحالة هي "قيد الدراسة"
    const status = current?.status || 'in_progress';

    // 2. تحديث الوقت + تاريخ آخر تفاعل
    const { error } = await supabase
      .from('user_progress')
      .upsert({
        user_id: userId,
        lesson_id: lessonId,
        time_spent_seconds: newTime,
        status: status, 
        last_interaction: new Date().toISOString()
      }, { onConflict: 'user_id, lesson_id' });

    if (error) throw error;

    // logger.info(`⏱️ Added ${secondsToAdd}s to lesson ${lessonId}`);

  } catch (err) {
    logger.error('trackStudyTime Error:', err.message);
  }
}

/**
 * إشارة إكمال الدرس (عند النجاح في الكويز أو الضغط على زر إنهاء)
 */
async function markLessonComplete(userId, lessonIdentifier, score = 100, addedTime = 0) {
  try {
    let finalLessonId = lessonIdentifier;

    // التحقق هل هو ID أم عنوان
    const isTitle = /[\u0600-\u06FF\s]/.test(lessonIdentifier) || lessonIdentifier.length > 50;

    if (isTitle) {
        const { data: lesson } = await supabase
            .from('lessons')
            .select('id')
            .ilike('title', `%${lessonIdentifier}%`)
            .limit(1)
            .maybeSingle();

        if (lesson) finalLessonId = lesson.id;
        else return { success: false, reason: 'lesson_not_found' };
    }

    // جلب الوقت القديم لإضافته (لا نريد تصفير العداد عند الإكمال)
    const { data: current } = await supabase
        .from('user_progress')
        .select('time_spent_seconds')
        .eq('user_id', userId)
        .eq('lesson_id', finalLessonId)
        .maybeSingle();

    const totalTime = (current?.time_spent_seconds || 0) + addedTime;

    logger.info(`🔐 Gatekeeper: Marking lesson ${finalLessonId} COMPLETE (Total Time: ${totalTime}s)`);

    // تحديث الحالة إلى completed
    await supabase
      .from('user_progress')
      .upsert({
        user_id: userId,
        lesson_id: finalLessonId,
        status: 'completed',
        mastery_score: score,
        time_spent_seconds: totalTime,
        last_interaction: new Date().toISOString()
      }, { onConflict: 'user_id, lesson_id' });

    // زيادة نقاط الخبرة
    try { await supabase.rpc('increment_user_xp', { x: 50, uid: userId }); } catch (e) {}

    return { success: true, message: "Lesson unlocked!" };

  } catch (err) {
    logger.error('Gatekeeper Error:', err.message);
    return { success: false };
  }
}

module.exports = { markLessonComplete, trackStudyTime };
