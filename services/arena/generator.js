
// services/arena/generator.js
'use strict';

const supabase = require('../data/supabase');
const { shuffled } = require('../../utils');
const logger = require('../../utils/logger');

async function generateArenaExam(lessonId, mode = 'practice') {
  // 1. تنظيف المعرف من أي مسافات زائدة
  const cleanLessonId = lessonId.trim();

  // 🔥 طباعة للتشخيص (انظر للتيرمينال بعد تشغيل هذا)
  console.log(`🔍 [DEBUG] Searching for lessonId: '${cleanLessonId}'`);

  try {
    // 1. جلب الهيكل الذري
    const { data: structureData, error: structError } = await supabase
      .from('atomic_lesson_structures')
      .select('structure_data')
      .eq('lesson_id', cleanLessonId) // استخدام المعرف النظيف
      .single();

    if (structError || !structureData) {
      console.log(`⚠️ [DEBUG] No structure found for '${cleanLessonId}'`);
    }

    const atoms = structureData?.structure_data?.elements || [];
    const atomIds = atoms.map(el => el.id); 

    // 2. جلب الأسئلة
    // 🚨 انتبه: لقد أزلت شرط التوثيق تماماً هنا
    const { data: allQuestions, error: qError } = await supabase
      .from('question_bank')
      .select('id, atom_id, widget_type, content, difficulty, lesson_id') // أضفت lesson_id للتأكد
      .eq('lesson_id', cleanLessonId);

    // 🔥 طباعة نتيجة الاستعلام
    console.log(`🔍 [DEBUG] Query Result Length: ${allQuestions?.length}`);
    if (qError) console.error("❌ [DEBUG] Supabase Error:", qError);

    if (qError || !allQuestions || allQuestions.length === 0) {
        // هذا السطر هو الذي يسبب الخطأ عندك، اللوج أعلاه سيخبرنا لماذا وصلنا هنا
        throw new Error('No questions found for this lesson.');
    }

    // ... باقي الكود كما هو (منطق الـ 10 أسئلة) ...
    const TARGET_QUESTION_COUNT = 10;
    let selectedQuestions = [];
    const usedQuestionIds = new Set();

    for (const atomId of atomIds) {
        if (selectedQuestions.length >= TARGET_QUESTION_COUNT) break;
        const candidates = allQuestions.filter(q => q.atom_id === atomId);
        if (candidates.length > 0) {
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            selectedQuestions.push(picked);
            usedQuestionIds.add(picked.id);
        }
    }

    if (selectedQuestions.length < TARGET_QUESTION_COUNT) {
        const remainingQuestions = shuffled(allQuestions.filter(q => !usedQuestionIds.has(q.id)));
        const needed = TARGET_QUESTION_COUNT - selectedQuestions.length;
        selectedQuestions.push(...remainingQuestions.slice(0, needed));
    }

    selectedQuestions = selectedQuestions.slice(0, TARGET_QUESTION_COUNT);

     const examPayload = selectedQuestions.map(q => {
        // استنساخ المحتوى
        const clientContent = JSON.parse(JSON.stringify(q.content));
        
        //  حذف مفاتيح الإجابات بناءً على نوع السؤال
        switch (q.widget_type) {
            case 'MCQ':
                clientContent.options = shuffled(clientContent.options); 
                delete clientContent.correctAnswer;
                break;
            case 'TRUE_FALSE':
            case 'YES_NO':
            case 'MCM':
            case 'FILL_BLANKS':
                delete clientContent.correctAnswer;
                break;
            case 'ORDERING':
                delete clientContent.correct_order;
                break;
            case 'MATCHING':
                delete clientContent.correct_matches;
                break;
        }
        
        return {
            id: q.id,
            type: q.widget_type,
            atom_id: q.atom_id, 
            content: clientContent, // الآن المحتوى نظيف تماماً
            difficulty: q.difficulty,
            points: 2 
        };
    });

    return {
        examId: crypto.randomUUID(), 
        lessonId: cleanLessonId,
        questions: shuffled(examPayload) 
    };

  } catch (error) {
    logger.error(`Arena Generator Error [${lessonId}]:`, error.message);
    throw error;
  }
}

module.exports = { generateArenaExam };
