
// services/arena/generator.js
'use strict';

const supabase = require('../data/supabase');
const { shuffled } = require('../../utils');
const logger = require('../../utils/logger');

/**
 * خدمة توليد الامتحان (The Arena Generator)
 * 1. تجلب هيكل الدرس (الذرات).
 * 2. تحاول إيجاد سؤال لكل ذرة لضمان تغطية شاملة بحد أقصى 10 أسئلة.
 * 3. تملأ الفراغات بأسئلة عشوائية لتكمل العدد إلى 10 بالضبط.
 */
async function generateArenaExam(lessonId, mode = 'practice') {
  try {
    // 1. جلب الهيكل الذري للدرس (Atomic Structure)
    const { data: structureData, error: structError } = await supabase
      .from('atomic_lesson_structures')
      .select('structure_data')
      .eq('lesson_id', lessonId)
      .single();

    if (structError || !structureData) {
      logger.warn(`Arena: No atomic structure found for lesson ${lessonId}. Falling back to random questions.`);
    }

    // استخراج معرفات الذرات (Atom IDs)
    const atoms = structureData?.structure_data?.elements || [];
    const atomIds = atoms.map(el => el.id); 

    // 2. جلب الأسئلة من بنك الأسئلة
    const { data: allQuestions, error: qError } = await supabase
      .from('question_bank')
      .select('id, atom_id, widget_type, content, difficulty')
      .eq('lesson_id', lessonId)
      .eq('is_verified', true); 

    if (qError || !allQuestions || allQuestions.length === 0) {
        throw new Error('No questions found for this lesson.');
    }

    // 3. خوارزمية التوزيع (10 أسئلة بالضبط)
    const TARGET_QUESTION_COUNT = 10;
    let selectedQuestions = [];
    const usedQuestionIds = new Set();

    // أ. محاولة إيجاد سؤال واحد لكل ذرة (Concept)
    for (const atomId of atomIds) {
        // إذا وصلنا للعدد المستهدف (10)، نتوقف فوراً حتى لو بقيت ذرات
        if (selectedQuestions.length >= TARGET_QUESTION_COUNT) break;

        const candidates = allQuestions.filter(q => q.atom_id === atomId);
        if (candidates.length > 0) {
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            selectedQuestions.push(picked);
            usedQuestionIds.add(picked.id);
        }
    }

    // ب. ملء الباقي للوصول إلى 10 أسئلة بالضبط
    if (selectedQuestions.length < TARGET_QUESTION_COUNT) {
        // نأخذ الأسئلة التي لم نستخدمها بعد
        const remainingQuestions = shuffled(allQuestions.filter(q => !usedQuestionIds.has(q.id)));
        
        // نحسب كم سؤالاً ناقصاً
        const needed = TARGET_QUESTION_COUNT - selectedQuestions.length;
        
        // نضيف العدد المطلوب (أو المتاح إذا كان المخزون قليلاً)
        selectedQuestions.push(...remainingQuestions.slice(0, needed));
    }

    // ج. إجراء احترازي: التأكد من أن المصفوفة لا تتجاوز 10 أبداً
    // (قد يحدث هذا إذا كان هناك خلل منطقي، لذا الـ slice هو صمام الأمان)
    selectedQuestions = selectedQuestions.slice(0, TARGET_QUESTION_COUNT);

    // 4. التنسيق النهائي (تنظيف البيانات من الإجابات)
    const examPayload = selectedQuestions.map(q => {
        // استنساخ المحتوى
        const clientContent = JSON.parse(JSON.stringify(q.content));
        
        // حذف الإجابات لمنع الغش
        if (q.widget_type === 'MCQ') {
            delete clientContent.correctAnswer;
            clientContent.options = shuffled(clientContent.options); 
        } else if (q.widget_type === 'TRUE_FALSE' || q.widget_type === 'YES_NO') {
             delete clientContent.correctAnswer;
        }
        // يمكن إضافة المزيد من التنظيف لباقي الأنواع (MCM, Ordering) هنا حسب هيكلة بياناتك
        
        return {
            id: q.id,
            type: q.widget_type,
            atom_id: q.atom_id, 
            content: clientContent,
            difficulty: q.difficulty,
            points: 2 // نقطتان لكل سؤال ليكون المجموع 20
        };
    });

    return {
        examId: crypto.randomUUID(), 
        lessonId,
        // خلط الترتيب النهائي للأسئلة لكي لا تظهر أسئلة الذرات متتالية دائماً
        questions: shuffled(examPayload) 
    };

  } catch (error) {
    logger.error(`Arena Generator Error [${lessonId}]:`, error.message);
    throw error;
  }
}

module.exports = { generateArenaExam };
