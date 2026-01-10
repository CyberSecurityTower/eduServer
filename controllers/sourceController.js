// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const logger = require('../utils/logger');

// 1. رفع ملف
async function uploadFile(req, res) {
  try {
    const userId = req.user?.id;
    const { lessonId } = req.body; // يمكن يكون null
    const file = req.file;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const result = await sourceManager.uploadSource(
        userId,
        lessonId,
        file.path,
        file.originalname,
        file.mimetype
    );

    res.status(201).json({ success: true, data: result });

  } catch (err) {
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
        res.status(200).json({ success: true, sources });

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

module.exports = { uploadFile, getLessonFiles, deleteFile };
