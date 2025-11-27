
// controllers/tasksController.js
'use strict';

// 👇👇👇 هذا السطر هو الأهم والذي كان ناقصاً 👇👇👇
const supabase = require('../services/data/supabase'); 
const { generateSmartTodos } = require('../services/ai/managers/todoManager');
const logger = require('../utils/logger');

async function generateDailyTasks(req, res) {
  try {
    const { userId, count = 3 } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // استدعاء الماناجير
    const tasks = await generateSmartTodos(userId, count);

    // الحفظ في Supabase
    if (tasks && tasks.length > 0) {
      const tasksToInsert = tasks.map(t => ({
        user_id: userId,
        title: t.title,
        type: t.type || 'general',
        priority: t.priority || 'medium',
        meta: t.meta || {},
        status: 'pending',
        created_at: new Date().toISOString()
      }));

      const { error } = await supabase.from('user_tasks').insert(tasksToInsert);
      if (error) throw error;
    }

    return res.status(200).json({ success: true, tasks });

  } catch (err) {
    logger.error('Generate Tasks Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// دالة التحديث (مهمة لكي لا يحدث خطأ عند استدعاء الملف)
async function updateDailyTasks(req, res) {
  try {
      const { taskId, status } = req.body;
      if (!taskId) return res.status(400).json({ error: 'Missing taskId' });

      await supabase.from('user_tasks').update({ status }).eq('id', taskId);
      res.json({ success: true });
  } catch (e) {
      res.status(500).json({ error: e.message });
  }
}

module.exports = {
  generateDailyTasks,
  updateDailyTasks
};
