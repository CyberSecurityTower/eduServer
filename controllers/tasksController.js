
// controllers/tasksController.js
'use strict';

const supabase = require('../services/data/supabase'); 
const { refreshUserTasks, getDailyTasks: getCachedTasks } = require('../services/data/helpers'); // ✅ استدعاء المحرك الحقيقي
const logger = require('../utils/logger');

// 1. توليد المهام (باستخدام الجاذبية)
async function generateDailyTasks(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // 🔥 هنا التغيير الجذري: نستخدم refreshUserTasks بدلاً من generateSmartTodos
    // هذه الدالة هي التي تطبق خوارزمية الجاذبية وتجلب الدروس العربية
    const tasks = await refreshUserTasks(userId);

    return res.status(200).json({ success: true, tasks: tasks });

  } catch (err) {
    logger.error('Generate Tasks Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// 2. جلب المهام (للعرض فقط)
async function getDailyTasks(req, res) {
    // ... (نفس الكود القديم، لكن تأكد أنه يقرأ من user_tasks)
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const { data: tasks } = await supabase
            .from('user_tasks')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .order('priority', { ascending: false }); // High priority first

        return res.status(200).json({ success: true, tasks: tasks || [] });
    } catch (e) {
        return res.status(500).json({ error: e.message });
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

// لا تنس تصدير الدالة الجديدة في الأسفل
module.exports = {
  generateDailyTasks,
  updateDailyTasks,
  getDailyTasks 
};
