
'use strict';

const { generateArenaExam } = require('../services/arena/generator');
const { gradeArenaExam } = require('../services/arena/grader');
const logger = require('../utils/logger');

async function generateExam(req, res) {
    const { lessonId } = req.params;
    const { mode } = req.query;

    if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

    try {
        const examData = await generateArenaExam(lessonId, mode);
        // إرسال البيانات بشكل مسطح ليسهل قراءتها في الفرونت
        res.status(200).json({
            success: true,
            ...examData 
        });

    } catch (err) {
        logger.error('Generate Exam Controller Error:', err.message);
        res.status(500).json({ error: 'Failed to generate exam.' });
    }
}

async function submitExam(req, res) {
    console.log("Submit Request from User:", req.user); 
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
