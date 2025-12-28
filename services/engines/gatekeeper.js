// services/engines/gatekeeper.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');

/**
 * 🪙 Gatekeeper V2: Atomic Reward System
 * يمنح المكافآت بناءً على الإتقان الذري (Atomic Mastery) فقط.
 * تم حذف تتبع الوقت وجدول user_progress القديم نهائياً.
 */
async function markLessonComplete(userId, lessonIdentifier, score = 100) {
  try {
    console.log(`🔐 Gatekeeper V2: Checking rewards for ${userId} on "${lessonIdentifier}"`);

    let finalLessonId = lessonIdentifier;
    let isGenericActivity = false;

    // 1. محاولة العثور على الدرس (ID Resolution)
    // إذا كان المدخل نصاً عربياً (عنوان)، نبحث عن الـ ID
    const isTitle = /[\u0600-\u06FF\s]/.test(lessonIdentifier) || lessonIdentifier.length > 50;

    if (isTitle) {
        const cleanTitle = lessonIdentifier.replace(/درس|مادة|شرح/g, '').trim();
        const { data: lesson } = await supabase
            .from('lessons')
            .select('id')
            .ilike('title', `%${cleanTitle}%`)
            .limit(1)
            .maybeSingle();

        if (lesson) {
            finalLessonId = lesson.id;
        } else {
            console.warn(`⚠️ Gatekeeper: Lesson not found. Switching to GENERIC mode.`);
            isGenericActivity = true;
            finalLessonId = null;
        }
    }

    // 2. تحليل الحالة الذرية (The Atomic Logic)
    let coinsEarned = 0;
    let rewardReason = '';
    let isFirstTimeMastery = false;

    if (!isGenericActivity && finalLessonId) {
        // جلب سجل الإتقان الذري
        const { data: atomicRecord, error } = await supabase
            .from('atomic_user_mastery')
            .select('current_mastery, is_rewarded')
            .eq('user_id', userId)
            .eq('lesson_id', finalLessonId)
            .maybeSingle();

        if (atomicRecord) {
            // الشرط: هل الإتقان تجاوز 80%؟ (يمكنك تعديل النسبة)
            const isMastered = (atomicRecord.current_mastery >= 80);

            if (isMastered && !atomicRecord.is_rewarded) {
                // 💰 الجائزة الكبرى: أول مرة يتقن الدرس
                coinsEarned = 50;
                rewardReason = 'atomic_mastery_unlocked';
                isFirstTimeMastery = true;
            } else if (atomicRecord.is_rewarded && score >= 100) {
                // 🍬 بونوس: مراجعة مثالية
                coinsEarned = 5;
                rewardReason = 'atomic_review_bonus';
            } else {
                rewardReason = 'already_mastered_no_bonus';
            }
        } else {
            // لم يبدأ الدرس في النظام الذري بعد
            rewardReason = 'no_atomic_record';
        }
    } else {
        // نشاط عام (خارج الدروس المحددة)
        coinsEarned = 10;
        rewardReason = 'generic_activity';
    }

    // 3. تنفيذ المعاملة المالية (Transaction)
    let newTotalCoins = 0;

    if (coinsEarned > 0) {
        const { data: balance, error } = await supabase.rpc('process_coin_transaction', {
            p_user_id: userId,
            p_amount: coinsEarned,
            p_reason: rewardReason,
            p_meta: { 
                lesson_id: finalLessonId, 
                mastery_score: score 
            }
        });
        
        if (!error) {
            console.log(`✅ Coins Added: +${coinsEarned} (${rewardReason})`);
            newTotalCoins = balance;

            // 🔥 تحديث السجل الذري لكي لا يأخذ الجائزة الكبرى مرة أخرى
            if (isFirstTimeMastery && finalLessonId) {
                await supabase
                    .from('atomic_user_mastery')
                    .update({ is_rewarded: true })
                    .eq('user_id', userId)
                    .eq('lesson_id', finalLessonId);
            }
        } else {
            console.error("❌ RPC Error:", error.message);
        }
    } else {
        // جلب الرصيد الحالي فقط للعرض
        const { data: u } = await supabase.from('users').select('coins').eq('id', userId).single();
        newTotalCoins = u?.coins || 0;
    }

    return { 
        success: true, 
        reward: { 
            coins_added: coinsEarned, 
            reason: rewardReason
        },
        new_total_coins: newTotalCoins
    };

  } catch (err) {
    logger.error('Gatekeeper V2 Error:', err.message);
    return { success: false };
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
module.exports = { markLessonComplete, checkAtomicMastery };
