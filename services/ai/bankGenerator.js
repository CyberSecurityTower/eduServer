// services/ai/bankGenerator.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');

class BankGeneratorService {
    
    /**
     * العثور على درس مؤهل للتوليد (لديه محتوى وهيكلة ولكن ليس لديه أسئلة)
     */
    async findEligibleLesson() {
        // 1. جلب كل الدروس التي لديها محتوى
        const { data: lessonsWithContent } = await supabase
            .from('lessons')
            .select('id, title')
            .eq('has_content', true);

        if (!lessonsWithContent || lessonsWithContent.length === 0) return null;

        // 2. التحقق من وجود أسئلة في البنك
        // ملاحظة: هذه العملية قد تكون ثقيلة إذا كان البنك كبيراً، لذا يفضل استخدام RPC أو طريقة أذكى
        // للتبسيط، سنفحص عينة أو نستخدم Not In إذا كانت البيانات قليلة
        
        for (const lesson of lessonsWithContent) {
            // هل لديه هيكلة ذرية؟
            const { data: structure } = await supabase
                .from('atomic_lesson_structures')
                .select('id')
                .eq('lesson_id', lesson.id)
                .single();
            
            if (!structure) continue; // تخطى إذا لم يكن له هيكل ذري

            // هل لديه أسئلة؟
            const { count } = await supabase
                .from('question_bank')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson.id);

            if (count === 0) {
                return lesson; // وجدنا صيداً ثميناً!
            }
        }

        return null;
    }

    /**
     * توليد الأسئلة وحفظها
     */
    async generateAndSaveQuestions(lesson) {
        logger.info(`🏦 BankGen: Starting generation for "${lesson.title}" (${lesson.id})...`);

        try {
            // 1. جلب البيانات اللازمة
            const [contentRes, structureRes] = await Promise.all([
                supabase.from('lessons_content').select('content').eq('id', lesson.id).single(),
                supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
            ]);

            const content = contentRes.data?.content;
            const atoms = structureRes.data?.structure_data?.elements || [];

            if (!content || atoms.length === 0) {
                logger.error(`❌ Missing data for lesson ${lesson.id}`);
                return false;
            }

            // تحضير قائمة الذرات للذكاء الاصطناعي
            const atomsList = atoms.map(a => ({ id: a.id, title: a.title }));

            // 2. استدعاء الذكاء الاصطناعي
            const prompt = QUESTION_GENERATION_PROMPT(lesson.title, content, atomsList);
            
            // نستخدم موديل ذكي (Pro) للحصول على JSON دقيق
            const res = await generateWithFailover('analysis', prompt, { 
                label: 'BankGenerator',
                timeoutMs: 120000 
            });

            const rawText = await extractTextFromResult(res);
            const questionsArray = await ensureJsonOrRepair(rawText, 'analysis');

            if (!questionsArray || !Array.isArray(questionsArray) || questionsArray.length === 0) {
                logger.error('❌ AI returned invalid JSON for questions.');
                return false;
            }

            // 3. التحقق والمعالجة (Sanitization)
            const validQuestions = questionsArray
                .filter(q => q.content && q.widget_type && q.atom_id)
                .map(q => ({
                    lesson_id: lesson.id,
                    atom_id: q.atom_id,
                    widget_type: q.widget_type.toUpperCase(),
                    difficulty: q.difficulty || 'Medium',
                    content: q.content, // JSONB auto-conversion
                    created_at: new Date().toISOString()
                }));

            if (validQuestions.length === 0) return false;

            // 4. الحفظ في قاعدة البيانات
            const { error } = await supabase
                .from('question_bank')
                .insert(validQuestions);

            if (error) throw error;

            logger.success(`✅ BankGen: Inserted ${validQuestions.length} questions for "${lesson.title}".`);
            return true;

        } catch (err) {
            logger.error(`❌ BankGen Error [${lesson.id}]:`, err.message);
            return false;
        }
    }
}

module.exports = new BankGeneratorService();
