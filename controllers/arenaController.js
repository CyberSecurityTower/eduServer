
// controllers/arenaController.js
'use strict';

const { generateArenaExam } = require('../services/arena/generator');
const { gradeArenaExam } = require('../services/arena/grader');
const logger = require('../utils/logger');

// 1. توليد الامتحان (GET /arena/generate/:lessonId)
async function generateExam(req, res) {
    const { lessonId } = req.params;
    const { mode } = req.query; // 'practice' or 'exam'

    if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

    try {
        const examData = await generateArenaExam(lessonId, mode);
        res.status(200).json({
            success: true,
            data: examData
        });
    } catch (err) {
        logger.error('Generate Exam Controller Error:', err.message);
        // إذا لم توجد أسئلة، نرسل 404 ليعرف الفرونت
        if (err.message.includes('No questions')) {
            return res.status(404).json({ error: 'No questions available for this lesson yet.' });
        }
        res.status(500).json({ error: 'Failed to generate exam.' });
    }
}

// 2. تصحيح الامتحان (POST /arena/submit)
async function submitExam(req, res) {
    const userId = req.user?.id;
    const { lessonId, answers } = req.body;

    if (!userId || !lessonId || !Array.isArray(answers)) {
        return res.status(400).json({ error: 'Invalid submission data.' });
    }

    try {
        const result = await gradeArenaExam(userId, lessonId, answers);
        
        res.status(200).json({
            success: true,
            result: result
        });
    } catch (err) {
        logger.error('Submit Exam Controller Error:', err.message);
        res.status(500).json({ error: 'Failed to submit exam.' });
    }
}

module.exports = { generateExam, submitExam };
