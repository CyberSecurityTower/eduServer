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
    // 1. جلب البيانات
    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('*').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    if (!structureRes.data) return;

    const structure = structureRes.data.structure_data;
    let currentScores = progressRes.data?.elements_scores || {};

    // 🔥 المنطق الجديد: التمييز بين التحديث الشامل والتحديث الفردي
    if (updateSignal.element_id === 'ALL') {
        // ==========================
        // 🚀 BULK UPDATE (The Shortcut)
        // ==========================
        console.log(`🚀 ATOMIC BULK UPDATE: Setting ALL elements to ${updateSignal.new_score}%`);
        
        structure.elements.forEach(el => {
            currentScores[el.id] = updateSignal.new_score;
        });

    } else {
        // ==========================
        // 🛡️ INDIVIDUAL UPDATE (The Gatekeeper)
        // ==========================
        console.log(`⚛️ Atomic Update: User ${userId} -> Element ${updateSignal.element_id} = ${updateSignal.new_score}%`);

        const oldScore = currentScores[updateSignal.element_id] || 0;
        const scoreDiff = updateSignal.new_score - oldScore;
        let finalScore = updateSignal.new_score;

        // أ. الكبح (Damping)
        if (scoreDiff > 60 && updateSignal.reason !== 'quiz_perfect') {
            console.log(`⚠️ Gatekeeper: Damping huge jump for ${updateSignal.element_id} (${scoreDiff}%)`);
            finalScore = oldScore + 60;
            if (finalScore > 100) finalScore = 100;
        }

        // ب. التسلسل (Sequential Check)
        const currentElementObj = structure.elements.find(e => e.id === updateSignal.element_id);
        if (currentElementObj && currentElementObj.order > 1) {
            const prevElement = structure.elements.find(e => e.order === currentElementObj.order - 1);
            const prevScore = currentScores[prevElement.id] || 0;
            
            if (prevScore < 30 && finalScore > 50) {
                 console.log(`🛡️ Gatekeeper: Holding back ${updateSignal.element_id} because previous element is weak.`);
                 finalScore = 50;
            }
        }

        currentScores[updateSignal.element_id] = finalScore;
    }

    // 3. إعادة حساب المعدل العام
    let totalWeightedScore = 0;
    let totalWeight = 0;

    structure.elements.forEach(el => {
      const score = currentScores[el.id] || 0;
      const weight = el.weight || 1;
      totalWeightedScore += (score * weight);
      totalWeight += weight;
    });

    const newGlobalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

    // 4. الحفظ
    await supabase.from('atomic_user_mastery').upsert({
      user_id: userId,
      lesson_id: lessonId,
      elements_scores: currentScores,
      current_mastery: newGlobalMastery,
      last_updated: new Date().toISOString()
    }, { onConflict: 'user_id, lesson_id' });

    console.log(`📈 New Global Mastery for ${lessonId}: ${newGlobalMastery}%`);

    // 5. 🔥 استدعاء الحارس الذري (Atomic Gatekeeper)
    // إذا وصل الإتقان 95%، نمنح الكوينز ونغلق الدرس
    if (newGlobalMastery >= 95) {
        const rewardResult = await checkAtomicMastery(userId, lessonId, newGlobalMastery);
        
        if (rewardResult && rewardResult.reward) {
            console.log(`🎉 MOLECULE STABILIZED! User ${userId} mastered ${lessonId}`);
            // هنا لا نحتاج لفعل شيء آخر، الحارس تكفل بإضافة الكوينز وتحديث الحالة
        }
    }

  } catch (err) {
    console.error('❌ Atomic Update Failed:', err.message);
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
