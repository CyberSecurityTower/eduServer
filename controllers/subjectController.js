// controllers/subjectController.js
'use strict';
const supabase = require('../services/data/supabase');

async function getMySubjects(req, res) {
    const userId = req.user?.id;
    try {
        // 1. جلب مسار الطالب
        const { data: user } = await supabase.from('users').select('selected_path_id').eq('id', userId).single();
        const pathId = user?.selected_path_id;

        if (!pathId) return res.json({ success: true, subjects: [] });

        // 2. جلب المواد المرتبطة بهذا المسار
        // نفترض أن لديك عمود path_id في جدول subjects كما ظهر في الصور
        const { data: subjects, error } = await supabase
            .from('subjects')
            .select('id, title, icon, color_primary')
            .eq('path_id', pathId) // أو المنطق الخاص بك لربط المادة بالمسار
            .order('title');

        if (error) throw error;

        res.json({ success: true, subjects });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { getMySubjects };
