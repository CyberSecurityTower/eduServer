
'use strict';
const supabase = require('../data/supabase'); 

let cachedContext = null;
let lastFetchTime = 0;

async function getCurriculumContext() {
    if (cachedContext && (Date.now() - lastFetchTime < 3600000)) return cachedContext;

    try {
        // 1. جلب الفصل الدراسي
        const { data: settings } = await supabase.from('system_settings').select('value').eq('key', 'current_semester').maybeSingle();
const semester = (settings?.value || 'S1').trim(); 

        // 2. جلب المواد والدروس بضربة واحدة (Join)
        // سنستخدم استعلاماً بسيطاً يضمن جلب كل شيء
        const { data: subjects, error: subErr } = await supabase
            .from('subjects')
            .select(`id, title, lessons ( title )`)
            .eq('semester', semester);

        if (subErr || !subjects || subjects.length === 0) {
            console.error("❌ [CURRICULUM] No data found for semester:", semester);
            return "⚠️ تنبيه: لم يتم العثور على مواد في قاعدة البيانات لهذا الفصل.";
        }

        // 3. بناء النص
        let map = `المنهج الدراسي الحالي (${semester}):\n`;
        subjects.forEach(s => {
            map += `- مادة ${s.title}: (${s.lessons?.length || 0} دروس)\n`;
            if (s.lessons) {
                s.lessons.forEach(l => map += `  * ${l.title}\n`);
            }
        });

        cachedContext = map;
        lastFetchTime = Date.now();
        console.log("✅ [CURRICULUM] Context Built Successfully.");
        return map;
    } catch (e) {
        console.error("❌ [CURRICULUM] Critical Error:", e);
        return "خطأ في جلب البيانات.";
    }
}

module.exports = { getCurriculumContext };
