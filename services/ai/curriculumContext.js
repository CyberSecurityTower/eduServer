
// src/services/ai/curriculumContext.js
'use strict';

// تأكد أن المسار صحيح بالنسبة لمكان الملف
const supabase = require('../../services/data/supabase'); 

let cachedContext = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 60; 

async function getCurriculumContext() {
    const now = Date.now();
    if (cachedContext && (now - lastFetchTime < CACHE_DURATION)) {
        return cachedContext;
    }

    console.log('🔄 [Context] Fetching Curriculum Data...');

    try {
        // 1. جلب الفصل الحالي
        let currentSemester = 'S1'; // الافتراضي
        const { data: setting, error: setErr } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'current_semester')
            .maybeSingle(); // نستخدم maybeSingle لتجنب الخطأ لو لم يوجد

        if (setting?.value) currentSemester = setting.value;
        console.log(`ℹ️ [Context] Current Semester: ${currentSemester}`);

        // 2. جلب المواد
        const { data: subjects, error: subError } = await supabase
            .from('subjects')
            .select('id, title')
            .eq('semester', currentSemester);

        if (subError) {
            console.error('❌ [Context] Error fetching subjects:', subError.message);
            return "";
        }

        if (!subjects || subjects.length === 0) {
            console.warn(`⚠️ [Context] No subjects found for semester ${currentSemester}`);
            return "No subjects found in database.";
        }
        console.log(`✅ [Context] Found ${subjects.length} subjects.`);

        const subjectIds = subjects.map(s => s.id);

        // 3. جلب الدروس
        const { data: lessons, error: lesError } = await supabase
            .from('lessons')
            .select('title, subject_id')
            .in('subject_id', subjectIds)
            .order('order_index', { ascending: true });

        if (lesError) {
            console.error('❌ [Context] Error fetching lessons:', lesError.message);
            return "";
        }
        console.log(`✅ [Context] Found ${lessons.length} total lessons.`);

        // 4. البناء
        let contextString = `--- 🎓 CURRICULUM STRUCTURE (Semester: ${currentSemester}) ---\n`;
        contextString += `📊 Stats: ${subjects.length} Subjects, ${lessons.length} Total Lessons.\n`;
        
        subjects.forEach(sub => {
            const subLessons = lessons.filter(l => l.subject_id === sub.id);
            contextString += `📌 Subject: ${sub.title} (${subLessons.length} lessons):\n`;
            if (subLessons.length > 0) {
                // نأخذ العناوين فقط
                contextString += `   - ${subLessons.map(l => l.title).join('\n   - ')}\n`;
            } else {
                contextString += `   - (No lessons uploaded yet)\n`;
            }
            contextString += `\n`;
        });
        contextString += `--- END OF STRUCTURE ---\n`;

        cachedContext = contextString;
        lastFetchTime = now;
        
        return contextString;

    } catch (error) {
        console.error('❌ [Context] CRITICAL ERROR:', error);
        return "";
    }
}

function clearCurriculumCache() {
    console.log('🧹 [Context] Cache cleared.');
    cachedContext = null;
    lastFetchTime = 0;
}

module.exports = { getCurriculumContext, clearCurriculumCache };
