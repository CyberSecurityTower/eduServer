
// controllers/quizController.js
'use strict';

const { runQuizAnalyzer } = require('../services/ai/managers/quizManager');
const logger = require('../utils/logger');

async function analyzeQuiz(req, res) {
  try {
    const { userId, lessonTitle, quizQuestions, userAnswers, totalScore } = req.body || {};
    if (!userId || !lessonTitle || !Array.isArray(quizQuestions) || !Array.isArray(userAnswers) || typeof totalScore !== 'number') {
      return res.status(400).json({ error: 'Invalid or incomplete quiz data provided.' });
    }
    const analysis = await runQuizAnalyzer({ lessonTitle, quizQuestions, userAnswers, totalScore });
    return res.status(200).json(analysis);
  } catch (err) {
    logger.error('/analyze-quiz error:', err.stack);
    return res.status(500).json({ error: 'An internal server error during quiz analysis.' });
  }
}

module.exports = {
  analyzeQuiz,
};
