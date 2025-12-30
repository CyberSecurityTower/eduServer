// services/atomic/atomicManager.js
'use strict';

const supabase = require('../data/supabase');
const CONFIG = require('../../config');
// 🔥 استيراد الحارس الذري لمنح المكافآت
const { checkAtomicMastery } = require('../engines/gatekeeper');

// 🛑 Kill Switch
const IS_ENABLED = CONFIG.ATOMIC_SYSTEM?.ENABLED || true;

/**
 * 1. العين: جلب السياق الذري للدرس
 * (يدعم قراءة الأرقام القديمة والكائنات الذكية الجديدة)
 */
async function getAtomicContext(userId, lessonId) {
  if (!IS_ENABLED) {
    if (CONFIG.ATOMIC_SYSTEM?.DEBUG_MODE) console.log('⚠️ Atomic System is DISABLED.');
    return null;
  }

  try {
    console.log(`🔍 Atomic Lookup: Lesson=${lessonId}, User=${userId}`);

    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('elements_scores').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    // Error Logging
    if (structureRes.error) console.error(`❌ SUPABASE ERROR (Structure):`, JSON.stringify(structureRes.error));
    if (progressRes.error && progressRes.error.code !== 'PGRST116') console.error(`❌ SUPABASE ERROR (Progress):`, JSON.stringify(progressRes.error));

    if (!structureRes.data) {
      console.log(`ℹ️ No atomic structure found for lesson: ${lessonId}`);
      return null;
    }

    const structure = structureRes.data.structure_data;
    const userScores = progressRes.data?.elements_scores || {};

    // تحليل العناصر
    let contextLines = [];
    let nextTarget = null;
    let totalWeightedScore = 0;
    let totalWeight = 0;

    const sortedElements = structure.elements.sort((a, b) => a.order - b.order);

    contextLines.push(`📊 **ATOMIC LESSON PLAN (HIDDEN FROM USER):**`);
    
    for (const el of sortedElements) {
      // 👇 الذكاء هنا: التحقق من نوع البيانات (رقم أم كائن)
      const rawVal = userScores[el.id];
      let score = 0;
      let isReviewDue = false;

      if (typeof rawVal === 'number') {
          score = rawVal; // النظام القديم
      } else if (rawVal && typeof rawVal === 'object') {
          score = rawVal.score || 0; // النظام الجديد
          
          // 🧠 فحص موعد المراجعة (SRS Check)
          if (rawVal.next_review && new Date() > new Date(rawVal.next_review)) {
              isReviewDue = true;
          }
      }

      const weight = el.weight || 1;
      
      totalWeightedScore += (score * weight);
      totalWeight += weight;

      let status = "PENDING";
      if (score >= 80) status = "MASTERED ✅";
      else if (score > 0) status = "IN_PROGRESS 🚧";
      
      // 🚨 تنبيه المراجعة للـ AI
      if (isReviewDue) {
          status += " ⏰ (REVIEW DUE!)";
          // إذا حان وقت المراجعة، نجعل هذا العنصر هو الهدف التالي فوراً
          if (!nextTarget) nextTarget = el; 
      }
      
      if (!nextTarget && score < 60) {
        nextTarget = el;
        status += " 👈 (CURRENT FOCUS)";
      }

      contextLines.push(`- [${el.title}] (Weight: ${weight}): ${score}% -> ${status}`);
    }

    const globalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;
    
    // 1. استخراج قائمة الـ IDs والعناوين لتعليم الـ AI
    const mappingList = sortedElements.map(el => `- "${el.title}" => ID: "${el.id}"`).join('\n');
    
    const finalPromptContext = `
    ${contextLines.join('\n')}
    
    📈 **Global Lesson Mastery:** ${globalMastery}%
    🎯 **IMMEDIATE GOAL:** ${nextTarget ? `Explain/Test user on "${nextTarget.title}"` : "Lesson Complete! Review or Quiz."}
    
    **INSTRUCTIONS FOR AI:**
    1. Guide the user through the "ATOMIC LESSON PLAN".
    2. Do NOT list percentages to the user.
    3. Do NOT move to the next element until "CURRENT FOCUS" is understood.
    4. 🚨 **STRICT UPDATE RULE:** If the user explains a concept correctly, YOU MUST MARK IT AS MASTERED. Do NOT just praise them. You MUST output the JSON signal.
       Example: { "atomic_update": { "element_id": "geo_historical_impact", "new_score": 90 } }.
       
    🚨 **CRITICAL INSTRUCTION FOR AI (ID MAPPING):**
    When updating progress, you MUST use the EXACT ID from this list corresponding to the topic the user discussed:
    ${mappingList}

    ❌ DO NOT invent new IDs like "intro_loc" or use Arabic titles as IDs.
    ✅ Example: If user explains "الموقع الجغرافي", send: { "atomic_update": { "element_id": "geo_location_borders", "new_score": 90 } }
    `;

    return {
      prompt: finalPromptContext,
      rawData: { structure, userScores, nextTarget },
      globalMastery
    };

  } catch (err) {
    console.error('❌ Atomic Manager Error:', err.message);
    return null;
  }
}

/**
 * 2. اليد: تحديث التقدم (باستخدام محرك Cortex-X)
 */
async function updateAtomicProgress(userId, lessonId, updateSignal) {
  if (!IS_ENABLED || !updateSignal) return;

  try {
    console.log(`⚛️ Attempting Atomic Update for ${lessonId}...`);

    // 1. جلب الهيكل (Structure)
    const { data: structureRes, error: structError } = await supabase
      .from('atomic_lesson_structures')
      .select('structure_data')
      .eq('lesson_id', lessonId)
      .single();

    if (structError || !structureRes) {
        console.warn(`⚠️ Atomic Structure missing for ${lessonId}. Update skipped.`);
        return;
    }

    const structure = structureRes.structure_data;
    
    // 2. جلب التقدم الحالي
    const { data: progressRes } = await supabase
      .from('atomic_user_mastery')
      .select('elements_scores')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .single();

    let currentScores = progressRes?.elements_scores || {}; 

    // 3. تطبيق التحديث (Logic)
    if (updateSignal.element_id === 'ALL') {
        // Bulk Update (تجاوز المحرك العصبي مؤقتاً للتحديث الشامل)
        console.log(`🚀 Setting ALL elements to ${updateSignal.new_score}%`);
        structure.elements.forEach(el => {
            // يمكننا هنا تطبيق منطق بسيط للكل، أو مجرد وضع السكور
            currentScores[el.id] = { 
                score: updateSignal.new_score, 
                stability: 10, // افتراض استقرار متوسط عند الإتقان الشامل
                difficulty: 5,
                reps: 1,
                last_review: new Date().toISOString()
            };
        });

    } else {
        // ====================================================
        // 🧠 Cortex-X Integration (Individual Update)
        // ====================================================
        console.log(`🔧 Updating element ${updateSignal.element_id} to ${updateSignal.new_score}%`);
        
        const oldDataRaw = currentScores[updateSignal.element_id];
        
        // Backward Compatibility: تحويل الرقم القديم إلى كائن
        let oldDataObj = {};
        if (typeof oldDataRaw === 'number') {
            oldDataObj = { score: oldDataRaw, stability: 0, difficulty: 5, reps: 1 };
        } else {
            oldDataObj = oldDataRaw || {};
        }

        // 🔥 استدعاء المحرك العصبي
        const neuroData = calculateNeuroParams(oldDataObj, updateSignal.new_score);

        // الحفظ
        currentScores[updateSignal.element_id] = neuroData;
        
        console.log(`🧠 Neuro-Update: Stability=${neuroData.stability} days | Difficulty=${neuroData.difficulty} | Next=${neuroData.next_review}`);
    }

    // 4. إعادة حساب المعدل العام (Global Mastery)
    let totalWeightedScore = 0;
    let totalWeight = 0;

    structure.elements.forEach(el => {
      const val = currentScores[el.id];
      // التعامل مع الرقم أو الكائن لحساب المعدل
      const score = (typeof val === 'number') ? val : (val?.score || 0);
      const weight = el.weight || 1;
      
      totalWeightedScore += (score * weight);
      totalWeight += weight;
    });

    const newGlobalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

    // 5. الحفظ في الداتابايز (Upsert)
    const status = newGlobalMastery >= 95 ? 'completed' : 'started';

    const { error: upsertError } = await supabase.from('atomic_user_mastery').upsert({
      user_id: userId,
      lesson_id: lessonId,
      elements_scores: currentScores,
      current_mastery: newGlobalMastery,
      last_updated: new Date().toISOString(),
      status: status 
    }, { onConflict: 'user_id, lesson_id' });

    if (upsertError) {
        console.error(`❌ DB WRITE ERROR:`, upsertError.message);
    } else {
        console.log(`✅ DB SUCCESS: Saved progress for ${lessonId} (Mastery: ${newGlobalMastery}%)`);
    }

    // 6. استدعاء الحارس للمكافآت
    if (newGlobalMastery >= 95) {
        await checkAtomicMastery(userId, lessonId, newGlobalMastery);
    }

  } catch (err) {
    console.error('❌ Critical Atomic Error:', err.message);
  }
}

/**
 * 3. المجمع: جلب التقدم الذري للمستخدم (بديل getProgress القديم)
 */
async function getAtomicProgress(userId) {
  try {
    const { data: atomicData, error } = await supabase
      .from('atomic_user_mastery')
      .select('lesson_id, current_mastery, status, last_updated')
      .eq('user_id', userId);

    if (error) throw error;

    const progressMap = {}; 
    const completedLessons = [];
    let totalScore = 0;

    if (atomicData) {
        atomicData.forEach(row => {
            progressMap[row.lesson_id] = {
                score: row.current_mastery,
                status: row.status || (row.current_mastery >= 95 ? 'completed' : 'in_progress'),
                lastAttempt: row.last_updated
            };

            if (row.current_mastery >= 95) {
                completedLessons.push(row.lesson_id);
            }
            totalScore += row.current_mastery;
        });
    }

    return {
        stats: {
            lessons_started: atomicData ? atomicData.length : 0,
            lessons_mastered: completedLessons.length,
            global_mastery: (atomicData && atomicData.length > 0) ? Math.round(totalScore / atomicData.length) : 0
        },
        atomicMap: progressMap,
        dailyTasks: { tasks: [] }
    };

  } catch (err) {
    console.error('Atomic getProgress Error:', err.message);
    return { atomicMap: {}, stats: {} };
  }
}

/**
 * 🧠 Cortex-X Engine: Advanced FSRS Logic
 * يحسب المعاملات العصبية بناءً على الأداء والوقت والصعوبة.
 * (أقوى من الوجود! 😉)
 */
function calculateNeuroParams(oldData, newScore) {
    // 1. الثوابت (FSRS Weights Standard)
    const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61]; 
    
    // 2. استخراج الحالة السابقة
    let s = oldData?.stability || 0; 
    let d = oldData?.difficulty || 5; 
    let r = oldData?.reps || 0;
    
    // 3. تقييم الأداء (Rating) من 1 إلى 4
    let rating = 1;
    if (newScore >= 95) rating = 4;      // Easy
    else if (newScore >= 80) rating = 3; // Good
    else if (newScore >= 60) rating = 2; // Hard
    else rating = 1;                     // Fail

    // 4. حساب الفاصل الزمني الفعلي
    const now = new Date();
    const lastReview = oldData?.last_review ? new Date(oldData.last_review) : now;
    const daysElapsed = Math.max(0, (now - lastReview) / (1000 * 60 * 60 * 24));

    // ====================================================
    // 🚀 المحرك الرياضي (The Math Magic)
    // ====================================================

    if (r === 0) {
        // 🔥 اللقاء الأول
        d = 5 - (rating - 3); 
        s = (rating === 1) ? 0.5 : (rating === 2 ? 1 : (rating === 3 ? 3 : 7)); 
    } else {
        // 🔄 المراجعات اللاحقة
        
        // أ. تحديث الصعوبة
        let nextD = d - 0.8 + (0.08 * (4 - rating) * 0.05) + (rating === 1 ? 2 : 0);
        d = Math.min(10, Math.max(1, nextD)); 

        if (rating > 1) {
            // ✅ نجاح: زيادة الاستقرار (مع مكافأة التأخير)
            const nextS = s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - rating) * W[10]) - 1) + (daysElapsed / s) * 0.5); 
            s = Math.min(365, nextS); 
        } else {
            // ❌ فشل: انهيار الاستقرار (النسيان)
            const nextS = 0.5 * Math.pow(d, -0.5) * Math.pow(s, 0.1); 
            s = Math.max(0.5, nextS);
        }
    }

    // 5. تحديد موعد المراجعة القادم (مع تشويش بسيط لمنع التكدس)
    const nextDate = new Date();
    const fuzz = (Math.random() * 0.1) - 0.05; // +/- 5%
    const finalDays = Math.max(0.5, s * (1 + fuzz));
    
    nextDate.setDate(nextDate.getDate() + finalDays);

    return {
        score: newScore,
        stability: parseFloat(s.toFixed(2)),
        difficulty: parseFloat(d.toFixed(2)),
        reps: r + 1,
        last_review: now.toISOString(),
        next_review: nextDate.toISOString()
    };
}

module.exports = { getAtomicContext, updateAtomicProgress, getAtomicProgress };
