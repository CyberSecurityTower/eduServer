// controllers/subjectController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * جلب المواد الخاصة بالطالب بناءً على مساره + الفصل الدراسي العالمي للنظام
 */
async function getMySubjects(req, res) {
    const userId = req.user?.id;

    try {
        // 1. جلب مسار الطالب من جدول المستخدمين
        const { data: userProfile, error: userError } = await supabase
            .from('users')
            .select('selected_path_id') // ✅ نجلب المسار فقط
            .eq('id', userId)
            .single();

        if (userError || !userProfile) {
            console.error("User fetch error:", userError);
            return res.status(400).json({ error: 'User profile not found' });
        }

        const pathId = userProfile.selected_path_id;

        if (!pathId) {
            return res.json({ success: true, subjects: [] });
        }

        // 2. جلب الفصل الدراسي الحالي من إعدادات النظام
        // ✅ التصحيح: القراءة من system_settings كما في الصورة
        const { data: semesterSetting, error: settingError } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'current_semester')
            .single();

        // إذا لم نجد الإعداد، نفترض S1 افتراضياً
        const currentSemester = semesterSetting?.value || 'S1';

        console.log(`🔎 Fetching subjects for Path: ${pathId}, Semester: ${currentSemester}`);

        // 3. جلب المواد التي تطابق المسار والفصل
        let query = supabase
            .from('subjects')
            .select('id, title, icon, color_primary, semester') 
            .eq('path_id', pathId)
            .eq('semester', currentSemester) // الفلترة بالفصل
            .order('title'); 

        const { data: subjects, error } = await query;

        if (error) throw error;

        res.json({ success: true, subjects });

    } catch (err) {
        logger.error('Get Subjects Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getMySubjects
};
