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
  // 1. فحص زر الإيقاف
  if (!CONFIG.ATOMIC_SYSTEM?.ENABLED) {
    if (CONFIG.ATOMIC_SYSTEM?.DEBUG_MODE) console.log('⚠️ Atomic System is DISABLED.');
    return null;
  }

  try {
    console.log(`🔍 Atomic Lookup: Lesson=${lessonId}, User=${userId}`);

    // 2. جلب الهيكل + تقدم الطالب
    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('elements_scores').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    // 🔥 طباعة أخطاء Supabase (التشخيص الدقيق)
    if (structureRes.error) {
        console.error(`❌ SUPABASE ERROR (Structure):`, JSON.stringify(structureRes.error, null, 2));
    }
    
    // ملاحظة: خطأ التقدم (PGRST116) طبيعي إذا كان الطالب جديداً، لذا لا نعتبره خطأً خطيراً
    if (progressRes.error && progressRes.error.code !== 'PGRST116') {
        console.error(`❌ SUPABASE ERROR (Progress):`, JSON.stringify(progressRes.error, null, 2));
    }

    // إذا لم يكن للدرس هيكل ذري
    if (!structureRes.data) {
      console.log(`ℹ️ No atomic structure found for lesson: ${lessonId} (Check DB or RLS)`);
      return null;
    }

    const structure = structureRes.data.structure_data;
    const userScores = progressRes.data?.elements_scores || {};

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


/**
 * دالة لتحديث تقدم الطالب وحساب المعدل الجديد
 */
async function updateAtomicProgress(userId, lessonId, updateSignal) {
  if (!updateSignal || !updateSignal.element_id) return;

  try {
    console.log(`⚛️ Atomic Update: User ${userId} -> Element ${updateSignal.element_id} = ${updateSignal.new_score}%`);

    // 1. جلب الهيكل + التقدم الحالي
    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('*').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    if (!structureRes.data) return; // لا يوجد هيكل

    const structure = structureRes.data.structure_data;
    // إذا لم يكن للطالب سجل، ننشئ كائناً فارغاً
    let currentScores = progressRes.data?.elements_scores || {};
// أ. التحقق من القفزات الكبيرة (اختياري - لزيادة الصرامة)
    const oldScore = currentScores[updateSignal.element_id] || 0;
    const scoreDiff = updateSignal.new_score - oldScore;
    
    // إذا قفز الطالب أكثر من 60 درجة في رسالة واحدة، نعتبرها مشبوهة ونقللها (Damping)
    // إلا إذا كان السبب "Quiz Perfect Score"
    let finalScore = updateSignal.new_score;
    if (scoreDiff > 60 && updateSignal.reason !== 'quiz_perfect') {
        console.log(`⚠️ Gatekeeper: Damping huge jump for ${updateSignal.element_id} (${scoreDiff}%)`);
        finalScore = oldScore + 60; // نسمح بزيادة 60% كحد أقصى في التفاعل الواحد
        if (finalScore > 100) finalScore = 100;
    }

    // ب. التحقق من التسلسل (هل أنهى ما قبله؟)
    // نجلب ترتيب العنصر الحالي
    const currentElementObj = structure.elements.find(e => e.id === updateSignal.element_id);
    if (currentElementObj && currentElementObj.order > 1) {
        // نبحث عن العنصر السابق
        const prevElement = structure.elements.find(e => e.order === currentElementObj.order - 1);
        const prevScore = currentScores[prevElement.id] || 0;
        
        // إذا كان العنصر السابق ضعيفاً جداً (أقل من 30%)، نمنع إتقان العنصر الحالي تماماً
        // نسمح له بالتعلم (حتى 50%) لكن لا نمنحه الإتقان الكامل حتى يعود للوراء
        if (prevScore < 30 && finalScore > 50) {
             console.log(`🛡️ Gatekeeper: Holding back ${updateSignal.element_id} because previous element is weak.`);
             finalScore = 50; // سقف مؤقت
        }
    }

    // تطبيق الدرجة النهائية
    currentScores[updateSignal.element_id] = finalScore;

    // 3. إعادة حساب المعدل التراكمي (Weighted Average)
    let totalWeightedScore = 0;
    let totalWeight = 0;

    structure.elements.forEach(el => {
      const score = currentScores[el.id] || 0;
      const weight = el.weight || 1;
      totalWeightedScore += (score * weight);
      totalWeight += weight;
    });

    const newGlobalMastery = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

    // 4. الحفظ في الداتابيز (Upsert)
    await supabase.from('atomic_user_mastery').upsert({
      user_id: userId,
      lesson_id: lessonId,
      elements_scores: currentScores,
      current_mastery: newGlobalMastery,
      last_updated: new Date().toISOString()
    }, { onConflict: 'user_id, lesson_id' });

    console.log(`📈 New Global Mastery for ${lessonId}: ${newGlobalMastery}%`);

  } catch (err) {
    console.error('❌ Atomic Update Failed:', err.message);
  }
}

module.exports = { getAtomicContext, updateAtomicProgress };
