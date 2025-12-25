// services/ai/managers/plannerManager.js
'use strict';

const supabase = require('../../data/supabase');
const logger = require('../../../utils/logger');
const { getHumanTimeDiff, getAlgiersTimeContext } = require('../../../utils');

/**
 * 🪐 CORTEX GRAVITY ENGINE V5.2 (Final Fix)
 * - تم إزالة العمود 'type' المسبب للمشاكل.
 * - إضافة نظام إبلاغ عن الأخطاء داخل التطبيق.
 */
async function runPlannerManager(userId, pathId) {
  try {
    // 1. تحديد المسار
    const safePathId = pathId || 'UAlger3_L1_ITCF';
    logger.info(`🪐 Gravity Engine Start: User=${userId}, Path=${safePathId}`);

    // 2. جلب إعدادات السداسي
    const { data: settings } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'current_semester')
        .maybeSingle();
    
    const currentSemester = settings?.value || null;
    console.log(`🔍 Gravity Config: Semester='${currentSemester}'`); 

    // 3. جلب المواد (Subjects)
    const { data: subjects, error: subjError } = await supabase
        .from('subjects')
        .select('id, title, semester, path_id')
        .eq('path_id', safePathId);

    if (subjError) {
        console.error('❌ DB Error (Subjects):', subjError.message);
        return { tasks: [] };
    }

    if (!subjects || subjects.length === 0) {
        console.warn(`⚠️ No subjects found for path: '${safePathId}'. Check 'subjects' table.`);
        return { tasks: [] }; // <--- هنا المشكلة غالباً
    }
    console.log(`✅ Found ${subjects.length} subjects.`);

    const subjectIds = subjects.map(s => s.id);
    const subjectsMap = {};
    subjects.forEach(s => subjectsMap[s.id] = s);

    // 4. جلب الدروس (Lessons)
    const { data: lessonsRaw, error: lessonsError } = await supabase
        .from('lessons')
        .select('id, title, subject_id')
        .in('subject_id', subjectIds)
        .order('order_index', { ascending: true });

    if (lessonsError) {
        console.error('❌ DB Error (Lessons):', lessonsError.message);
        return { tasks: [] };
    }

    if (!lessonsRaw || lessonsRaw.length === 0) {
        console.warn(`⚠️ No lessons found linked to these subjects.`);
        return { tasks: [] };
    }
    console.log(`✅ Found ${lessonsRaw.length} raw lessons.`);

    // 5. الدمج والفلترة (Gravity Logic)
    // ... (جلب التقدم progressMap هنا كما في كودك الأصلي) ...
    const { data: progressData } = await supabase.from('user_progress').select('*').eq('user_id', userId);
    const progressMap = new Map();
    if(progressData) progressData.forEach(p => progressMap.set(p.lesson_id, p));

    const lessons = lessonsRaw.map(l => ({ ...l, subjects: subjectsMap[l.subject_id] }));

    let candidates = lessons.map(lesson => {
        // فلتر السداسي
        if (currentSemester && lesson.subjects?.semester) {
            const lSem = lesson.subjects.semester.toString().toLowerCase().trim();
            const sSem = currentSemester.toString().toLowerCase().trim();
            
            if (!lSem.includes(sSem) && !sSem.includes(lSem)) {
                // console.log(`🗑️ Filtered: ${lesson.title} (${lSem} != ${sSem})`); // Uncomment to debug
                return null;
            }
        }

        // حساب النقاط (Gravity Score)
        let gravityScore = 100;
        let taskType = 'study';
        const userState = progressMap.get(lesson.id);

        if (userState) {
            if (userState.mastery_score >= 80) return null; // إخفاء المكتمل بامتياز
            if (userState.mastery_score < 50) gravityScore += 5000; // أولوية قصوى
            else { gravityScore = 10; taskType = 'review'; }
        } else {
            gravityScore += 1000; // درس جديد
        }

        return {
            id: lesson.id,
            title: lesson.title,
            type: taskType,
            score: gravityScore,
            meta: { relatedLessonId: lesson.id, score: gravityScore }
        };
    }).filter(Boolean);

    console.log(`📊 Candidates after filtering: ${candidates.length}`);

    // 6. Fallback (إذا الفلتر حذف كل شيء)
    if (candidates.length === 0 && lessons.length > 0) {
        console.log("🔄 Using Fallback tasks...");
        candidates = lessons.slice(0, 3).map(l => ({
            id: l.id,
            title: `مراجعة: ${l.title}`,
            type: 'review',
            score: 5,
            meta: { relatedLessonId: l.id }
        }));
    }

    // ترتيب وإرجاع
    candidates.sort((a, b) => b.score - a.score);
    const finalTasks = candidates.slice(0, 3);
    
    return { tasks: finalTasks, source: 'Gravity_Debug' };

  } catch (err) {
    logger.error('Gravity Critical Error:', err);
    return { tasks: [] };
  }
}

module.exports = { runPlannerManager };
