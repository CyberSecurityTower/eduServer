
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

    // 1. AI يولد المهام
    const aiTasks = await generateSmartTodos(userId, count);

    let finalTasks = [];

    // 2. الحفظ في Supabase مع استرجاع البيانات (.select())
    if (aiTasks && aiTasks.length > 0) {
      const tasksToInsert = aiTasks.map(t => ({
        user_id: userId,
        title: t.title,
        type: t.type || 'general',
        priority: t.priority || 'medium',
        meta: t.meta || {},
        status: 'pending',
        created_at: new Date().toISOString()
      }));

      // 👇👇 التغيير هنا: أضفنا .select() لنحصل على البيانات المحفوظة (مع IDs)
      const { data: insertedTasks, error } = await supabase
        .from('user_tasks')
        .insert(tasksToInsert)
        .select(); 

      if (error) throw error;
      finalTasks = insertedTasks; // نستخدم البيانات القادمة من الداتابيز
    }

    // 3. إرجاع البيانات الكاملة للفرونت أند
    return res.status(200).json({ success: true, tasks: finalTasks });

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
async function getDailyTasks(req, res) {
  try {
    const { userId } = req.query; // نستخدم query params (GET request)
    
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // جلب المهام غير المكتملة (pending)
    const { data: tasks, error } = await supabase
      .from('user_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ success: true, tasks: tasks || [] });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// لا تنس تصدير الدالة الجديدة في الأسفل
module.exports = {
  generateDailyTasks,
  updateDailyTasks,
  getDailyTasks // ✅ مضاف
};
