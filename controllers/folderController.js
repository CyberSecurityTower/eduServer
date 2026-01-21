// controllers/folderController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

// 1. جلب المجلدات
async function getUserFolders(req, res) {
  const userId = req.user?.id;
  try {
    const { data, error } = await supabase
      .from('user_folders')
      .select('*')
      .eq('user_id', userId)
      .order('order_index', { ascending: true }); // الترتيب مهم للواجهة

    if (error) throw error;
    res.json({ success: true, folders: data });
  } catch (err) {
    logger.error('Get Folders Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// 2. إنشاء مجلد جديد
async function createFolder(req, res) {
  const userId = req.user?.id;
  const { name, metadata } = req.body; // metadata for color/icon

  if (!name) return res.status(400).json({ error: 'Folder name is required' });

  try {
    // حساب الـ order_index الجديد (نضعه في النهاية)
    const { count } = await supabase
        .from('user_folders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

    const { data, error } = await supabase.from('user_folders').insert({
      user_id: userId,
      name: name,
      folder_type: 'custom', // الافتراضي
      order_index: (count || 0) + 1,
      metadata: metadata || { icon: 'folder', color: '#3B82F6' } // أزرق افتراضي
    }).select().single();

    if (error) throw error;
    res.json({ success: true, folder: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 3. تحديث مجلد (الاسم أو اللون)
async function updateFolder(req, res) {
  const userId = req.user?.id;
  const { folderId } = req.params;
  const { name, metadata } = req.body;

  try {
    // التحقق من أن المجلد ليس "System"
    const { data: existing } = await supabase
        .from('user_folders')
        .select('folder_type')
        .eq('id', folderId)
        .single();
    
    if (existing && existing.folder_type === 'system') {
        return res.status(403).json({ error: 'Cannot rename system folders' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (metadata) updates.metadata = metadata;

    const { data, error } = await supabase
      .from('user_folders')
      .update(updates)
      .eq('id', folderId)
      .eq('user_id', userId) // RLS handles this, but explicit check is good
      .select().single();

    if (error) throw error;
    res.json({ success: true, folder: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 4. حذف مجلد
async function deleteFolder(req, res) {
  const userId = req.user?.id;
  const { folderId } = req.params;

  try {
     // التحقق من نوع المجلد
    const { data: existing } = await supabase.from('user_folders').select('folder_type').eq('id', folderId).single();
    if (existing?.folder_type === 'system') {
        return res.status(403).json({ error: 'Cannot delete system folders' });
    }

    // الحذف (الملفات ستعود للـ Root تلقائياً بسبب ON DELETE SET NULL في الداتابيز)
    const { error } = await supabase
      .from('user_folders')
      .delete()
      .eq('id', folderId)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ success: true, message: 'Folder deleted. Files moved to root.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 5. إعادة الترتيب (Drag & Drop Logic)
async function reorderFolders(req, res) {
  const userId = req.user?.id;
  const { folderIds } = req.body; // مصفوفة IDs بالترتيب الجديد

  if (!Array.isArray(folderIds)) return res.status(400).json({ error: 'folderIds array required' });

  try {
    // استدعاء دالة RPC في الداتابيز لتحسين الأداء
    const { error } = await supabase.rpc('reorder_folders', {
      folder_ids: folderIds
    });

    if (error) throw error;
    res.json({ success: true, message: 'Folders reordered' });
  } catch (err) {
    logger.error('Reorder Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getUserFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders
};
