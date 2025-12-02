// services/ai/managers/curriculumManager.js
'use strict';

// استيراد المكتبات والملفات اللازمة
const supabase = require('../../data/supabase');
const { explainLessonContent } = require('../../engines/ghostTeacher');
const logger = require('../../../utils/logger');

let embeddingServiceRef;

/**
 * تهيئة المدير وحقن التبعيات
 */
function initCurriculumManager(dependencies) {
  embeddingServiceRef = dependencies.embeddingService;
}

/**
 * المحرك المنهجي المطور (Hybrid Search)
 * يقوم بالبحث عن الدرس بالاسم أولاً (بحث دقيق)، وفي حال عدم وجوده يلجأ للبحث بالمعنى (RAG).
 * 
 * @param {string} userId - معرف المستخدم
 * @param {string} userMessage - رسالة المستخدم
 * @returns {Promise<string>} - سياق الدرس أو المحتوى
 */
async function runCurriculumAgent(userId, userMessage) {
  try {
    // ============================================================
    // 1. البحث المباشر عن عنوان درس (Keyword Search)
    // ============================================================
    
    // تنظيف الرسالة لاستخراج الكلمات المفتاحية المحتملة لعنوان الدرس
    const cleanQuery = userMessage
      .replace(/اشرح لي درس/g, '')
      .replace(/اشرح درس/g, '')
      .replace(/explain lesson/gi, '')
      .replace(/ما هو/g, '')
      .replace(/عن ماذا يتحدث/g, '')
      .trim();

    // التحقق فقط إذا كان طول النص المتبقي كافياً للبحث
    if (cleanQuery.length > 3) {
        // البحث في جدول الدروس باستخدام ilike (غير حساس لحالة الأحرف)
        const { data: exactLesson } = await supabase
            .from('lessons')
            .select('id, title, has_content, subjects(title)')
            .ilike('title', `%${cleanQuery}%`) // بحث جزئي في العنوان
            .limit(1)
            .maybeSingle();

        if (exactLesson) {
            logger.info(`🎯 Curriculum Manager: Found exact lesson match: "${exactLesson.title}"`);
            
            let content = "";
            
            // السيناريو أ: الدرس موجود وله محتوى جاهز
            if (exactLesson.has_content) {
                const { data: c } = await supabase
                    .from('lessons_content')
                    .select('content')
                    .eq('id', exactLesson.id)
                    .single();
                content = c?.content || "";
            } 
            // السيناريو ب: الدرس موجود كعنوان لكنه فارغ -> استدعاء "المعلم الشبح" لتوليده
            else {
                logger.info(`👻 Triggering Ghost Teacher for lesson: ${exactLesson.id}`);
                const ghost = await explainLessonContent(exactLesson.id, userId);
                content = ghost.content;
            }

            // إرجاع النتيجة مباشرة مما يوفر دقة عالية جداً
            return `📚 **FOUND LESSON:** "${exactLesson.title}" (${exactLesson.subjects?.title || 'General'})\n\nContent:\n${content.slice(0, 2000)}...`;
        }
    }

    // ============================================================
    // 2. البحث الدلالي (Vector Search / RAG) - الخطة البديلة
    // ============================================================
    
    // إذا لم نجد تطابقاً مباشراً بالاسم، نبحث في الـ Vector DB عن المعنى
    if (!embeddingServiceRef) return '';
    
    const questionEmbedding = await embeddingServiceRef.generateEmbedding(userMessage);
    if (!questionEmbedding.length) return '';

    const similarChunks = await embeddingServiceRef.findSimilarEmbeddings(
      questionEmbedding,
      'curriculum_embeddings',
      3,
      'UAlger3_L1_ITCF' // ملاحظة: يفضل جعل هذا المتغير ديناميكياً مستقبلاً بناءً على بيانات الطالب
    );

    if (!similarChunks.length) return '';

    return `📚 **CURRICULUM SNIPPETS (Semantic Search):**\n${similarChunks.map(c => c.text).join('\n---\n')}`;

  } catch (error) {
    logger.error('CurriculumAgent error:', error.message);
    return ''; // في حالة الخطأ نعود بسلسلة فارغة ليكمل الـ AI من معرفته العامة
  }
}

module.exports = {
  initCurriculumManager,
  runCurriculumAgent
};
