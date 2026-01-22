// controllers/subjectController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * جلب المواد الخاصة بالطالب بناءً على مساره وفصله الدراسي الحالي
 */
async function getMySubjects(req, res) {
    const userId = req.user?.id;

    try {
        // 1. جلب بيانات الطالب (المسار + الفصل الدراسي)
        const { data: userProfile, error: userError } = await supabase
            .from('users')
            .select('selected_path_id, current_semester') // تأكد أن عمود current_semester موجود، أو استبدله بالعمود المناسب لديك
            .eq('id', userId)
            .single();

        if (userError || !userProfile) {
            return res.status(400).json({ error: 'User profile not found or path not selected' });
        }

        const pathId = userProfile.selected_path_id;
        // إذا لم يكن هناك فصل محدد، نفترض الفصل الأول أو نجلب الكل (حسب منطقك)
        // هنا سنفترض S1 إذا كان null لضمان عدم عرض مواد S2 بالخطأ
        const currentSemester = userProfile.current_semester || 'S1'; 

        if (!pathId) {
            return res.json({ success: true, subjects: [] });
        }

        // 2. جلب المواد التي تطابق المسار والفصل
        let query = supabase
            .from('subjects')
            .select('id, title, icon, color_primary, semester') // نجلب الحقول التي نحتاجها للعرض
            .eq('path_id', pathId)
            // ✅ الفلترة الذكية: نجلب فقط مواد الفصل الحالي
            // إذا كانت قيمة الفصل في قاعدة البيانات S1, S2 تأكد أنها تطابق ما في البروفايل
            .eq('semester', currentSemester) 
            .order('title'); 

        const { data: subjects, error } = await query;

        if (error) throw error;

        console.log(`📚 Fetched ${subjects.length} subjects for Path: ${pathId}, Sem: ${currentSemester}`);

        res.json({ success: true, subjects });

    } catch (err) {
        logger.error('Get Subjects Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getMySubjects
};
