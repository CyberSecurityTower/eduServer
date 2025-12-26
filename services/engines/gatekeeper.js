// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * ⏱️ دالة تتبع الوقت التراكمي (للشات أو القراءة)
 * تضيف وقتاً للرصيد الحالي ولا تمس حالة الإكمال
 */

async function trackStudyTime(userId, lessonId, durationSeconds = 60) {
  try {
    // 1. جلب السجل الحالي (إن وجد)
    const { data: existing, error: fetchError } = await supabase
      .from('user_progress')
      .select('time_spent_seconds, id')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .maybeSingle(); // نستخدم maybeSingle لتجنب الخطأ إذا لم يوجد

    if (fetchError) throw fetchError;

    let newTotalTime = durationSeconds;

    if (existing) {
      // 2. إذا كان موجوداً، نضيف الوقت الجديد للقديم
      newTotalTime += (existing.time_spent_seconds || 0);
      
      // تحديث السجل الموجود
      await supabase
        .from('user_progress')
        .update({ 
            time_spent_seconds: newTotalTime,
            last_interaction: new Date().toISOString()
        })
        .eq('id', existing.id); // نحدث بالـ ID لضمان الدقة
        
    } else {
      // 3. إذا لم يكن موجوداً، ننشئ سجلاً جديداً (Upsert للأمان)
      await supabase
        .from('user_progress')
        .upsert({
          user_id: userId,
          lesson_id: lessonId,
          time_spent_seconds: newTotalTime,
          last_interaction: new Date().toISOString(),
          status: 'in_progress', // حالة افتراضية
          mastery_score: 0
        }, { onConflict: 'user_id, lesson_id' }); // 🔥 هذا يمنع خطأ duplicate key
    }

    return true;
  } catch (err) {
    logger.error(`trackStudyTime Error for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * إشارة إكمال الدرس + نظام المكافآت (EduCoin Integration) 🪙
 */
async function markLessonComplete(userId, lessonIdentifier, score = 100, addedTime = 0) {
  try {
    console.log(`🔐 Gatekeeper: Processing for ${userId} (Input: ${lessonIdentifier})`);

    let finalLessonId = lessonIdentifier;
    let isGenericActivity = false; // 🆕 علم جديد: هل النشاط عام أم درس محدد؟

    // 1. محاولة العثور على الدرس
    const isTitle = /[\u0600-\u06FF\s]/.test(lessonIdentifier) || lessonIdentifier.length > 50;

    if (isTitle) {
        // تنظيف العنوان قليلاً لزيادة فرص العثور عليه
        const cleanTitle = lessonIdentifier.replace(/درس|مادة|شرح/g, '').trim();
        
        const { data: lesson } = await supabase
            .from('lessons')
            .select('id')
            .ilike('title', `%${cleanTitle}%`) // بحث مرن
            .limit(1)
            .maybeSingle();

        if (lesson) {
            finalLessonId = lesson.id;
        } else {
            console.warn(`⚠️ Gatekeeper: Lesson "${lessonIdentifier}" not found. Switching to GENERIC REWARD mode.`);
            isGenericActivity = true; // لم نجد الدرس، لكن لن نوقف العملية
            finalLessonId = null;
        }
    }

    // 2. تحديث التقدم (فقط إذا عرفنا الدرس المحدد)
    let wasCompletedBefore = false;
    
    if (!isGenericActivity && finalLessonId) {
        const { data: current } = await supabase
            .from('user_progress')
            .select('status, time_spent_seconds')
            .eq('user_id', userId)
            .eq('lesson_id', finalLessonId)
            .maybeSingle();

        wasCompletedBefore = current?.status === 'completed';
        const totalTime = (current?.time_spent_seconds || 0) + addedTime;

        await supabase.from('user_progress').upsert({
            user_id: userId,
            lesson_id: finalLessonId,
            status: 'completed',
            mastery_score: score,
            time_spent_seconds: totalTime,
            last_interaction: new Date().toISOString()
        }, { onConflict: 'user_id, lesson_id' });
    }

    // 3. 🪙 حساب الكوينز (الآن يعمل حتى لو لم نجد الدرس)
    let coinsEarned = 0;
    let rewardReason = '';

    if (isGenericActivity) {
        // حالة خاصة: نشاط عام (كويز عشوائي أو درس غير معروف)
        // نعطي مكافأة ثابتة لضمان رضا المستخدم
        coinsEarned = 30; 
        rewardReason = 'general_activity_reward';
    } else {
        // حالة الدرس المعروف
        if (!wasCompletedBefore) {
            coinsEarned = 50;
            rewardReason = 'lesson_completion';
        } else {
            // إعادة الدرس
            if (score >= 95) {
                coinsEarned = 5;
                rewardReason = 'review_mastery';
            } else {
                rewardReason = 'already_claimed';
            }
        }
    }

    let newTotalCoins = 0;

    // 4. تنفيذ المعاملة المالية
    if (coinsEarned > 0) {
        const { data: balance, error } = await supabase.rpc('process_coin_transaction', {
            p_user_id: userId,
            p_amount: coinsEarned,
            p_reason: rewardReason,
            p_meta: { 
                lesson_identifier: lessonIdentifier, // نسجل الاسم الأصلي للمراجعة
                is_generic: isGenericActivity,
                score: score 
            }
        });
        
        if (!error) {
            console.log(`✅ Coins Added: ${coinsEarned}. New Balance: ${balance}`);
            newTotalCoins = balance;
        } else {
            console.error("❌ RPC Error:", error.message);
        }
    } else {
        const { data: u } = await supabase.from('users').select('coins').eq('id', userId).single();
        newTotalCoins = u?.coins || 0;
    }

    return { 
        success: true, 
        message: "Processed",
        reward: { 
            coins_added: coinsEarned, 
            reason: rewardReason,
            already_claimed: (!isGenericActivity && wasCompletedBefore && coinsEarned === 0)
        },
        new_total_coins: newTotalCoins
    };

  } catch (err) {
    logger.error('Gatekeeper Critical Error:', err.message);
    return { success: false };
  }
}

module.exports = { markLessonComplete, trackStudyTime };
