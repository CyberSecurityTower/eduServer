// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, ensureJsonOrRepair, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');

// 🛡️ لمنع تضارب العاملين (Workers) على نفس الدرس
const activeProcessingIds = new Set();

class GeniusBankWorker {
    
    constructor() {
        this.MAX_CONCURRENCY = 2; // عدد الطلبات المتوازية
        this.STOP_SIGNAL = false;
    }

    /**
     * 🟢 نقطة الانطلاق الرئيسية
     */
    async startMission() {
        logger.info('🚀 Genius Bank Mission Started: Initializing Dual-Core Processing...');
        
        // 1. قفل النظام
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;

        try {
            // تشغيل عاملين (Workers) في نفس الوقت
            const worker1 = this._workerLoop(1);
            const worker2 = this._workerLoop(2);

            // انتظار انتهاء الاثنين
            await Promise.all([worker1, worker2]);

            logger.success('🏁 Mission Accomplished: All queues processed.');

        } catch (err) {
            logger.error('💥 Critical Mission Failure:', err);
        } finally {
            // 2. فتح النظام
            systemHealth.setMaintenanceMode(false);
            activeProcessingIds.clear();
        }
    }

    /**
     * 🔄 حلقة عمل العامل الواحد
     */
    async _workerLoop(workerId) {
        logger.info(`👷 Worker #${workerId} is online and hungry for data.`);

        while (!this.STOP_SIGNAL) {
            // أ. البحث عن هدف
            const lesson = await this._findNextTarget();

            if (!lesson) {
                logger.info(`💤 Worker #${workerId}: No more lessons found. I retire.`);
                break; // إنهاء الحلقة
            }

            // ب. المعالجة "العنيدة" (لن يترك الدرس حتى ينجزه)
            await this._processLessonStubbornly(workerId, lesson);
            
            // ج. استراحة محارب لتبريد المفاتيح
            await sleep(2000); 
        }
    }

    /**
     * 🔍 البحث الذكي (يتخطى ما يعمل عليه العامل الآخر)
     */
    async _findNextTarget() {
        // جلب الدروس التي لها محتوى + هيكلية + 0 أسئلة
        // ملاحظة: نجلب 10 لنختار منهم ما ليس في الـ Set
        const { data: candidates } = await supabase
            .from('lessons')
            .select('id, title, subjects(title)') // ✅ جلبنا اسم المادة
            .eq('has_content', true)
            .limit(20); 

        if (!candidates) return null;

        for (const lesson of candidates) {
            // 1. هل يتم معالجته حالياً؟
            if (activeProcessingIds.has(lesson.id)) continue;

            // 2. هل لديه أسئلة بالفعل؟ (تحقق مزدوج)
            const { count } = await supabase
                .from('question_bank')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson.id);

            if (count > 0) continue;

            // 3. هل لديه هيكلية ذرية؟
            const { data: struct } = await supabase
                .from('atomic_lesson_structures')
                .select('id')
                .eq('lesson_id', lesson.id)
                .single();

            if (!struct) continue;

            // ✅ وجدنا هدفاً صالحاً!
            activeProcessingIds.add(lesson.id); // حجز الدرس
            return lesson;
        }

        return null;
    }

    /**
     * 💎 المعالجة العنيدة (The Stubborn Processor)
     * هذا هو "الذكاء" الحقيقي: لا يستسلم للأخطاء التقنية.
     */
    async _processLessonStubbornly(workerId, lesson) {
        const subjectTitle = lesson.subjects?.title || 'General';
        const logPrefix = `[Worker #${workerId}] 📘 ${subjectTitle} -> ${lesson.title}`;
        
        let success = false;
        let attempt = 1;
        let backoffMs = 5000; // 5 ثواني كبداية

        while (!success && !this.STOP_SIGNAL) {
            try {
                logger.info(`${logPrefix} | ⏳ Generating... (Attempt ${attempt})`);

                // 1. جلب البيانات الخام
                const [contentRes, structureRes] = await Promise.all([
                    supabase.from('lessons_content').select('content').eq('id', lesson.id).single(),
                    supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
                ]);

                if (!contentRes.data?.content) {
                    throw new Error("DATA_MISSING"); // خطأ قاتل (نخرج من اللوب)
                }

                const atomsList = structureRes.data.structure_data.elements.map(a => ({ id: a.id, title: a.title }));

                // 2. استدعاء الذكاء الاصطناعي
                const prompt = QUESTION_GENERATION_PROMPT(lesson.title, contentRes.data.content, atomsList);
                
                const res = await generateWithFailover('analysis', prompt, { 
                    label: `BankGen_${workerId}`,
                    timeoutMs: 180000, // 3 دقائق
                    maxRetries: 1 // لا تعيد المحاولة داخلياً، نحن نتحكم هنا
                });

                const rawText = await extractTextFromResult(res);
                const questionsArray = await ensureJsonOrRepair(rawText, 'analysis');

                // 3. التحقق الصارم
                if (!questionsArray || !Array.isArray(questionsArray) || questionsArray.length < 5) {
                    throw new Error("AI_BAD_OUTPUT"); // نعتبره خطأ يستحق الإعادة
                }

                // 4. الحفظ
                const validQuestions = questionsArray.map(q => ({
                    lesson_id: lesson.id,
                    atom_id: q.atom_id,
                    widget_type: q.widget_type.toUpperCase(),
                    difficulty: q.difficulty || 'Medium',
                    content: q.content,
                    created_at: new Date().toISOString()
                }));

                const { error } = await supabase.from('question_bank').insert(validQuestions);
                if (error) throw error;

                // 🎉 نجاح!
                logger.success(`✅ ${logPrefix} | DONE! Generated ${validQuestions.length} Qs.`);
                success = true;

            } catch (err) {
                // 🛑 تحليل الخطأ بذكاء
                const errMsg = err.message || '';
                
                if (errMsg.includes("DATA_MISSING")) {
                    logger.error(`${logPrefix} | ❌ Fatal Data Error. Skipping lesson.`);
                    success = true; // نخرج من اللوب لكي لا نعلق للأبد في درس فارغ
                } 
                else if (errMsg.includes("429") || errMsg.includes("Quota") || errMsg.includes("AI_BAD_OUTPUT")) {
                    // ⚠️ مشاكل تقنية أو غباء مؤقت من الـ AI -> ننتظر ونحاول مجدداً
                    logger.warn(`${logPrefix} | ⚠️ Issue: ${errMsg}. Holding queue... waiting ${backoffMs/1000}s`);
                    await sleep(backoffMs);
                    backoffMs = Math.min(backoffMs * 1.5, 60000); // زيادة وقت الانتظار تدريجياً حتى دقيقة
                    attempt++;
                } 
                else {
                    // أخطاء غير معروفة -> ننتظر قليلاً ونحاول
                    logger.error(`${logPrefix} | 💥 Error: ${errMsg}. Retrying...`);
                    await sleep(5000);
                    attempt++;
                }
            }
        }
        
        // إزالة الحجز عند الانتهاء (سواء نجح أو فشل نهائياً)
        activeProcessingIds.delete(lesson.id);
    }

    stop() {
        this.STOP_SIGNAL = true;
    }
}

module.exports = new GeniusBankWorker();
