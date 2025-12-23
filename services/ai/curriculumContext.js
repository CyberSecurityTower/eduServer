
// services/ai/curriculumContext.js
'use strict';
const supabase = require('../data/supabase'); 

// نجعل الكاش null دائماً أثناء التطوير لضمان قراءة بيانات جديدة
let cachedContext = null;
let lastFetchTime = 0;

async function getCurriculumContext() {
    // 🛑 قمنا بإيقاف الكاش مؤقتاً للتجربة (يمكنك إعادته لاحقاً بتغيير الرقم إلى 3600000)
    // if (cachedContext && (Date.now() - lastFetchTime < 10000)) return cachedContext;

    console.log("🔄 Fetching Curriculum Context from DB..."); // LOG

    try {
        // 1. جلب الفصل الدراسي مع تنظيف المسافات
        const { data: settings } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'current_semester')
            .maybeSingle();
            
        const rawSemester = settings?.value || 'S1';
        const semester = rawSemester.trim(); 

        console.log(`🔎 Searching for semester: '${semester}'`); // LOG لمعرفة ماذا يبحث بالضبط

        // ===================================================================
        // 🔥 التعديل هنا: جلب المواد والدروس بشكل منفصل ثم الربط يدوياً 🔥
        // ===================================================================

        // أ. جلب المواد أولاً
        const { data: subjectsData, error: subErr } = await supabase
            .from('subjects')
            .select(`id, title, semester`) // لا تطلب الدروس هنا
            .eq('semester', semester);

        if (subErr) {
            console.error("❌ DB Error (Subjects):", subErr.message);
            return "خطأ في الاتصال بقاعدة البيانات (المواد).";
        }

        if (!subjectsData || subjectsData.length === 0) {
            console.error(`⚠️ No subjects found for semester '${semester}'. Check 'subjects' table.`);
            return "⚠️ تنبيه: لم يتم العثور على مواد. تأكد من تطابق اسم الفصل (S1) في جدول subjects.";
        }

        // ب. جلب جميع الدروس المتعلقة بهذه المواد
        const subjectIds = subjectsData.map(s => s.id);
        const { data: lessonsData, error: lessonsErr } = await supabase
            .from('lessons')
            .select(`id, title, subject_id`) // جلب subject_id لربطها
            .in('subject_id', subjectIds); // فلترة الدروس حسب المواد التي وجدناها

        if (lessonsErr) {
            console.error("❌ DB Error (Lessons):", lessonsErr.message);
            return "خطأ في الاتصال بقاعدة البيانات (الدروس).";
        }

        // ج. ربط الدروس بالمواد يدوياً
        const subjectsMap = new Map(subjectsData.map(s => [s.id, { ...s, lessons: [] }]));

        if (lessonsData) {
            lessonsData.forEach(lesson => {
                if (subjectsMap.has(lesson.subject_id)) {
                    subjectsMap.get(lesson.subject_id).lessons.push({ id: lesson.id, title: lesson.title });
                }
            });
        }
        
        const finalSubjects = Array.from(subjectsMap.values());

        // 3. بناء النص
        let map = `المنهج الدراسي الحالي (${semester}):\n`;
        finalSubjects.forEach(s => {
            const lessonCount = s.lessons?.length || 0;
            map += `- مادة ${s.title}: (${lessonCount} دروس)\n`;
            if (s.lessons && lessonCount > 0) {
                // نرتب الدروس إذا كان هناك order_index، هنا سنكتفي بالعرض
                s.lessons.forEach(l => map += `  * ${l.title}\n`);
            }
        });

        cachedContext = map;
        lastFetchTime = Date.now();
        
        console.log("✅ Curriculum Context Built!"); // LOG
        return map;

    } catch (e) {
        console.error("❌ [CURRICULUM] Critical Error:", e);
        return "خطأ غير متوقع أثناء جلب المنهج.";
    }
}

module.exports = { getCurriculumContext };
