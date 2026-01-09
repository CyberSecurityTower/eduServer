// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');

async function uploadLessonSource(req, res) {
  try {
    const userId = req.user?.id; // لازم يكون مسجل دخول
    const { lessonId } = req.body;
    const file = req.file; // ملف واحد (أو req.files للمتعدد)

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // استدعاء المانجر
    const result = await sourceManager.uploadSource(
        userId, 
        lessonId, 
        file.path, // Multer يخزن المسار المؤقت هنا
        file.originalname, 
        file.mimetype
    );

    return res.status(201).json({
        success: true,
        message: 'File uploaded successfully',
        source: result
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function listLessonSources(req, res) {
    const { lessonId } = req.params;
    const userId = req.user?.id;

    try {
        const sources = await sourceManager.getSourcesForLesson(userId, lessonId);
        res.json({ success: true, sources });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

module.exports = { uploadLessonSource, listLessonSources };
