// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getAtomicProgress } = require('../../../services/atomic/atomicManager');

/**
 * 🪐 CORTEX GRAVITY ENGINE V6.0 (Atomic & Temporal)
 * الخوارزمية:
 * 1. تستبعد المواد التي انتهى امتحانها (Dead Subjects).
 * 2. تفحص كل "ذرة" (درس) لتقرر: هل تحتاج صيانة (Review) أم بناء (New)؟
 * 3. ترتب المهام حسب الأولوية القصوى (الامتحانات القريبة + الفجوات المعرفية).
 */
async function runPlannerManager(userId, pathId, excludedLessonId = null) {
  try {
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity V6.0: Calculating atomic trajectory for User=${userId}...`);

    const now = new Date();

    // ============================================================
    // 1. جلب البيانات (المواد، الامتحانات، الدروس، التقدم)
    // ============================================================
    const [subjectsRes, examsRes, lessonsRes, progressData] = await Promise.all([
        supabase.from('subjects').select('id, title, coefficient').eq('path_id', safePathId),
        supabase.from('exams').select('subject_id, exam_date').eq('path_id', safePathId), // جلب كل الامتحانات (الماضية والقادمة)
        supabase.from('lessons').select('id, title, subject_id, order_index').order('order_index', { ascending: true }),
        getAtomicProgress(userId)
    ]);

    const subjects = subjectsRes.data || [];
    const allExams = examsRes.data || [];
    const allLessons = lessonsRes.data || [];
    const atomicMap = progressData.atomicMap || {}; 

    if (subjects.length === 0 || allLessons.length === 0) {
        return { tasks: [{ title: "لا توجد بيانات كافية للتخطيط", type: 'fix', meta: { score: 0 } }] };
    }

    // ============================================================
    // 2. فلترة المواد المنتهية (Dead Subject Elimination)
    // ============================================================
    // المادة تعتبر "ميتة" إذا كان لديها امتحان، وهذا الامتحان في الماضي
    const deadSubjectIds = new Set();
    const subjectUrgencyMap = {}; // لتخزين أيام المتبقية للامتحان

    subjects.forEach(sub => {
        // نأخذ آخر امتحان لهذه المادة (في حال وجود استدراك)
        const subExams = allExams.filter(e => e.subject_id === sub.id);
        
        if (subExams.length > 0) {
            // ترتيب الامتحانات حسب التاريخ
            subExams.sort((a, b) => new Date(b.exam_date) - new Date(a.exam_date));
            const lastExamDate = new Date(subExams[0].exam_date);
            
            // حساب الفرق بالأيام
            const diffTime = lastExamDate - now;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays < 0) {
                // الامتحان فات! المادة ماتت.
                deadSubjectIds.add(sub.id);
            } else {
                // الامتحان قادم، نسجل درجة الاستعجال
                subjectUrgencyMap[sub.id] = diffDays;
            }
        } else {
            // مادة ليس لها امتحان مجدول بعد -> تعتبر حية ولكن بأولوية عادية (999 يوم)
            subjectUrgencyMap[sub.id] = 999;
        }
    });

    logger.info(`💀 Dead Subjects excluded: ${deadSubjectIds.size}`);

    // ============================================================
    // 3. تحليل الذرات وتوليد المرشحين (Candidate Generation)
    // ============================================================
    let candidates = [];

   allLessons.forEach(lesson => {
        // 1. تجاهل المواد الميتة
        if (deadSubjectIds.has(lesson.subject_id)) return;

        // 🔥 التعديل الجديد: تجاهل الدرس المحذوف يدوياً
        if (excludedLessonId && lesson.id === excludedLessonId) {
            return; 
        }
        const atom = atomicMap[lesson.id];
        const subject = subjects.find(s => s.id === lesson.subject_id);
        const coef = subject ? (subject.coefficient || 1) : 1;
        const daysToExam = subjectUrgencyMap[lesson.subject_id] || 999;

        // حساب "الجاذبية الأساسية" للمادة (Base Gravity)
        // كلما اقترب الامتحان وزاد المعامل، زادت الجاذبية
        let gravity = (coef * 100) + (10000 / (daysToExam + 1));

        let taskType = 'study';
        let titlePrefix = "";
        let reason = "";

        // --- المنطق الذري (Atomic Logic) ---

        if (atom && atom.status === 'completed') {
            // A. حالة المراجعة (Spaced Repetition)
            // نراجع الدرس إذا كان السكور منخفضاً (نسيان) أو مر وقت طويل (يمكن تطويره لاحقاً بتاريخ المراجعة)
            if (atom.score < 80) {
                gravity += 500; // أولوية عالية لترميم المعلومات
                taskType = 'review';
                titlePrefix = "ترميم: ";
                reason = "memory_decay";
            } else {
                // درس متقن وحديثاً -> لا نفعله الآن
                return; 
            }
        } else if (atom && atom.status === 'in_progress') {
            // B. حالة الاستكمال (In Progress)
            gravity += 300; // إنهاء ما بدأته أولى من الجديد
            titlePrefix = "إتمام: ";
            reason = "finish_started";
        } else {
            // C. درس جديد (New Molecule)
            // الجاذبية تبقى كما هي (تعتمد على أهمية المادة)
            titlePrefix = "درس جديد: ";
            reason = "new_content";
        }

        // إضافة المهمة لقائمة المرشحين
        candidates.push({
            id: lesson.id,
            title: `${titlePrefix}${lesson.title}`,
            type: taskType,
            priority: gravity,
            meta: {
                relatedLessonId: lesson.id,
                relatedSubjectId: lesson.subject_id,
                relatedLessonTitle: lesson.title,
                score: Math.round(gravity),
                reason: reason,
                isExamPrep: daysToExam <= 7 // علامة للطوارئ
            }
        });
    });

    // ============================================================
    // 4. الاختيار الذكي (Smart Selection)
    // ============================================================
    
    // ترتيب المرشحين حسب الجاذبية (من الأعلى للأسفل)
    candidates.sort((a, b) => b.priority - a.priority);

    // نريد مزيجاً ذكياً: (مثلاً: 1 مراجعة ضرورية + 2 تقدم في المنهج)
    let finalTasks = [];
    
    // أ. هل هناك مراجعة طارئة؟ (سكور عالي جداً)
    const urgentReview = candidates.find(t => t.type === 'review');
    if (urgentReview) {
        finalTasks.push(urgentReview);
        // نحذفها من القائمة حتى لا نكررها
        candidates = candidates.filter(t => t.id !== urgentReview.id);
    }

    // ب. نملأ الباقي بأعلى المهام جاذبية (سواء جديد أو إتمام)
    // نأخذ مهمتين إضافيتين (ليصبح المجموع 3)
    const slotsLeft = 3 - finalTasks.length;
    finalTasks = [...finalTasks, ...candidates.slice(0, slotsLeft)];

    return { tasks: finalTasks, source: 'Gravity_V6.0_Atomic' };

  } catch (err) {
    logger.error('Gravity V6 Critical Error:', err);
    // Fallback آمن
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
