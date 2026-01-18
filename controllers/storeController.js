'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const cloudinary = require('../config/cloudinary'); 
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// 1. جلب قائمة المتجر
async function getStoreItems(req, res) {
  try {
    const userId = req.user?.id;
    const { data: userProfile } = await supabase
        .from('users')
        .select('selected_path_id')
        .eq('id', userId)
        .single();

    const userPath = userProfile?.selected_path_id;

    let query = supabase.from('store_items').select('*').eq('is_active', true);

    if (userPath) {
        query = query.or(`path_id.eq.${userPath},path_id.is.null`);
    } else {
        query = query.is('path_id', null);
    }
    
    if (req.query.subjectId) {
        query = query.eq('subject_id', req.query.subjectId);
    }

    const { data: items, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    const { data: owned } = await supabase.from('user_inventory').select('item_id').eq('user_id', userId);
    const ownedSet = new Set(owned?.map(i => i.item_id));

    const formattedItems = items.map(item => ({
      ...item,
      isOwned: ownedSet.has(item.id)
    }));

    res.json({ success: true, items: formattedItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 2. شراء عنصر
async function purchaseItem(req, res) {
  const userId = req.user?.id;
  const { itemId } = req.body;
  try {
    const { data, error } = await supabase.rpc('buy_store_item', {
      p_user_id: userId,
      p_item_id: itemId
    });
    if (error) throw error;
    res.json({ success: true, newBalance: data.new_balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 3. جلب مكتبة المستخدم (المشتريات)
async function getMyInventory(req, res) {
  const userId = req.user?.id;
  try {
    const { data, error } = await supabase
      .from('user_inventory')
      .select(`purchased_at, store_items (*)`)
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false });

    if (error) throw error;
    const inventory = data.map(row => ({ ...row.store_items, purchasedAt: row.purchased_at }));
    res.json({ success: true, inventory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 4. (Admin) إضافة منتج جديد
async function addStoreItem(req, res) {
  const file = req.file;
  const { title, description, price, category, content, type, metadata, pathId, subjectId, lessonId } = req.body;
  if (!file) return res.status(400).json({ error: 'File is required' });

  let finalFilePath = file.path;
  try {
    const stats = fs.statSync(finalFilePath);
    const uploadResult = await cloudinary.uploader.upload(finalFilePath, {
        folder: 'edustore_products',
        resource_type: 'auto'
    });

    const { data, error } = await supabase.from('store_items').insert({
        title, description, price: parseInt(price) || 0,
        file_url: uploadResult.secure_url,
        file_size: (stats.size / 1024 / 1024).toFixed(2) + " MB",
        category, content, type, path_id: pathId, 
        subject_id: subjectId, lesson_id: lessonId, is_active: true
    }).select().single();

    if (error) throw error;
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.json({ success: true, item: data });
  } catch (err) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
}

// 5. قراءة المحتوى
async function getItemContent(req, res) {
    const userId = req.user?.id;
    const { itemId } = req.params;
    try {
        const { data: item } = await supabase.from('store_items').select('*').eq('id', itemId).single();
        res.json({ success: true, content: item.content, fileUrl: item.file_url, title: item.title });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// تصدير دوال المتجر فقط
module.exports = {
  getStoreItems,
  purchaseItem,
  getMyInventory,
  addStoreItem,
  getItemContent,
  getAvailableItems,
  removeFromInventory
};
