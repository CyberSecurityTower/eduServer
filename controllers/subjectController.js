// controllers/subjectController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

// دالة لجلب الأقسام والأفواج بذكاء
async function getAcademicHierarchy(req, res) {
  const { pathId } = req.query;

  if (!pathId) {
    return res.status(400).json({ error: 'pathId is required' });
  }

  try {
    // 1. جلب الأقسام المرتبطة بهذا المسار
    const { data: sections, error: secError } = await supabase
      .from('sections')
      .select('id, name')
      .eq('path_id', pathId)
      .order('name', { ascending: true });

    if (secError) throw secError;

    // 2. جلب الأفواج المرتبطة بهذا المسار
    const { data: groups, error: grpError } = await supabase
      .from('study_groups')
      .select('id, name, section_id')
      .eq('path_id', pathId)
      .order('name', { ascending: true });

    if (grpError) throw grpError;

    // إرجاع البيانات
    res.json({
      sections: sections || [],
      groups: groups || []
    });

  } catch (error) {
    console.error("Hierarchy Error:", error);
    res.status(500).json({ error: error.message });
  }
}
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

/**
 * [NEW] جلب الدروس التابعة لمادة معينة
 */
async function getLessonsBySubject(req, res) {
    const { subjectId } = req.query; // نأخذ المعرف من الرابط ?subjectId=...

    if (!subjectId) {
        return res.status(400).json({ error: 'Subject ID is required' });
    }

    try {
        // نختار الحقول المهمة فقط للعرض في القائمة
        // تأكد أن اسم العمود في جدول lessons هو 'subject_id'
        const { data: lessons, error } = await supabase
            .from('lessons') 
            .select('id, title, order_index') 
            .eq('subject_id', subjectId)
            .order('order_index', { ascending: true }); // ترتيب الدروس

        if (error) throw error;

        res.json({ success: true, lessons });

    } catch (err) {
        logger.error('Get Lessons Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getMySubjects,
    getLessonsBySubject ,
    getAcademicHierarchy
};
