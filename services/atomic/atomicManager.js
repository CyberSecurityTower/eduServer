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
      const score = userScores[el.id] || 0;
      const weight = el.weight || 1;
      
      totalWeightedScore += (score * weight);
      totalWeight += weight;

      let status = "PENDING";
      if (score >= 80) status = "MASTERED ✅";
      else if (score > 0) status = "IN_PROGRESS 🚧";
      
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
 * 2. اليد: تحديث التقدم (مع دعم التحديث الشامل والحارس)
 */
async function updateAtomicProgress(userId, lessonId, updateSignal) {
  if (!IS_ENABLED || !updateSignal) return;

  try {
    console.log(`⚛️ Attempting Atomic Update for ${lessonId}...`);

    // 1. جلب الهيكل (Structure) فقط
    // لا نجلب progress المستخدم هنا لأننا سنعتمد على Upsert لاحقاً
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
    
    // 2. جلب التقدم الحالي (للحساب فقط)
    const { data: progressRes } = await supabase
      .from('atomic_user_mastery')
      .select('elements_scores')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .single();

    let currentScores = progressRes?.elements_scores || {}; // ✅ إذا لم يوجد، نبدأ بكائن فارغ

    // 3. تطبيق التحديث (Logic)
    if (updateSignal.element_id === 'ALL') {
        console.log(`🚀 Setting ALL elements to ${updateSignal.new_score}%`);
        structure.elements.forEach(el => {
            currentScores[el.id] = updateSignal.new_score;
        });
    } else {
        // تحديث فردي مباشر
        console.log(`🔧 Updating element ${updateSignal.element_id} to ${updateSignal.new_score}%`);
        currentScores[updateSignal.element_id] = updateSignal.new_score;
    }

    // 4. إعادة حساب المعدل العام
    let totalWeightedScore = 0;
    let totalWeight = 0;

    structure.elements.forEach(el => {
      const score = currentScores[el.id] || 0;
      const weight = el.weight || 1;
      totalWeightedScore += (score * weight);
      totalWeight += weight;
    });

    const newGlobalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

    // 5. 🔥 الحفظ القسري (UPSERT)
    // هذا الأمر سينشئ الصف إذا لم يكن موجوداً
    const { error: upsertError } = await supabase.from('atomic_user_mastery').upsert({
      user_id: userId,
      lesson_id: lessonId,
      elements_scores: currentScores,
      current_mastery: newGlobalMastery,
      last_updated: new Date().toISOString(),
      status: newGlobalMastery >= 100 ? 'completed' : 'started' // ✅ تحديث الحالة أيضاً
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
    // جلب كل الذرات
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
module.exports = { getAtomicContext, updateAtomicProgress, getAtomicProgress };
