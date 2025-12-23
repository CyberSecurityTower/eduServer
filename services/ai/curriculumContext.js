
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
            
        // تنظيف القيمة من أي مسافات زائدة قد تكون دخلت خطأ في الداتابيز
        const rawSemester = settings?.value || 'S1';
        const semester = rawSemester.trim(); 

        console.log(`🔎 Searching for semester: '${semester}'`); // LOG لمعرفة ماذا يبحث بالضبط

        // 2. جلب المواد والدروس
        const { data: subjects, error: subErr } = await supabase
            .from('subjects')
            .select(`
                id, 
                title, 
                semester,
                lessons ( id, title )
            `)
            .eq('semester', semester); // تأكد أن العمود semester في subjects يطابق S1 تماماً

        if (subErr) {
            console.error("❌ DB Error:", subErr.message);
            return "خطأ في الاتصال بقاعدة البيانات.";
        }

        if (!subjects || subjects.length === 0) {
            console.error(`⚠️ No subjects found for semester '${semester}'. Check 'subjects' table.`);
            return "⚠️ تنبيه: لم يتم العثور على مواد. تأكد من تطابق اسم الفصل (S1) في جدول subjects.";
        }

        // 3. بناء النص
        let map = `المنهج الدراسي الحالي (${semester}):\n`;
        subjects.forEach(s => {
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
