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
 * إشارة إكمال الدرس + نظام المكافآت (EduCoin Integration) 🪙
 */
async function markLessonComplete(userId, lessonIdentifier, score = 100, addedTime = 0) {
  try {
    let finalLessonId = lessonIdentifier;
    const isTitle = /[\u0600-\u06FF\s]/.test(lessonIdentifier) || lessonIdentifier.length > 50;

    if (isTitle) {
        const { data: lesson } = await supabase.from('lessons').select('id').ilike('title', `%${lessonIdentifier}%`).limit(1).maybeSingle();
        if (lesson) finalLessonId = lesson.id;
        else return { success: false, reason: 'lesson_not_found' };
    }

    // 1. جلب الحالة السابقة (لمعرفة هل نكافئه أم لا)
    const { data: current } = await supabase
        .from('user_progress')
        .select('status, time_spent_seconds')
        .eq('user_id', userId)
        .eq('lesson_id', finalLessonId)
        .maybeSingle();

    const wasCompletedBefore = current?.status === 'completed';
    const totalTime = (current?.time_spent_seconds || 0) + addedTime;

    // 2. تحديث حالة الدرس
    await supabase.from('user_progress').upsert({
        user_id: userId,
        lesson_id: finalLessonId,
        status: 'completed',
        mastery_score: score,
        time_spent_seconds: totalTime,
        last_interaction: new Date().toISOString()
    }, { onConflict: 'user_id, lesson_id' });

    // 3. 🪙 حساب وتوزيع الكوينز (EduCoin Logic)
    let coinsEarned = 0;
    let rewardReason = '';

    if (!wasCompletedBefore) {
        // مكافأة الإكمال لأول مرة
        coinsEarned += 50; 
        rewardReason = 'lesson_completion';
        
        // بونوس العلامة الكاملة
        if (score >= 90) {
            coinsEarned += 20;
            rewardReason += '_with_honors';
        }
    } else {
        // إعادة الدرس (مكافأة رمزية للتشجيع على المراجعة)
        // نعطيه فقط إذا حصل على علامة ممتازة هذه المرة
        if (score >= 95) {
            coinsEarned += 5;
            rewardReason = 'review_mastery';
        }
    }

    let newTotalCoins = 0;

    // 4. تنفيذ المعاملة المالية إذا كان هناك ربح
    if (coinsEarned > 0) {
        const { data: balance, error } = await supabase.rpc('process_coin_transaction', {
            p_user_id: userId,
            p_amount: coinsEarned,
            p_reason: rewardReason,
            p_meta: { lesson_id: finalLessonId, score: score }
        });
        
        if (!error) newTotalCoins = balance;
        logger.success(`🪙 User ${userId} earned ${coinsEarned} coins via Gatekeeper.`);
    } else {
        // إذا لم يكسب، نجلب الرصيد الحالي فقط للعرض
        const { data: u } = await supabase.from('users').select('coins').eq('id', userId).single();
        newTotalCoins = u?.coins || 0;
    }

    // 5. إرجاع النتيجة للفرونت أند
    return { 
        success: true, 
        message: "Lesson unlocked!",
        // البيانات التي ينتظرها الفرونت أند
        reward: coinsEarned > 0 ? { coins_added: coinsEarned, reason: rewardReason } : null,
        new_total_coins: newTotalCoins
    };

  } catch (err) {
    logger.error('Gatekeeper Error:', err.message);
    return { success: false };
  }
}

module.exports = { markLessonComplete, trackStudyTime };
