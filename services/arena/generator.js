
// services/arena/generator.js
'use strict';

const supabase = require('../data/supabase');
const { shuffled } = require('../../utils');
const logger = require('../../utils/logger');

/**
 * خدمة توليد الامتحان (The Arena Generator)
 * 1. تجلب هيكل الدرس (الذرات).
 * 2. تحاول إيجاد سؤال لكل ذرة لضمان تغطية شاملة.
 * 3. تملأ الفراغات بأسئلة عشوائية من نفس الدرس إذا نقصت الأسئلة.
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
    const atomIds = atoms.map(el => el.id); // ['intro', 'concept_1', 'concept_2'...]

    // 2. جلب الأسئلة من بنك الأسئلة
    // سنجلب كل الأسئلة المتاحة لهذا الدرس (أو عينة كبيرة) ثم نصفيها برمجياً لضمان التوزيع
    const { data: allQuestions, error: qError } = await supabase
      .from('question_bank')
      .select('id, atom_id, widget_type, content, difficulty')
      .eq('lesson_id', lessonId)
      .eq('is_verified', true); // فقط الأسئلة الموثقة

    if (qError || !allQuestions || allQuestions.length === 0) {
        throw new Error('No questions found for this lesson.');
    }

    // 3. خوارزمية التوزيع الذكي (Atom Coverage)
    let selectedQuestions = [];
    const usedQuestionIds = new Set();

    // أ. محاولة إيجاد سؤال واحد لكل ذرة (Concept)
    for (const atomId of atomIds) {
        // نخلط الأسئلة المتاحة لهذه الذرة ونأخذ واحداً
        const candidates = allQuestions.filter(q => q.atom_id === atomId);
        if (candidates.length > 0) {
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            selectedQuestions.push(picked);
            usedQuestionIds.add(picked.id);
        }
    }

    // ب. إذا كان عدد الأسئلة قليلاً (أقل من 5 مثلاً)، نملأ الباقي عشوائياً من نفس الدرس
    const MIN_QUESTIONS = 5;
    if (selectedQuestions.length < MIN_QUESTIONS) {
        const remainingQuestions = shuffled(allQuestions.filter(q => !usedQuestionIds.has(q.id)));
        const needed = MIN_QUESTIONS - selectedQuestions.length;
        selectedQuestions.push(...remainingQuestions.slice(0, needed));
    }

    // 4. التنسيق النهائي (تنظيف البيانات)
    // لا نرسل الإجابة الصحيحة للفرونت أند لمنع الغش!
    const examPayload = selectedQuestions.map(q => {
        // استنساخ المحتوى لعدم تعديل الأصل
        const clientContent = JSON.parse(JSON.stringify(q.content));
        
        // حذف حقل الإجابة الصحيحة بناءً على نوع السؤال
        if (q.widget_type === 'MCQ') {
            delete clientContent.correctAnswer; // نحذف الإجابة
            clientContent.options = shuffled(clientContent.options); // خلط الخيارات
        } else if (q.widget_type === 'TRUE_FALSE') {
             delete clientContent.correctAnswer;
        }
        
        return {
            id: q.id,
            type: q.widget_type,
            atom_id: q.atom_id, // مفيد للفرونت ليعرف أي مفهوم يختبر
            content: clientContent,
            difficulty: q.difficulty
        };
    });

    return {
        examId: crypto.randomUUID(), // معرف مؤقت للجلسة
        lessonId,
        questions: shuffled(examPayload) // خلط ترتيب الأسئلة النهائي
    };

  } catch (error) {
    logger.error(`Arena Generator Error [${lessonId}]:`, error.message);
    throw error;
  }
}

module.exports = { generateArenaExam };
