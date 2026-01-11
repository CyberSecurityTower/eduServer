// controllers/sourceController.js
'use strict';

const sourceManager = require('../services/media/sourceManager');
const lessonGenerator = require('../services/ai/lessonGenerator'); // الخدمة الجديدة
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

// 1. رفع ملف + توليد درس (Parallel Processing) 🔥
async function uploadFile(req, res) {
  const userId = req.user?.id;
  const { lessonId } = req.body;
  const file = req.file;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!file) return res.status(400).json({ error: 'No file provided' });

  // رد أولي سريع (اختياري، لكن يفضل انتظار الانتهاء لضمان التحديث)
  // سننتظر هنا لأننا نريد إرجاع الدرس المولد فوراً
  
  try {
    logger.info(`🚀 Starting Parallel Process for: ${file.originalname}`);

    // --- المعالجة بالتوازي (Parallel Execution) ---
    // نطلق العمليتين معاً في نفس اللحظة
    const [uploadResult, aiGeneratedLesson] = await Promise.all([
      // المهمة 1: الرفع للكلاوديناري والحفظ الأولي في الداتابايز
      sourceManager.uploadSource(userId, lessonId, file.path, file.originalname, file.mimetype),
      
      // المهمة 2: إرسال الملف للـ AI لتوليد الدرس
      // ملاحظة: نمرر file.path لأن الملف لا يزال موجوداً في Temp
      lessonGenerator.generateLessonFromSource(file.path, file.mimetype)
    ]);

    // --- مرحلة الدمج (Merge Results) ---
    // إذا نجح الـ AI في توليد نص، نقوم بتحديث السجل الذي أنشأه sourceManager
    if (aiGeneratedLesson && uploadResult?.id) {
        logger.info(`💾 Saving AI Lesson to DB for Source ID: ${uploadResult.id}`);
        
        await supabase
            .from('lesson_sources')
            .update({ 
                extracted_text: aiGeneratedLesson, // خزنّا الدرس هنا
                processed: true 
            })
            .eq('id', uploadResult.id);
            
        // تحديث الكائن المرتجع للفرونت أند
        uploadResult.extracted_text = aiGeneratedLesson;
        uploadResult.processed = true;
    }

    // الرد النهائي يحتوي على رابط الملف + شرح الـ AI
    res.status(201).json({ 
        success: true, 
        data: uploadResult,
        message: aiGeneratedLesson ? 'File uploaded & Lesson generated!' : 'File uploaded (AI analysis skipped)'
    });

  } catch (err) {
    logger.error('Parallel Upload Error:', err.message);
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
