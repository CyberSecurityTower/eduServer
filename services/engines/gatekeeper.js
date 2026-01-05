// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const TIERS = require('../../config/tiers');
//tries plan check

async function checkFeatureAccess(userId, featureName) {
    try {
        const { getProfile } = require('../data/helpers'); 
        // نستخدم getProfile لأنها مخزنة في الكاش (سريعة جداً)
        const profile = await getProfile(userId);
        const sub = profile.subscription;
        
        // 1. فحص الحد اليومي (Usage Limit)
        // نستثني الأدمين من فحص العداد
        if (sub.plan !== 'admin' && sub.remainingToday <= 0) {
            return { 
                granted: false, 
                reason: 'limit_exceeded',
                message: 'انتهت محاولاتك المجانية لليوم. عد غداً أو قم بالترقية لـ EduPrime.',
                upgrade_cta: true
            };
        }

        // 2. فحص صلاحية الميزة (Feature Gating)
        const tierConfig = TIERS[sub.plan];
        const isAllowed = tierConfig.features.includes('*') || tierConfig.features.includes(featureName);

        if (!isAllowed) {
            return { 
                granted: false, 
                reason: 'feature_locked',
                message: `ميزة "${featureName}" متاحة فقط في باقة ${TIERS['pro'].label}.`,
                upgrade_cta: true
            };
        }

        return { granted: true };

    } catch (err) {
        logger.error('Gatekeeper Error:', err);
        return { granted: false, message: 'خطأ في التحقق من الاشتراك.' };
    }
}

/**
 * 🪙 Gatekeeper V2: Atomic Reward System
 * يمنح المكافآت بناءً على الإتقان الذري (Atomic Mastery) فقط.
 * تم حذف تتبع الوقت وجدول user_progress القديم نهائياً.
 */

async function markLessonComplete(userId, lessonId, score, overrideCoins = null) {
  try {
    // 1. التحقق من الحالة الحالية للدرس
    const { data: currentProgress } = await supabase
      .from('user_progress') // تأكد أن هذا هو اسم جدول التقدم عندك
      .select('is_rewarded, status, best_score')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .single();

    const isFirstTime = !currentProgress || currentProgress.status !== 'completed';
    const alreadyRewarded = currentProgress?.is_rewarded || false;
    
    // 2. تحديد قيمة المكافأة
    let coinsToAdd = 0;
    
    // إذا لم يأخذ المكافأة من قبل، وحقق النجاح (أو تم تمرير كوينز يدوياً)
    if (!alreadyRewarded && (isFirstTime || score >= 50)) {
        coinsToAdd = overrideCoins !== null ? overrideCoins : 50; // 50 كوينز افتراضياً
    }

    // 3. تنفيذ المعاملة المالية (إذا وجد كوينز)
    let transactionSuccess = false;
    if (coinsToAdd > 0) {
        const { error: rpcError } = await supabase.rpc('process_coin_transaction', {
            p_user_id: userId,
            p_amount: coinsToAdd,
            p_reason: 'lesson_completion',
            p_meta: { lesson_id: lessonId, score: score }
        });

        if (!rpcError) {
            transactionSuccess = true;
            logger.success(`💰 User ${userId} earned ${coinsToAdd} coins for lesson ${lessonId}`);
        } else {
            logger.error(`❌ Coin Transaction Failed: ${rpcError.message}`);
        }
    }

    // 4. تحديث التقدم في قاعدة البيانات (مع قفل المكافأة) 🔥
    const updatePayload = {
        user_id: userId,
        lesson_id: lessonId,
        status: 'completed',
        last_accessed: new Date().toISOString(),
        score: score, // نسجل آخر سكور
        // نحتفظ بأفضل سكور
        best_score: Math.max(score, currentProgress?.best_score || 0)
    };

    // 🔥🔥🔥 التصحيح هنا: نحدث is_rewarded فقط إذا تمت المعاملة بنجاح 🔥🔥🔥
    if (transactionSuccess || alreadyRewarded) {
        updatePayload.is_rewarded = true; 
    }

    const { error: upsertError } = await supabase
        .from('user_progress')
        .upsert(updatePayload, { onConflict: 'user_id, lesson_id' });

    if (upsertError) throw upsertError;

    // 5. إرجاع النتيجة للـ Controller
    return {
        success: true,
        new_status: 'completed',
        reward: {
            coins_added: transactionSuccess ? coinsToAdd : 0,
            already_claimed: alreadyRewarded && coinsToAdd === 0
        }
    };

  } catch (err) {
    logger.error(`Gatekeeper Error for ${lessonId}:`, err.message);
    return { success: false, error: err.message };
  }
}
/**
 * ⚛️ ATOMIC GATEKEEPER
 * يراقب استقرار الجزيء (الدرس). إذا وصل الاستقرار لـ 95%، يمنح المكافأة.
 */
async function checkAtomicMastery(userId, lessonId, currentMastery) {
    if (currentMastery < 95) return null; // لم يصل للحد المطلوب

    // 1. هل أخذ المكافأة من قبل؟
    // نفحص جدول المعاملات المالية أو حقل في atomic_user_mastery
    const { data: existing } = await supabase
        .from('atomic_user_mastery')
        .select('status')
        .eq('user_id', userId)
        .eq('lesson_id', lessonId)
        .single();

    if (existing && existing.status === 'mastered') {
        return { reward: false, message: 'Already Claimed' };
    }

    // 2. منح المكافأة (لأول مرة)
    // تحديث الحالة إلى mastered
    await supabase
        .from('atomic_user_mastery')
        .update({ status: 'mastered' })
        .eq('user_id', userId)
        .eq('lesson_id', lessonId);

    // إضافة الكوينز
    const REWARD_AMOUNT = 50;
    await supabase.rpc('process_coin_transaction', {
        p_user_id: userId,
        p_amount: REWARD_AMOUNT,
        p_reason: 'molecule_stabilized', // سبب علمي 😉
        p_meta: { lesson_id: lessonId }
    });

    return { 
        reward: true, 
        coins: REWARD_AMOUNT, 
        type: 'MOLECULE_STABILIZED' 
    };
}
// تصدير الدالة الوحيدة (تم حذف trackStudyTime)
module.exports = { markLessonComplete, checkAtomicMastery, checkFeatureAccess };
