
// services/arena/generator.js
'use strict';

const supabase = require('../data/supabase');
const { shuffled } = require('../../utils');
const logger = require('../../utils/logger');

async function generateArenaExam(lessonId, mode = 'practice') {
  try {
    // 1. جلب الهيكل الذري للدرس
    const { data: structureData, error: structError } = await supabase
      .from('atomic_lesson_structures')
      .select('structure_data')
      .eq('lesson_id', lessonId)
      .single();

    if (structError || !structureData) {
      logger.warn(`Arena: No atomic structure found for lesson ${lessonId}. Falling back to random questions.`);
    }

    const atoms = structureData?.structure_data?.elements || [];
    const atomIds = atoms.map(el => el.id); 

    // 2. جلب الأسئلة من بنك الأسئلة
    // 🔥 التعديل هنا: تم إزالة شرط .eq('is_verified', true) ليقبل كل الأسئلة
    const { data: allQuestions, error: qError } = await supabase
      .from('question_bank')
      .select('id, atom_id, widget_type, content, difficulty')
      .eq('lesson_id', lessonId);
      // .eq('is_verified', true); <--- تم تعطيل هذا الشرط مؤقتاً للتجربة

    if (qError || !allQuestions || allQuestions.length === 0) {
        throw new Error('No questions found for this lesson.');
    }

    // 3. خوارزمية التوزيع (10 أسئلة بالضبط)
    const TARGET_QUESTION_COUNT = 10;
    let selectedQuestions = [];
    const usedQuestionIds = new Set();

    // أ. محاولة إيجاد سؤال واحد لكل ذرة
    for (const atomId of atomIds) {
        if (selectedQuestions.length >= TARGET_QUESTION_COUNT) break;

        const candidates = allQuestions.filter(q => q.atom_id === atomId);
        if (candidates.length > 0) {
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            selectedQuestions.push(picked);
            usedQuestionIds.add(picked.id);
        }
    }

    // ب. ملء الباقي للوصول إلى 10 أسئلة
    if (selectedQuestions.length < TARGET_QUESTION_COUNT) {
        const remainingQuestions = shuffled(allQuestions.filter(q => !usedQuestionIds.has(q.id)));
        const needed = TARGET_QUESTION_COUNT - selectedQuestions.length;
        selectedQuestions.push(...remainingQuestions.slice(0, needed));
    }

    // ج. التأكد من العدد النهائي
    selectedQuestions = selectedQuestions.slice(0, TARGET_QUESTION_COUNT);

    // 4. التنسيق النهائي
    const examPayload = selectedQuestions.map(q => {
        const clientContent = JSON.parse(JSON.stringify(q.content));
        
        if (q.widget_type === 'MCQ') {
            delete clientContent.correctAnswer;
            clientContent.options = shuffled(clientContent.options); 
        } else if (q.widget_type === 'TRUE_FALSE' || q.widget_type === 'YES_NO') {
             delete clientContent.correctAnswer;
        }
        
        return {
            id: q.id,
            type: q.widget_type,
            atom_id: q.atom_id, 
            content: clientContent,
            difficulty: q.difficulty,
            points: 2 // نقطتان لكل سؤال
        };
    });

    return {
        examId: crypto.randomUUID(), 
        lessonId,
        questions: shuffled(examPayload) 
    };

  } catch (error) {
    logger.error(`Arena Generator Error [${lessonId}]:`, error.message);
    throw error;
  }
}

module.exports = { generateArenaExam };
