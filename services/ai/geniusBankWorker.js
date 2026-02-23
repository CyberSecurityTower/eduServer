
// services/ai/geniusBankWorker.js
'use strict';

const supabase = require('../data/supabase');
const generateWithFailover = require('./failover');
const { extractTextFromResult, sleep } = require('../../utils');
const { QUESTION_GENERATION_PROMPT } = require('../../config/bank-prompts');
const logger = require('../../utils/logger');
const systemHealth = require('../monitoring/systemHealth');
const keyManager = require('./keyManager');

const activeProcessingIds = new Set();

class GeniusBankWorker {
    
    constructor() {
        this.STOP_SIGNAL = false;
        this.isWorking = false;
        this.failedSessionIds = new Set(); 
        this.targetSubjectId = null; // 🔥 تخزين المادة المستهدفة
    }

    stop() {
        if (this.isWorking) {
            logger.warn('🛑 STOP SIGNAL RECEIVED. Aborting operations...');
            this.STOP_SIGNAL = true;
            return true;
        }
        return false;
    }

    // 🔥 الجديد: استقبال subjectId
    async startMission(subjectId = null) {
        if (this.isWorking) {
            logger.warn('⚠️ Mission already running.');
            return;
        }

        this.targetSubjectId = subjectId; // حفظه لاستخدامه في البحث
        const targetLog = subjectId ? `Targeting Subject: ${subjectId}` : 'Targeting ALL';
        
        logger.info(`🚀 Genius Bank Mission Started (Turbo Mode). ${targetLog}`);
        
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;
        this.failedSessionIds.clear();

        try {
            const worker1 = this._workerLoop(1);
            const worker2 = this._workerLoop(2);

            await Promise.all([worker1, worker2]);

            logger.success(this.STOP_SIGNAL ? '🚫 Mission Stopped by User.' : '🏁 Mission Accomplished.');

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

            await this._processLesson(workerId, lesson);
            
            if (!this.STOP_SIGNAL) await sleep(1000); 
        }
    }

    /**
     * 🧠 البحث الصارم والمحدد
     */
    async _findNextTarget(workerId) {
        // 1. جلب الدروس (إما للمادة المحددة، أو للكل)
        let query = supabase.from('lessons').select('id, title, subject_id');
        if (this.targetSubjectId) {
            query = query.eq('subject_id', this.targetSubjectId);
        }

        const { data: lessons, error } = await query;

        if (error || !lessons) {
            logger.error(`[Worker #${workerId}] Failed to fetch lessons.`);
            return null;
        }

        // 2. فحص الدروس واحداً تلو الآخر بدقة
        for (const lesson of lessons) {
            if (activeProcessingIds.has(lesson.id) || this.failedSessionIds.has(lesson.id)) continue;

            // أ. هل يمتلك الدرس هيكلاً ذرياً؟
            const { data: atomic } = await supabase
                .from('atomic_lesson_structures')
                .select('id')
                .eq('lesson_id', lesson.id)
                .maybeSingle();

            if (!atomic) continue; // لا يمتلك هيكل ذري، تجاوزه

            // ب. هل يمتلك أسئلة مسبقاً؟ (بحث صارم في الداتابيز مباشرة)
            const { count } = await supabase
                .from('question_bank')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lesson.id);

            if (count > 0) continue; // يمتلك أسئلة، تجاوزه

            // ج. نجح في كل الاختبارات! هذا هو هدفنا.
            activeProcessingIds.add(lesson.id);
            return lesson;
        }

        return null; // لا يوجد المزيد
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
                this.failedSessionIds.add(lesson.id);
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
            this.failedSessionIds.add(lesson.id);
        } finally {
            activeProcessingIds.delete(lesson.id);
        }
    }
}

module.exports = new GeniusBankWorker();
