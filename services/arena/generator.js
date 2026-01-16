// arena/generator.js
'use strict';

const supabase = require('../data/supabase');
const { shuffled } = require('../../utils');
const logger = require('../../utils/logger');
const { encryptAnswer } = require('../../utils/cryptoHelper');
const crypto = require('crypto'); 

async function generateArenaExam(lessonId, mode = 'practice') {
  const cleanLessonId = lessonId.trim();
  console.log(`🔍 [DEBUG] Searching for lessonId: '${cleanLessonId}'`);

  try {
    // 🆕 1. جلب معرف المادة (subject_id) من جدول الدروس
    const { data: lessonMeta, error: metaError } = await supabase
      .from('lessons')
      .select('subject_id')
      .eq('id', cleanLessonId)
      .single();

    if (metaError) {
       console.log(`⚠️ [DEBUG] Could not fetch subject_id for '${cleanLessonId}'`);
    }

    const subjectId = lessonMeta?.subject_id;

    // 2. جلب الهيكل (Structure)
    const { data: structureData, error: structError } = await supabase
      .from('atomic_lesson_structures')
      .select('structure_data')
      .eq('lesson_id', cleanLessonId)
      .single();

    if (structError || !structureData) {
      console.log(`⚠️ [DEBUG] No structure found for '${cleanLessonId}'`);
    }

    const atoms = structureData?.structure_data?.elements || [];
    const atomIds = atoms.map(el => el.id); 

    // 3. جلب الأسئلة
    const { data: allQuestions, error: qError } = await supabase
      .from('question_bank')
      .select('id, atom_id, widget_type, content, difficulty, lesson_id')
      .eq('lesson_id', cleanLessonId)
      .neq('widget_type', 'FILL_BLANKS'); 

    let filteredQuestions = allQuestions;

    // طبقة أمان إضافية للفلترة
    if (allQuestions && allQuestions.length > 0) {
        filteredQuestions = allQuestions.filter(q => q.widget_type !== 'FILL_BLANKS');
    }

    console.log(`🔍 [DEBUG] Query Result Length after filter: ${filteredQuestions?.length}`);
    if (qError) console.error("❌ [DEBUG] Supabase Error:", qError);

    if (qError || !filteredQuestions || filteredQuestions.length === 0) {
        throw new Error('No questions found for this lesson.');
    }

    // منطق اختيار الـ 10 أسئلة
    const TARGET_QUESTION_COUNT = 10;
    let selectedQuestions = [];
    const usedQuestionIds = new Set();

    for (const atomId of atomIds) {
        if (selectedQuestions.length >= TARGET_QUESTION_COUNT) break;
        const candidates = filteredQuestions.filter(q => q.atom_id === atomId);
        if (candidates.length > 0) {
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            selectedQuestions.push(picked);
            usedQuestionIds.add(picked.id);
        }
    }

    if (selectedQuestions.length < TARGET_QUESTION_COUNT) {
        const remainingQuestions = shuffled(filteredQuestions.filter(q => !usedQuestionIds.has(q.id)));
        const needed = TARGET_QUESTION_COUNT - selectedQuestions.length;
        selectedQuestions.push(...remainingQuestions.slice(0, needed));
    }

    selectedQuestions = selectedQuestions.slice(0, TARGET_QUESTION_COUNT);

     const examPayload = selectedQuestions.map(q => {
        const clientContent = JSON.parse(JSON.stringify(q.content));
        
        // استخراج الإجابة الصحيحة الخام قبل الحذف
        let rawAnswer = null;
        
        switch (q.widget_type) {
            case 'MCQ':
            case 'TRUE_FALSE':
            case 'YES_NO':
            case 'MCM':
                rawAnswer = clientContent.correct_answer;
                break;
            case 'ORDERING':
                rawAnswer = clientContent.correct_order;
                break;
            case 'MATCHING':
                rawAnswer = clientContent.correct_matches;
                break;
        }

        // تشفير الإجابة
        const secureHash = encryptAnswer(rawAnswer);

        // تنظيف البيانات الخام (Anti-Cheat)
        if (q.widget_type === 'MCQ') {
            clientContent.options = shuffled(clientContent.options);
        }
        
        delete clientContent.correctAnswer;
        delete clientContent.correct_answer;
        delete clientContent.correct_order;
        delete clientContent.correct_matches;

        return {
            id: q.id,
            type: q.widget_type,
            atom_id: q.atom_id, 
            content: {
                ...clientContent,
                secure_hash: secureHash 
            },
            difficulty: q.difficulty,
            points: 2 
        };
    });

    return {
        examId: crypto.randomUUID(), 
        lessonId: cleanLessonId,
        subjectId: subjectId, 
        questions: shuffled(examPayload) 
    };

  } catch (error) {
    logger.error(`Generator Error:`, error.message);
    throw error;
  }
}

module.exports = { generateArenaExam };
