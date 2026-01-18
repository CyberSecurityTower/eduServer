// controllers/storeController.js
'use strict';

const supabase = require('../services/data/supabase');
const sourceManager = require('../services/media/sourceManager'); // سنستخدمه لرفع الملفات
const logger = require('../utils/logger');

// 1. جلب قائمة المتجر (للمستخدم)
async function getStoreItems(req, res) {
  try {
    const userId = req.user?.id;

    // جلب العناصر النشطة
    const { data: items, error } = await supabase
      .from('store_items')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // جلب ما يملكه المستخدم (لمعرفة ماذا اشترى)
    const { data: owned } = await supabase
      .from('user_inventory')
      .select('item_id')
      .eq('user_id', userId);

    const ownedSet = new Set(owned?.map(i => i.item_id));

    // دمج المعلومات
    const formattedItems = items.map(item => ({
      ...item,
      isOwned: ownedSet.has(item.id) // هل اشتراه من قبل؟
    }));

    res.json({ success: true, items: formattedItems });

  } catch (err) {
    logger.error('Get Store Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// 2. شراء عنصر
async function purchaseItem(req, res) {
  const userId = req.user?.id;
  const { itemId } = req.body;

  if (!userId || !itemId) return res.status(400).json({ error: 'Missing data' });

  try {
    // استدعاء دالة الـ RPC التي أنشأناها في الخطوة 1
    const { data, error } = await supabase.rpc('buy_store_item', {
      p_user_id: userId,
      p_item_id: itemId
    });

    if (error) throw error;

    if (!data.success) {
      return res.status(400).json({ error: data.message });
    }

    logger.success(`🛒 User ${userId} bought item ${itemId}`);
    res.json({ success: true, newBalance: data.new_balance });

  } catch (err) {
    logger.error('Purchase Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// 3. جلب مكتبة المستخدم (My Inventory)
async function getMyInventory(req, res) {
  const userId = req.user?.id;
  try {
    const { data, error } = await supabase
      .from('user_inventory')
      .select(`
        purchased_at,
        store_items (*)
      `)
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false });

    if (error) throw error;

    // تنظيف البيانات
    const inventory = data.map(row => ({
      ...row.store_items,
      purchasedAt: row.purchased_at
    }));

    res.json({ success: true, inventory });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 4. (للأدمين) رفع وإضافة منتج جديد
async function addStoreItem(req, res) {
  // استخدام sourceManager لرفع الملف إلى Cloudinary
  // نتوقع أن الملف موجود في req.file بفضل middleware الرفع
  const file = req.file;
  const { title, description, price, category } = req.body;

  if (!file) return res.status(400).json({ error: 'File is required' });

  try {
    // 1. رفع الملف والحصول على الرابط
    // نستخدم دالة وهمية هنا، أو نعدل sourceManager ليسمح برفع عام
    // سنستخدم Cloudinary مباشرة هنا للسرعة أو نعدل sourceManager لاحقاً
    const cloudinary = require('../config/cloudinary');
    const uploadResult = await cloudinary.uploader.upload(file.path, {
        folder: 'edustore_products',
        resource_type: 'auto'
    });

    // 2. الحفظ في قاعدة البيانات
    const { data, error } = await supabase.from('store_items').insert({
        title,
        description,
        price: parseInt(price),
        file_url: uploadResult.secure_url,
        category: category || 'general',
        is_active: true
    }).select().single();

    if (error) throw error;

    // حذف الملف المؤقت
    const fs = require('fs');
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    res.json({ success: true, item: data });

  } catch (err) {
    logger.error('Add Store Item Error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getStoreItems,
  purchaseItem,
  getMyInventory,
  addStoreItem
};
