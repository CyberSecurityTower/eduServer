// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, ensureJsonOrRepair, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');
const keyManager = require('./keyManager'); // 👈 استيراد مدير المفاتيح

// 🛡️ لمنع تضارب العاملين
const activeProcessingIds = new Set();

// ⏳ جدول الصبر (Exponential Backoff)
// يتم تفعيله فقط بعد فشل جميع المفاتيح المتاحة
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
        // نوسع البحث لضمان عدم توقف العمل
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
            // القفل المتفائل
            if (activeProcessingIds.has(lesson.id)) continue;
            if (this.failedSessionIds.has(lesson.id)) continue;

            activeProcessingIds.add(lesson.id);

            try {
                // فحص الأسئلة
                const { count } = await supabase
                    .from('question_bank')
                    .select('*', { count: 'exact', head: true })
                    .eq('lesson_id', lesson.id);

                if (count > 0) {
                    activeProcessingIds.delete(lesson.id);
                    continue;
                }

                // فحص الهيكلية
                const { data: struct } = await supabase
                    .from('atomic_lesson_structures')
                    .select('id')
                    .eq('lesson_id', lesson.id)
                    .single();

                if (!struct) {
                    // logger.warn(`⚠️ Skipping "${lesson.title}": No Atomic Structure.`);
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
                // إذا كان النظام مغلقاً من البداية (Lockdown)، ننتظر
                if (systemHealth.isLocked() && retryLevel === 0) {
                    logger.warn(`${logPrefix} | System Locked. Waiting 1m...`);
                    await sleep(60000);
                    continue;
                }

                await this._generateCore(logPrefix, lesson);
                success = true; 

            } catch (err) {
                const errorMsg = err.message || '';

                if (errorMsg.includes('DATA_MISSING')) {
                    logger.error(`${logPrefix} | ❌ Data Missing. Ignoring.`);
                    this.failedSessionIds.add(lesson.id);
                    break; 
                }

                // إذا وصلنا هنا، فهذا يعني أننا جربنا *كل* المفاتيح وفشلت جميعها
                if (retryLevel < RETRY_SCHEDULE.length) {
                    const waitTime = RETRY_SCHEDULE[retryLevel];
                    const waitTimeMinutes = waitTime / 60000;
                    
                    logger.error(`${logPrefix} | 💀 ALL KEYS FAILED. Sleeping for ${waitTimeMinutes} mins before trying the whole pool again...`);
                    
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
        logger.info(`${logPrefix} | ⏳ Generating...`);

        const [contentRes, structureRes] = await Promise.all([
            supabase.from('lessons_content').select('content').eq('id', lesson.id).single(),
            supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
        ]);

        if (!contentRes.data?.content || contentRes.data.content.length < 50) {
            throw new Error("DATA_MISSING");
        }

        const atomsList = structureRes.data.structure_data.elements.map(a => ({ id: a.id, title: a.title }));
        const prompt = QUESTION_GENERATION_PROMPT(lesson.title, contentRes.data.content, atomsList);
        
        // 🔥 التعديل الجوهري هنا: استراتيجية الاستنزاف الكامل 🔥
        // نجلب عدد المفاتيح الكلي من مدير المفاتيح
        const totalKeys = keyManager.getKeyCount(); 
        // نجعل عدد المحاولات يساوي عدد المفاتيح + 2 (لضمان تغطية الجميع)
        // إذا كان عدد المفاتيح 0 (مشكلة في التحميل)، نجعلها 5 محاولات افتراضية
        const attempts = totalKeys > 0 ? totalKeys + 2 : 5;

        // logger.info(`${logPrefix} | Attempting with pool of ${totalKeys} keys...`);

        const res = await generateWithFailover('analysis', prompt, { 
            label: `BankGen_${lesson.id}`,
            timeoutMs: 180000,
            maxRetries: attempts // 👈 هنا يكمن السر: جربهم كلهم!
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
