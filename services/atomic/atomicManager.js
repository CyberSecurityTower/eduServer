// services/atomic/atomicManager.js
'use strict';

const supabase = require('../data/supabase');
const { checkAtomicMastery } = require('../engines/gatekeeper');

/**
 * 1. العين (The Eye): جلب السياق الذري للدرس
 * يطبق مبدأ Lazy Sync: يدمج الهيكلة الأصلية مع تقدم المستخدم في الذاكرة (RAM).
 */
async function getAtomicContext(userId, lessonId) {
  try {
    // A. جلب الهيكلة الأصلية (Master Structure) وتقدم المستخدم بالتوازي
    const [structureRes, progressRes] = await Promise.all([
      supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lessonId).single(),
      supabase.from('atomic_user_mastery').select('elements_scores').eq('user_id', userId).eq('lesson_id', lessonId).single()
    ]);

    // إذا لم يكن هناك هيكلة ذرية لهذا الدرس، نعود فارغين
    if (!structureRes.data) return null;

    const structure = structureRes.data.structure_data;
    // إذا لم يكن لدى المستخدم سجل، نبدأ بكائن فارغ
    const userScores = progressRes.data?.elements_scores || {};

    // B. التحليل والدمج (Lazy Sync Logic)
    let contextLines = [];
    let nextTarget = null; // ما هو العنصر التالي الذي يجب دراسته؟
    
    // ترتيب العناصر حسب التسلسل التعليمي
    const sortedElements = structure.elements.sort((a, b) => a.order - b.order);

    contextLines.push(`🗺️ **ATOMIC ROADMAP (Lesson Structure):**`);

    for (const el of sortedElements) {
      // 1. البحث عن سكور المستخدم لهذا العنصر
      // إذا كان العنصر جديداً (أضيف حديثاً للمنهج)، لن نجده في userScores -> نعتبره 0 تلقائياً
      const rawVal = userScores[el.id];
      let score = 0;

      if (rawVal && typeof rawVal === 'object') {
          score = rawVal.score || 0;
      } else if (typeof rawVal === 'number') {
          score = rawVal;
      }
      
      // 2. تحديد الحالة للعرض
      let status = "⬜ Not Started";
      if (score >= 80) status = "✅ Mastered";
      else if (score > 0) status = "🚧 In Progress";

      // 3. تحديد التركيز الحالي (أول عنصر غير متقن)
      let focusMarker = "";
      if (!nextTarget && score < 80) {
        nextTarget = el;
        focusMarker = "👈 [CURRENT FOCUS]";
        status = "🔥 WORKING ON THIS";
      }

      contextLines.push(`- [ID: ${el.id}] ${el.title}: (${score}%) ${status} ${focusMarker}`);
    }

    // C. صياغة البرومبت للـ AI
    // نعطيه الخريطة كاملة ليعرف أين هو المستخدم وإلى أين يذهب
   const finalPrompt = `
    ${contextLines.join('\n')}
    
    🎯 **IMMEDIATE GOAL:** Help user understand: "${nextTarget ? nextTarget.title : 'Review/Quiz'}"
    
    **INSTRUCTIONS:**
    1. You see the full roadmap above. Guide the user step-by-step based on their current progress.
    2. If user asks about a future topic, answer briefly but remind them: "We will get there soon (see roadmap), let's focus on ${nextTarget?.title} first."
    3. **NOTE:** Do NOT generate any progress updates or JSON scores. Just teach the content efficiently.
    `;
    return {
      prompt: finalPrompt,
      nextTargetId: nextTarget?.id
    };

  } catch (err) {
    console.error('❌ Atomic Context Error:', err.message);
    return null;
  }
}

/**
 * 2. اليد (The Hand): تحديث التقدم
 * (لم نغير فيها الكثير، فقط تأكدنا أنها خفيفة)
 */
async function updateAtomicProgress(userId, lessonId, updateSignal) {
  if (!updateSignal || !updateSignal.element_id) return;

  try {
    // 1. جلب التقدم الحالي
    const { data: progressRes } = await supabase
      .from('atomic_user_mastery')
      .select('elements_scores')
      .eq('user_id', userId)
      .eq('lesson_id', lessonId)
      .single();

    let currentScores = progressRes?.elements_scores || {}; 

    // 2. التحديث المباشر (بدون FSRS معقد الآن لنسرع العملية)
    const elId = updateSignal.element_id;
    
    if (elId === 'ALL') {
        // حالة خاصة: نجاح في امتحان شامل
        // (يمكنك تنفيذ منطق تحديث الكل هنا)
    } else {
        // تحديث عنصر واحد
        currentScores[elId] = {
            score: updateSignal.new_score,
            last_updated: new Date().toISOString()
        };
    }

    // 3. الحفظ
    await supabase.from('atomic_user_mastery').upsert({
      user_id: userId,
      lesson_id: lessonId,
      elements_scores: currentScores,
      last_updated: new Date().toISOString()
    }, { onConflict: 'user_id, lesson_id' });

    console.log(`✅ Atomic Update: ${elId} -> ${updateSignal.new_score}%`);

  } catch (err) {
    console.error('Atomic Update Error:', err.message);
  }
}

module.exports = { getAtomicContext, updateAtomicProgress };
