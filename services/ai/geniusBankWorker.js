
// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');
const keyManager = require('./keyManager');

class GeniusBankWorker {
    
    constructor() {
        this.STOP_SIGNAL = false;
        this.isWorking = false;
        this.taskQueue = []; // 🔥 الطابور المركزي للدروس
    }

    stop() {
        if (this.isWorking) {
            logger.warn('🛑 STOP SIGNAL RECEIVED. Aborting operations...');
            this.STOP_SIGNAL = true;
            return true;
        }
        return false;
    }

    async startMission(subjectId = null) {
        if (this.isWorking) {
            logger.warn('⚠️ Mission already running.');
            return;
        }

        const targetLog = subjectId ? `Targeting Subject: ${subjectId}` : 'Targeting ALL';
        logger.info(`🚀 Genius Bank Mission Started (Turbo Mode). ${targetLog}`);
        
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;
        this.taskQueue = [];

        try {
            // 1. 🧠 بناء الطابور مرة واحدة قبل انطلاق العمال
            await this._buildTaskQueue(subjectId);

            if (this.taskQueue.length === 0) {
                logger.info('✅ No lessons need processing. Everything is up to date!');
                return;
            }

            // 2. إطلاق العمال
            const worker1 = this._workerLoop(1);
            const worker2 = this._workerLoop(2);

            await Promise.all([worker1, worker2]);

            logger.success(this.STOP_SIGNAL ? '🚫 Mission Stopped by User.' : '🏁 Mission Accomplished.');

        } catch (err) {
            logger.error('💥 Critical Mission Failure:', err);
        } finally {
            systemHealth.setMaintenanceMode(false);
            this.isWorking = false;
        }
    }

   
    /**
     * 🔥 خوارزمية بناء الطابور الذكية (Queue Builder)
     */
    async _buildTaskQueue(subjectId) {
        logger.info('🔍 Scanning database to build Task Queue...');

        // 1. جلب الدروس المطلوبة
        let query = supabase.from('lessons').select('id, title, subject_id');
        if (subjectId) query = query.eq('subject_id', subjectId);
        const { data: lessons, error: lessonError } = await query;

        if (lessonError || !lessons) {
            logger.error('Failed to fetch lessons for Queue.');
            return;
        }

        // 2. جلب الدروس التي تمتلك هيكلاً ذرياً (الشرط الأساسي)
        const { data: structures } = await supabase.from('atomic_lesson_structures').select('lesson_id');
        const lessonsWithAtoms = new Set(structures?.map(s => String(s.lesson_id).trim()) || []);

        // 3. 🌟 الحل السحري: حساب عدد الأسئلة الحالية (بتخطي حد الـ 1000 سطر)
        let allQuestions = [];
        let from = 0;
        const step = 1000;
        while (true) {
            const { data } = await supabase.from('question_bank').select('lesson_id').range(from, from + step - 1);
            if (!data || data.length === 0) break;
            allQuestions.push(...data);
            if (data.length < step) break;
            from += step;
        }

        const questionCounts = {};
        allQuestions.forEach(q => {
            const lId = String(q.lesson_id).trim();
            questionCounts[lId] = (questionCounts[lId] || 0) + 1;
        });

        // 4. تصنيف الدروس
        const primaryQueue = [];   // دروس لا تمتلك أي سؤال (أولوية قصوى)
        const secondaryQueue = []; // دروس تمتلك أسئلة بالفعل (لزيادة الإثراء)

        for (const lesson of lessons) {
            const lId = String(lesson.id).trim();
            if (lessonsWithAtoms.has(lId)) {
                if (!questionCounts[lId] || questionCounts[lId] === 0) {
                    primaryQueue.push(lesson); // أولوية 1
                } else {
                    secondaryQueue.push(lesson); // أولوية 2
                }
            }
        }

        // 5. اتخاذ القرار (Decision Logic)
        if (primaryQueue.length > 0) {
            this.taskQueue = primaryQueue;
            logger.info(`🎯 Priority 1: Found ${this.taskQueue.length} lessons with ZERO questions. Target locked.`);
        } else if (secondaryQueue.length > 0) {
            // إذا كانت كل الدروس ممتلئة بالأسئلة، نختار دروس عشوائية لزيادة الأسئلة (Enrichment Mode)
            const shuffled = secondaryQueue.sort(() => 0.5 - Math.random());
            this.taskQueue = shuffled.slice(0, 3); // نختار 3 دروس عشوائية لتوليد المزيد لها
            logger.info(`✨ Priority 2 (Enrichment): All lessons have questions. Selected ${this.taskQueue.length} random lessons to generate MORE questions.`);
        } else {
            logger.info('✅ No suitable lessons found (Maybe missing atomic structures?).');
        }
    }

    async _workerLoop(workerId) {
        logger.info(`👷 Worker #${workerId} online.`);

        while (!this.STOP_SIGNAL) {
            // 🔥 السحب من الطابور (عملية متزامنة وآمنة 100% من التداخل)
            const lesson = this.taskQueue.shift();

            if (!lesson) {
                logger.info(`💤 Worker #${workerId}: Queue empty. Going to sleep.`);
                break; 
            }

            await this._processLesson(workerId, lesson);
            
            if (!this.STOP_SIGNAL) await sleep(1000); 
        }
    }

    async _processLesson(workerId, lesson) {
        const logPrefix = `[Worker #${workerId}] 📘 [${lesson.subject_id}] ${lesson.title} (${lesson.id})`;
        logger.info(`${logPrefix} | ⏳ Fetching Data & Generating 12 Questions...`);

        try {
            const [contentRes, structureRes] = await Promise.all([
                supabase.from('lessons_content').select('content').eq('lesson_id', lesson.id).maybeSingle(),
                supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).maybeSingle()
            ]);

            let lessonContent = contentRes.data?.content;
            if (!lessonContent) {
                 const fallbackContent = await supabase.from('lessons_content').select('content').eq('id', lesson.id).maybeSingle();
                 lessonContent = fallbackContent.data?.content;
            }

            const atomicJson = structureRes.data?.structure_data;

            if (!lessonContent || !atomicJson || !atomicJson.elements) {
                logger.warn(`${logPrefix} | ❌ Missing Content or Atomic Structure. Skipping.`);
                return;
            }

            const prompt = QUESTION_GENERATION_PROMPT(lesson.title, lesson.id, lessonContent, atomicJson.elements);
            
            const totalKeys = keyManager.getKeyCount();
            const res = await generateWithFailover('analysis', prompt, { 
                label: `BankGen_${lesson.id}`,
                timeoutMs: 180000, 
                maxRetries: totalKeys > 0 ? totalKeys : 3 
            });

            const rawText = await extractTextFromResult(res);

            const jsonMatch = rawText.match(/\$\$\s*(\[\s*\{[\s\S]*\}\s*\])\s*\$\$/);
            let questionsArray = [];
            
            if (jsonMatch && jsonMatch[1]) {
                try { questionsArray = JSON.parse(jsonMatch[1]); } catch (e) {}
            } else {
                const fallbackMatch = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (fallbackMatch) {
                     try { questionsArray = JSON.parse(fallbackMatch[0]); } catch(e){}
                }
            }

            if (!questionsArray || questionsArray.length === 0) {
                throw new Error("AI output parsing failed (No valid JSON found)");
            }

            const validQuestions = questionsArray.map(q => ({
                lesson_id: lesson.id,
                atom_id: q.atom_id,
                widget_type: q.widget_type ? q.widget_type.toUpperCase() : 'MCQ',
                difficulty: q.difficulty || 2,
                points: q.points || 15,
                is_verified: true,
                content: q.content,
                created_at: new Date().toISOString()
            }));

            const { error } = await supabase.from('question_bank').insert(validQuestions);
            if (error) throw error;

            logger.success(`✅ ${logPrefix} | Successfully added ${validQuestions.length} Questions.`);

        } catch (err) {
            logger.error(`${logPrefix} | ❌ Error: ${err.message}`);
        } 
    }
}

module.exports = new GeniusBankWorker();
