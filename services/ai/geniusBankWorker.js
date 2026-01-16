// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, ensureJsonOrRepair, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');

// 🛡️ لمنع تضارب العاملين
const activeProcessingIds = new Set();

// ⏳ جدول إعادة المحاولة (بالمللي ثانية)
const RETRY_SCHEDULE = [
    60 * 1000,           // 1 دقيقة
    2 * 60 * 1000,       // 2 دقيقة
    10 * 60 * 1000,      // 10 دقائق
    30 * 60 * 1000,      // 30 دقيقة
    60 * 60 * 1000,      // 1 ساعة
    2 * 60 * 60 * 1000,  // 2 ساعة
    4 * 60 * 60 * 1000   // 4 ساعات (المحاولة الأخيرة)
];

class GeniusBankWorker {
    
    constructor() {
        this.STOP_SIGNAL = false;
        this.isWorking = false;
    }

    /**
     * 🛑 زر الطوارئ (Emergency Stop)
     */
    stop() {
        if (this.isWorking) {
            logger.warn('🛑 STOP SIGNAL RECEIVED. Aborting operations after current step...');
            this.STOP_SIGNAL = true;
            return true;
        }
        return false;
    }

    async startMission() {
        if (this.isWorking) {
            logger.warn('⚠️ Mission already running.');
            return;
        }

        logger.info('🚀 Genius Bank Mission Started.');
        
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;

        try {
            // تشغيل محركين
            const worker1 = this._workerLoop(1);
            const worker2 = this._workerLoop(2);

            await Promise.all([worker1, worker2]);

            if (this.STOP_SIGNAL) {
                logger.warn('🚫 Mission Aborted by Admin or System Limit.');
            } else {
                logger.success('🏁 Mission Accomplished Successfully.');
            }

        } catch (err) {
            logger.error('💥 Critical Mission Failure:', err);
        } finally {
            systemHealth.setMaintenanceMode(false);
            activeProcessingIds.clear();
            this.isWorking = false;
        }
    }

    async _workerLoop(workerId) {
        logger.info(`👷 Worker #${workerId} online.`);

        while (!this.STOP_SIGNAL) {
            const lesson = await this._findNextTarget();

            if (!lesson) {
                logger.info(`💤 Worker #${workerId}: Queue empty.`);
                break;
            }

            await this._processLessonWithSmartRetry(workerId, lesson);
            
            // استراحة قصيرة جداً إذا كان الوضع طبيعياً
            if (!this.STOP_SIGNAL) await sleep(2000); 
        }
    }

    async _findNextTarget() {
        // ... (نفس منطق البحث السابق تماماً)
        const { data: candidates } = await supabase
            .from('lessons')
            .select('id, title, subjects(title)')
            .eq('has_content', true)
            .limit(20); 

        if (!candidates) return null;

        for (const lesson of candidates) {
            if (activeProcessingIds.has(lesson.id)) continue;

            // تحقق سريع من عدم وجود أسئلة
            const { count } = await supabase
                .from('question_bank')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson.id);

            if (count > 0) continue;

            const { data: struct } = await supabase
                .from('atomic_lesson_structures')
                .select('id')
                .eq('lesson_id', lesson.id)
                .single();

            if (!struct) continue;

            activeProcessingIds.add(lesson.id);
            return lesson;
        }
        return null;
    }

    /**
     * 💎 المعالجة الذكية مع التصعيد الأسي
     */
    async _processLessonWithSmartRetry(workerId, lesson) {
        const subjectTitle = lesson.subjects?.title || 'General';
        const logPrefix = `[Worker #${workerId}] 📘 ${subjectTitle} -> ${lesson.title}`;
        
        let retryLevel = 0;
        let success = false;

        // حلقة المحاولات (تستمر طالما لم ننجح ولم نصل للنهاية ولم تأتِ إشارة التوقف)
        while (!success && !this.STOP_SIGNAL) {
            try {
                // محاولة التوليد
                await this._generateCore(logPrefix, lesson);
                success = true; // 🎉 نجحنا!

            } catch (err) {
                const errorMsg = err.message || '';

                // 1. أخطاء البيانات (لا فائدة من الإعادة)
                if (errorMsg.includes('DATA_MISSING')) {
                    logger.error(`${logPrefix} | ❌ Data Error (Skipping Lesson).`);
                    break; // نخرج من اللوب ونترك الدرس
                }

                // 2. أخطاء الكوتا/الشبكة (هنا يبدأ الصبر)
                if (retryLevel < RETRY_SCHEDULE.length) {
                    const waitTime = RETRY_SCHEDULE[retryLevel];
                    const waitTimeMinutes = waitTime / 60000;
                    
                    logger.warn(`${logPrefix} | ⚠️ Failed (Attempt ${retryLevel + 1}). System sleeping for ${waitTimeMinutes} mins...`);
                    
                    // ننتظر الوقت المحدد
                    await sleep(waitTime);
                    
                    // نزيد المستوى للمرة القادمة
                    retryLevel++;
                } else {
                    // 💀 استنفدنا كل المحاولات (حتى الـ 4 ساعات)
                    logger.error(`💀 ${logPrefix} | MAX RETRIES EXHAUSTED after 4 hours. KILLING MISSION.`);
                    this.STOP_SIGNAL = true; // 🚨 إيقاف النظام بالكامل
                    break;
                }
            }
        }

        activeProcessingIds.delete(lesson.id);
    }

    // الوظيفة الأساسية للتوليد (مفصولة للنظافة)
    async _generateCore(logPrefix, lesson) {
        logger.info(`${logPrefix} | ⏳ Generating...`);

        const [contentRes, structureRes] = await Promise.all([
            supabase.from('lessons_content').select('content').eq('id', lesson.id).single(),
            supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
        ]);

        if (!contentRes.data?.content) throw new Error("DATA_MISSING");

        const atomsList = structureRes.data.structure_data.elements.map(a => ({ id: a.id, title: a.title }));
        const prompt = QUESTION_GENERATION_PROMPT(lesson.title, contentRes.data.content, atomsList);
        
        const res = await generateWithFailover('analysis', prompt, { 
            label: 'BankGen_Smart',
            timeoutMs: 180000,
            maxRetries: 1 // لا تعيد المحاولة داخلياً
        });

        const rawText = await extractTextFromResult(res);
        const questionsArray = await ensureJsonOrRepair(rawText, 'analysis');

        if (!questionsArray || !Array.isArray(questionsArray) || questionsArray.length < 5) {
            throw new Error("AI_BAD_OUTPUT");
        }

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

        logger.success(`✅ ${logPrefix} | Inserted ${validQuestions.length} Qs.`);
    }
}

module.exports = new GeniusBankWorker();
