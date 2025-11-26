
// controllers/tasksController.js
'use strict';

const { getFirestoreInstance, admin } = require('../services/data/firestore');
const { cacheDel } = require('../services/data/helpers');
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const logger = require('../utils/logger');
const { generateSmartTodos } = require('../services/ai/managers/todoManager'); // ✅ استيراد الماناجير الجديد

const db = getFirestoreInstance();
async function generateDailyTasks(req, res) {
  try {
    const { userId, count = 3 } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // 1. استدعاء الـ AI
    const tasks = await generateSmartTodos(userId, count);

    // 2. حفظ المهام في Supabase
    if (tasks.length > 0) {
      const tasksToInsert = tasks.map(t => ({
        user_id: userId,
        title: t.title,
        type: t.type,
        priority: t.priority,
        meta: t.meta,
        status: 'pending',
        created_at: new Date().toISOString()
      }));

      const { error } = await supabase.from('user_tasks').insert(tasksToInsert);
      if (error) throw error;
    }

    return res.status(200).json({ success: true, tasks });

  } catch (err) {
    logger.error('Generate Tasks Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
async function updateDailyTasks(req, res) {
  try {
    const { userId, updatedTasks } = req.body || {};
    if (!userId || !Array.isArray(updatedTasks)) {
      return res.status(400).json({ error: 'User ID and updatedTasks array are required.' });
    }
    await db.collection('userProgress').doc(userId).set({
      dailyTasks: { tasks: updatedTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });
    cacheDel('progress', userId);
    res.status(200).json({ success: true, message: 'Daily tasks updated successfully.' });
  } catch (error) {
    logger.error('/update-daily-tasks error:', error.stack);
    res.status(500).json({ error: 'An error occurred while updating daily tasks.' });
  }
}


module.exports = {
  updateDailyTasks,
  generateDailyTasks,
  
};
