// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, ensureJsonOrRepair, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');
const keyManager = require('./keyManager');

const activeProcessingIds = new Set();

const RETRY_SCHEDULE = [
    60 * 1000,           
    2 * 60 * 1000,       
    10 * 60 * 1000,      
    30 * 60 * 1000,      
    60 * 60 * 1000,      
    2 * 60 * 60 * 1000,  
    4 * 60 * 60 * 1000   
];

class GeniusBankWorker {
    
    constructor() {
        this.STOP_SIGNAL = false;
        this.isWorking = false;
        this.failedSessionIds = new Set(); 
    }

    stop() {
        if (this.isWorking) {
            logger.warn('🛑 STOP SIGNAL RECEIVED. Aborting operations...');
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

        logger.info('🚀 Genius Bank Mission Started (Full Key Exhaustion Mode).');
        
        // 1. تفعيل وضع الصيانة (يمنع المستخدمين فقط)
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;
        this.failedSessionIds.clear();

        try {
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
            const lesson = await this._findNextTarget(workerId);

            if (!lesson) {
                logger.info(`💤 Worker #${workerId}: No eligible lessons found (Queue empty).`);
                break;
            }

            await this._processLessonWithSmartRetry(workerId, lesson);
            
            if (!this.STOP_SIGNAL) await sleep(2000); 
        }
    }

    async _findNextTarget(workerId) {
        const { data: candidates, error } = await supabase
            .from('lessons')
            .select('id, title, subject_id')
            .limit(100); 

        if (error) {
            logger.error(`❌ Worker #${workerId} DB Error:`, error.message);
            return null;
        }

        if (!candidates) return null;

        for (const lesson of candidates) {
            if (activeProcessingIds.has(lesson.id)) continue;
            if (this.failedSessionIds.has(lesson.id)) continue;

            activeProcessingIds.add(lesson.id);

            try {
                const { count } = await supabase
                    .from('question_bank')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lesson.id);

                if (count > 0) {
                    activeProcessingIds.delete(lesson.id);
                    continue;
                }

                const { data: struct } = await supabase
                    .from('atomic_lesson_structures')
                    .select('id')
                    .eq('lesson_id', lesson.id)
                    .single();

                if (!struct) {
                    this.failedSessionIds.add(lesson.id);
                    activeProcessingIds.delete(lesson.id);
                    continue;
                }

                return lesson;

            } catch (e) {
                activeProcessingIds.delete(lesson.id);
            }
        }
        return null;
    }

    async _processLessonWithSmartRetry(workerId, lesson) {
        const subjectLog = lesson.subject_id || 'Unknown';
        const logPrefix = `[Worker #${workerId}] 📘 ${subjectLog} -> ${lesson.title}`;
        
        let retryLevel = 0;
        let success = false;

        while (!success && !this.STOP_SIGNAL) {
            try {
                // 🛑 تم حذف شرط systemHealth.isLocked() من هنا
                // السبب: نحن من وضع النظام في Maintenance Mode، فلا يجب أن نمنع أنفسنا من العمل!
                // العامل الإداري لديه "تصريح مرور VIP".

                await this._generateCore(logPrefix, lesson);
                success = true; 

            } catch (err) {
                const errorMsg = err.message || '';

                if (errorMsg.includes('DATA_MISSING')) {
                    logger.error(`${logPrefix} | ❌ Data Missing. Ignoring.`);
                    this.failedSessionIds.add(lesson.id);
                    break; 
                }

                // هنا يبدأ الاستنزاف
                // بما أننا وصلنا هنا، فهذا يعني أن _generateCore قد جربت كل المفاتيح وفشلت كلها
                if (retryLevel < RETRY_SCHEDULE.length) {
                    const waitTime = RETRY_SCHEDULE[retryLevel];
                    const waitTimeMinutes = waitTime / 60000;
                    
                    logger.error(`${logPrefix} | 💀 ALL KEYS EXHAUSTED (Round ${retryLevel+1}). Sleeping for ${waitTimeMinutes} mins...`);
                    
                    await sleep(waitTime);
                    retryLevel++;
                } else {
                    logger.error(`💀 ${logPrefix} | TOTAL SYSTEM FAILURE after 4 hours. STOPPING MISSION.`);
                    this.STOP_SIGNAL = true; 
                    break;
                }
            }
        }

        activeProcessingIds.delete(lesson.id);
    }

    async _generateCore(logPrefix, lesson) {
        logger.info(`${logPrefix} | ⏳ Generating (Trying ALL available keys)...`);

        const [contentRes, structureRes] = await Promise.all([
            supabase.from('lessons_content').select('content').eq('id', lesson.id).single(),
            supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
        ]);

        if (!contentRes.data?.content || contentRes.data.content.length < 50) {
            throw new Error("DATA_MISSING");
        }

        const atomsList = structureRes.data.structure_data.elements.map(a => ({ id: a.id, title: a.title }));
        const prompt = QUESTION_GENERATION_PROMPT(lesson.title, contentRes.data.content, atomsList);
        
        // حساب عدد المفاتيح
        const totalKeys = keyManager.getKeyCount(); 
        const attempts = totalKeys > 0 ? totalKeys + 2 : 5; // عدد المحاولات = عدد المفاتيح + هامش أمان

        const res = await generateWithFailover('analysis', prompt, { 
            label: `BankGen_${lesson.id}`,
            timeoutMs: 180000,
            maxRetries: attempts // 👈 هنا الأمر بتجربة الجميع
        });

        const rawText = await extractTextFromResult(res);
        const questionsArray = await ensureJsonOrRepair(rawText, 'analysis');

        if (!questionsArray || !Array.isArray(questionsArray) || questionsArray.length < 5) {
            throw new Error("AI_BAD_OUTPUT");
        }

        const validQuestions = questionsArray.map(q => ({
            lesson_id: lesson.id,
            atom_id: q.atom_id,
            widget_type: q.widget_type ? q.widget_type.toUpperCase() : 'MCQ',
            difficulty: q.difficulty || 'Medium',
            content: q.content,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase.from('question_bank').insert(validQuestions);
        if (error) throw error;

        logger.success(`✅ ${logPrefix} | Saved ${validQuestions.length} Questions.`);
    }
}

module.exports = new GeniusBankWorker();
