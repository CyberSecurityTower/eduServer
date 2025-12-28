// services/atomic/atomicManager.js
'use strict';

const supabase = require('../data/supabase'); // تأكد من المسار الصحيح
const CONFIG = require('../../config'); // تأكد من المسار

/**
 * دالة لجلب السياق الذري وحساب التقدم لحظياً
 * @param {string} userId 
 * @param {string} lessonId 
 */
async function getAtomicContext(userId, lessonId) {
  // 1. فحص زر الإيقاف (Kill Switch)
  if (!CONFIG.ATOMIC_SYSTEM?.ENABLED) {
    if (CONFIG.ATOMIC_SYSTEM?.DEBUG_MODE) console.log('⚠️ Atomic System is DISABLED.');
    return null;
  }

  try {
    // 2. جلب الهيكل + تقدم الطالب (بشكل متوازي للسرعة)
    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('elements_scores').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    // إذا لم يكن للدرس هيكل ذري، ننسحب بهدوء (نعود للنظام القديم)
    if (!structureRes.data) {
      if (CONFIG.ATOMIC_SYSTEM?.DEBUG_MODE) console.log(`ℹ️ No atomic structure found for lesson: ${lessonId}`);
      return null;
    }

    const structure = structureRes.data.structure_data; // { elements: [...] }
    const userScores = progressRes.data?.elements_scores || {}; // { "intro_loc": 50, ... }

    // 3. دمج البيانات وتحديد "الهدف التالي"
    let contextLines = [];
    let nextTarget = null;
    let totalWeightedScore = 0;
    let totalWeight = 0;

    // ترتيب العناصر حسب الـ order لضمان التسلسل المنطقي
    const sortedElements = structure.elements.sort((a, b) => a.order - b.order);

    contextLines.push(`📊 **ATOMIC LESSON PLAN (HIDDEN FROM USER):**`);
    
    for (const el of sortedElements) {
      const score = userScores[el.id] || 0; // 0 إذا لم يبدأ بعد
      const weight = el.weight || 1;
      
      // حساب المتوسط المرجح
      totalWeightedScore += (score * weight);
      totalWeight += weight;

      // تحديد الحالة للنظام
      let status = "PENDING";
      if (score >= 80) status = "MASTERED ✅";
      else if (score > 0) status = "IN_PROGRESS 🚧";
      
      // تحديد الهدف القادم (أول عنصر لم يتم إتقانه)
      if (!nextTarget && score < 60) {
        nextTarget = el;
        status += " 👈 (CURRENT FOCUS)";
      }

      contextLines.push(`- [${el.title}] (Weight: ${weight}): ${score}% -> ${status}`);
    }

    // حساب النسبة الكلية
    const globalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

    // 4. صياغة البرومبت النهائي (The Injection)
    const finalPromptContext = `
    ${contextLines.join('\n')}
    
    📈 **Global Lesson Mastery:** ${globalMastery}%
    🎯 **IMMEDIATE GOAL:** ${nextTarget ? `Explain/Test user on "${nextTarget.title}"` : "Lesson Complete! Review or Quiz."}
    
    **INSTRUCTIONS FOR AI:**
    1. You are guiding the user through the "ATOMIC LESSON PLAN" above.
    2. Do NOT list the percentages to the user. Use qualitative feedback (e.g., "Good job", "Let's focus on this").
    3. Do NOT move to the next element until the "CURRENT FOCUS" is understood.
    4. If the user asks about the whole lesson, mention the Global Mastery conceptually (e.g., "You are halfway there").
    `;

    return {
      prompt: finalPromptContext,
      rawData: { structure, userScores, nextTarget }, // نحتاجها لاحقاً للتحديث
      globalMastery // نحتاجها للتحديث
    };

  } catch (err) {
    console.error('❌ Atomic Manager Error:', err.message);
    return null; // في حالة الخطأ، نعود للنظام القديم بأمان
  }
}

module.exports = { getAtomicContext };
