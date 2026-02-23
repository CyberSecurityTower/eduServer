
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

        logger.info('🚀 Genius Bank Mission Started (Turbo Mode - 12 Qs Batch).');
        
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;
        this.failedSessionIds.clear();

        try {
            const worker1 = this._workerLoop(1);
            const worker2 = this._workerLoop(2);

            await Promise.all([worker1, worker2]);

            logger.success(this.STOP_SIGNAL ? '🚫 Mission Stopped by User.' : '🏁 Mission Accomplished: All lessons processed.');

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
     * 🧠 البحث الذكي: جلب كل الدروس ثم فلترتها في الذاكرة لتجنب فخ الـ Limit
     */
    async _findNextTarget(workerId) {
        // 1. جلب كل الدروس التي تمتلك هيكل ذري
        const { data: allStructures, error: structError } = await supabase
            .from('atomic_lesson_structures')
            .select('lesson_id');

        if (structError || !allStructures) {
            logger.error(`[Worker #${workerId}] DB Error: ${structError?.message}`);
            return null;
        }

        // 2. جلب كل الدروس التي تمتلك أسئلة مسبقاً
        // نقوم بجلب lesson_id فقط لتقليل استهلاك الذاكرة
        const { data: existingBanks } = await supabase
            .from('question_bank')
            .select('lesson_id');

        // وضعها في Set لتكون سرعة البحث فيها O(1)
        const lessonsWithQuestions = new Set(existingBanks?.map(q => q.lesson_id) || []);

        // 3. البحث عن أول درس ليس له أسئلة
        for (const item of allStructures) {
            const lessonId = item.lesson_id;

            // تجاوز الدرس إذا كان: قيد المعالجة، فشل سابقاً، أو يمتلك أسئلة بالفعل
            if (activeProcessingIds.has(lessonId) || 
                this.failedSessionIds.has(lessonId) || 
                lessonsWithQuestions.has(lessonId)) {
                continue;
            }

            // وجدنا درساً يحتاج للتوليد!
            activeProcessingIds.add(lessonId);

            // جلب عنوان الدرس للمساعدة في السياق
            const { data: lessonData } = await supabase
                .from('lessons')
                .select('title')
                .eq('id', lessonId)
                .single();

            return {
                id: lessonId,
                title: lessonData?.title || lessonId
            };
        }

        return null; // انتهت كل الدروس
    }

    async _processLesson(workerId, lesson) {
        const logPrefix = `[Worker #${workerId}] 📘 ${lesson.title} (${lesson.id})`;
        logger.info(`${logPrefix} | ⏳ Fetching Data & Generating 12 Questions...`);

        try {
            // 1. جلب المحتوى من lessons_content وهيكلة الجيسون من atomic_lesson_structures
            // ملاحظة: تأكدنا من البحث باستخدام lesson.id
            const [contentRes, structureRes] = await Promise.all([
                supabase.from('lessons_content').select('content').eq('lesson_id', lesson.id).maybeSingle(),
                supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).maybeSingle()
            ]);

            // دعم للحالة التي قد يكون فيها عمود الربط اسمه id بدلاً من lesson_id في جدول المحتوى
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

            // 2. تجهيز البرومبت وتمرير كل البيانات التي طلبها المستخدم
            const prompt = QUESTION_GENERATION_PROMPT(lesson.title, lesson.id, lessonContent, atomicJson.elements);
            
            // 3. استدعاء الذكاء الاصطناعي مع التدوير الذكي للمفاتيح (Failover)
            const totalKeys = keyManager.getKeyCount();
            const res = await generateWithFailover('analysis', prompt, { 
                label: `BankGen_${lesson.id}`,
                timeoutMs: 180000, 
                maxRetries: totalKeys > 0 ? totalKeys : 3 // يجرب كل المفاتيح قبل الاستسلام
            });

            const rawText = await extractTextFromResult(res);

            // 4. استخراج JSON من داخل كود الـ SQL (بين علامتي $$)
            const jsonMatch = rawText.match(/\$\$\s*(\[\s*\{[\s\S]*\}\s*\])\s*\$\$/);
            
            let questionsArray = [];
            
            if (jsonMatch && jsonMatch[1]) {
                try {
                    questionsArray = JSON.parse(jsonMatch[1]);
                } catch (e) {
                    logger.error(`${logPrefix} | JSON Parse Error from SQL extraction.`);
                }
            } else {
                // محاولة احتياطية
                const fallbackMatch = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (fallbackMatch) {
                     try { questionsArray = JSON.parse(fallbackMatch[0]); } catch(e){}
                }
            }

            if (!questionsArray || questionsArray.length === 0) {
                throw new Error("AI output parsing failed (No valid JSON found in SQL output)");
            }

            // 5. الإدراج في قاعدة البيانات
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
