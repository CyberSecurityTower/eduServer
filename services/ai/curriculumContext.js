
// services/ai/curriculumContext.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../../utils/logger'); // تأكد من المسار الصحيح للوجر

// سنستخدم متغيرات لتخزين البيانات مؤقتاً (Caching)
let cachedContext = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 60; // تحديث البيانات كل ساعة واحدة

async function getCurriculumContext() {
    const now = Date.now();

    // 1. إذا كانت البيانات موجودة وحديثة، أعدها فوراً (السرعة القصوى)
    if (cachedContext && (now - lastFetchTime < CACHE_DURATION)) {
        return cachedContext;
    }

    console.log('🔄 Refreshing AI Curriculum Context...');

    try {
        // 2. معرفة الفصل الدراسي الحالي
        const { data: setting } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'current_semester')
            .single();

        const currentSemester = setting?.value || 'S1'; // الافتراضي S1

        // 3. جلب المواد الخاصة بهذا الفصل فقط
        const { data: subjects, error: subError } = await supabase
            .from('subjects')
            .select('id, title')
            .eq('semester', currentSemester);

        if (subError) throw subError;

        if (!subjects || subjects.length === 0) {
            return "لا توجد مواد مسجلة لهذا الفصل.";
        }

        const subjectIds = subjects.map(s => s.id);

        // 4. جلب عناوين الدروس المرتبطة بهذه المواد
        const { data: lessons, error: lesError } = await supabase
            .from('lessons')
            .select('title, subject_id')
            .in('subject_id', subjectIds)
            .order('order_index', { ascending: true }); // ترتيب الدروس مهم

        if (lesError) throw lesError;

        // 5. بناء الهيكل النصي (الخريطة الذهنية)
        let contextString = `--- 🎓 CURRICULUM STRUCTURE (Semester: ${currentSemester}) ---\n`;
        contextString += `📊 Stats: ${subjects.length} Subjects, ${lessons.length} Total Lessons.\n`;
        contextString += `⚠️ INSTRUCTION: Use this list ONLY to list subjects/lessons. Do NOT hallucinate lesson titles.\n\n`;

        subjects.forEach(sub => {
            // تصفية الدروس الخاصة بهذه المادة
            const subLessons = lessons
                .filter(l => l.subject_id === sub.id)
                .map(l => l.title);

            contextString += `📌 Subject: ${sub.title} (${subLessons.length} lessons):\n`;
            if (subLessons.length > 0) {
                contextString += `   - ${subLessons.join('\n   - ')}\n`;
            } else {
                contextString += `   - (No lessons yet)\n`;
            }
            contextString += `\n`;
        });

        contextString += `--- END OF STRUCTURE ---\n`;

        // 6. الحفظ في الكاش
        cachedContext = contextString;
        lastFetchTime = now;

        return contextString;

    } catch (error) {
        console.error('❌ Error building curriculum context:', error);
        // في حالة الخطأ، نرجع الكاش القديم إذا وجد أو نص فارغ
        return cachedContext || "";
    }
}

// دالة لمسح الكاش يدوياً (مثلاً عند إضافة درس جديد)
function clearCurriculumCache() {
    cachedContext = null;
    lastFetchTime = 0;
}

module.exports = { getCurriculumContext, clearCurriculumCache };
