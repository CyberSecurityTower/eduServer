// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const fs = require('fs');

// 1. دالة الرفع (Endpoint Handler)
async function uploadFile(req, res) {
  const userId = req.user?.id;
  const { lessonId, customName, description, lessonIds, subjectIds } = req.body; 
  const file = req.file;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!file) return res.status(400).json({ error: 'No file provided' });

  try {
    // 1. الرفع والحفظ (الحالة تكون completed فوراً من داخل sourceManager)
    const uploadResult = await sourceManager.uploadSource(
        userId, 
        lessonId || null, 
        file.path, 
        customName || file.originalname, 
        description || "", 
        file.mimetype,
        file.originalname
    );

    const sourceId = uploadResult.id;

    // 2. الربط المتعدد
    const linkPromises = [];
    if (lessonIds) {
        const lIds = Array.isArray(lessonIds) ? lessonIds : JSON.parse(lessonIds);
        const lessonLinks = lIds.map(lId => ({ source_id: sourceId, lesson_id: lId }));
        linkPromises.push(supabase.from('source_lessons').insert(lessonLinks));
    }
    if (subjectIds) {
        const sIds = Array.isArray(subjectIds) ? subjectIds : JSON.parse(subjectIds);
        const subjectLinks = sIds.map(sId => ({ source_id: sourceId, subject_id: sId }));
        linkPromises.push(supabase.from('source_subjects').insert(subjectLinks));
    }
    if (linkPromises.length > 0) await Promise.all(linkPromises);

    // 3. حذف الملف المؤقت
    if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }

    res.status(200).json({ 
        success: true, 
        message: 'File uploaded successfully.',
        data: uploadResult 
    });

  } catch (err) {
    logger.error('Upload Error:', err.message);
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
}

// 2. جلب ملفات درس
async function getLessonFiles(req, res) {
    try {
        const { lessonId } = req.params;
        const userId = req.user?.id;

        if (!lessonId) return res.status(400).json({ error: 'Lesson ID required' });

        const sources = await sourceManager.getSourcesByLesson(userId, lessonId);
        res.status(200).json({ success: true, sources: sources });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 3. حذف ملف
async function deleteFile(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;

        await sourceManager.deleteSource(userId, sourceId);
        res.status(200).json({ success: true, message: 'Deleted successfully' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 4. فحص الحالة (أبقينا عليها لعدم كسر أي واجهة قديمة، لكنها ترجع completed دائماً)
async function checkSourceStatus(req, res) {
    try {
        const { sourceId } = req.params;
        const userId = req.user?.id;
        const statusData = await sourceManager.getSourceStatus(userId, sourceId);

        if (!statusData) return res.status(404).json({ error: 'Source not found' });

        res.status(200).json({ 
            success: true, 
            status: 'completed', // دائماً مكتمل
            data: statusData.extracted_text 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 5. جلب مكتبة المستخدم
async function getAllUserSources(req, res) {
    const userId = req.user?.id;
    try {
        const { data, error } = await supabase
            .from('lesson_sources')
            .select(`*, source_lessons(lesson_id), source_subjects(subject_id)`)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, count: data.length, sources: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// 6. ربط المصدر
async function linkSourceToContext(req, res) {
  const { sourceId, lessonIds, subjectIds } = req.body;
  const userId = req.user?.id;

  try {
    const { data: source } = await supabase
        .from('lesson_sources')
        .select('id')
        .eq('id', sourceId)
        .eq('user_id', userId)
        .single();

    if (!source) return res.status(403).json({ error: "Access denied" });

    if (lessonIds && Array.isArray(lessonIds)) {
        const lessonLinks = lessonIds.map(lId => ({ source_id: sourceId, lesson_id: lId }));
        await supabase.from('source_lessons').upsert(lessonLinks);
    }
    if (subjectIds && Array.isArray(subjectIds)) {
        const subjectLinks = subjectIds.map(sId => ({ source_id: sourceId, subject_id: sId }));
        await supabase.from('source_subjects').upsert(subjectLinks);
    }

    res.json({ success: true, message: 'Source linked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { 
    uploadFile, 
    getLessonFiles, 
    getAllUserSources,
    deleteFile, 
    checkSourceStatus, 
    linkSourceToContext
    // ❌ تم حذف retryProcessing و triggerSystemRetry
};
