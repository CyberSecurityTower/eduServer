
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
        
        // تفعيل وضع الصيانة لحماية النظام من ضغط المستخدمين أثناء العملية الثقيلة
        systemHealth.setMaintenanceMode(true);
        this.STOP_SIGNAL = false;
        this.isWorking = true;
        this.failedSessionIds.clear();

        try {
            // تشغيل عاملين (Workers) بالتوازي لزيادة السرعة
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
            // 1. البحث عن درس يحتاج أسئلة
            const lesson = await this._findNextTarget(workerId);

            if (!lesson) {
                logger.info(`💤 Worker #${workerId}: No eligible lessons found (Queue empty).`);
                break; // نخرج من الحلقة إذا لم يعد هناك دروس
            }

            // 2. معالجة الدرس
            await this._processLesson(workerId, lesson);
            
            // استراحة قصيرة جداً لتجنب تداخل الكتابة في قاعدة البيانات
            if (!this.STOP_SIGNAL) await sleep(500); 
        }
    }

    /**
     * البحث عن الدروس التي لديها هيكل ذري ولكن ليس لديها أسئلة
     */
    async _findNextTarget(workerId) {
        // نحتاج لدروس لديها هيكل ذري
        // ولتحسين الأداء، نجلب 50 درس عشوائي ونفلترهم
        const { data: candidates, error } = await supabase
            .from('atomic_lesson_structures')
            .select('lesson_id, lessons(title, subject_id)')
            .limit(50); 

        if (error || !candidates) return null;

        for (const item of candidates) {
            const lessonId = item.lesson_id;
            
            // تجاوز الدروس التي تتم معالجتها حالياً أو الفاشلة
            if (activeProcessingIds.has(lessonId) || this.failedSessionIds.has(lessonId)) continue;

            // التحقق: هل يوجد أسئلة لهذا الدرس؟
            const { count } = await supabase
                .from('question_bank')
                .select('*', { count: 'exact', head: true })
                .eq('lesson_id', lessonId);

            // إذا كان العدد 0، فهذا صيد ثمين!
            if (count === 0) {
                activeProcessingIds.add(lessonId);
                return {
                    id: lessonId,
                    title: item.lessons?.title || 'Unknown Lesson',
                    subject_id: item.lessons?.subject_id
                };
            }
        }
        return null;
    }

    async _processLesson(workerId, lesson) {
        const logPrefix = `[Worker #${workerId}] 📘 ${lesson.title}`;
        logger.info(`${logPrefix} | ⏳ Generating 12 Questions...`);

        try {
            // 1. جلب المحتوى والهيكل الذري
            const [contentRes, structureRes] = await Promise.all([
                supabase.from('lessons_content').select('content').eq('lesson_id', lesson.id).single(),
                supabase.from('atomic_lesson_structures').select('structure_data').eq('lesson_id', lesson.id).single()
            ]);

            if (!contentRes.data?.content || !structureRes.data?.structure_data?.elements) {
                logger.warn(`${logPrefix} | ❌ Missing Content or Atoms. Skipping.`);
                this.failedSessionIds.add(lesson.id);
                return;
            }

            const atomsList = structureRes.data.structure_data.elements.map(a => ({ id: a.id, title: a.title }));
            
            // 2. إعداد البرومبت الجديد
            const prompt = QUESTION_GENERATION_PROMPT(lesson.title, lesson.id, contentRes.data.content, atomsList);
            
            // 3. استدعاء الذكاء الاصطناعي مع Failover
            // نستخدم عدد محاولات يساوي عدد المفاتيح المتاحة لضمان عدم التوقف
            const totalKeys = keyManager.getKeyCount();
            const res = await generateWithFailover('analysis', prompt, { 
                label: `BankGen_${lesson.id}`,
                timeoutMs: 180000, // 3 دقائق (توليد 12 سؤال قد يأخذ وقتاً)
                maxRetries: totalKeys > 0 ? totalKeys : 3
            });

            const rawText = await extractTextFromResult(res);

            // 4. 🔥 الذكاء هنا: استخراج JSON من داخل SQL 🔥
            // الموديل سيرجع: INSERT INTO ... $$ [ {json} ] $$;
            // نحن نريد ما بداخل $$ ... $$
            const jsonMatch = rawText.match(/\$\$\s*(\[\s*\{[\s\S]*\}\s*\])\s*\$\$/);
            
            let questionsArray = [];
            
            if (jsonMatch && jsonMatch[1]) {
                try {
                    questionsArray = JSON.parse(jsonMatch[1]);
                } catch (e) {
                    logger.error(`${logPrefix} | JSON Parse Error from SQL extraction.`);
                }
            } else {
                // محاولة احتياطية: البحث عن JSON Array عادي
                const fallbackMatch = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (fallbackMatch) {
                     try { questionsArray = JSON.parse(fallbackMatch[0]); } catch(e){}
                }
            }

            if (!questionsArray || questionsArray.length === 0) {
                throw new Error("AI output parsing failed (No valid JSON found in SQL)");
            }

            // 5. التنظيف والإدراج
            // نستخدم Supabase Client للإدراج بدلاً من تنفيذ SQL الخام لضمان الأمان
            const validQuestions = questionsArray.map(q => ({
                lesson_id: lesson.id,
                atom_id: q.atom_id,
                widget_type: q.widget_type ? q.widget_type.toUpperCase() : 'MCQ',
                difficulty: q.difficulty || 2,
                points: q.points || 15,
                is_verified: true,
                content: q.content, // Supabase سيحول هذا تلقائياً إلى JSONB
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
