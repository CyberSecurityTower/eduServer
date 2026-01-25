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

    const { data: owned } = await supabase
      .from('user_inventory')
      .select('item_id')
      .eq('user_id', userId);

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
      p_user_id: userId, p_item_id: itemId
    });
    if (error) throw error;
    if (!data.success) return res.status(400).json({ error: data.message });
    res.json({ success: true, newBalance: data.new_balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 3. مكتبة المستخدم
async function getMyInventory(req, res) {
  const userId = req.user?.id;
  try {
    const { data, error } = await supabase
      .from('user_inventory')
      .select(`purchased_at, store_items (*)`)
      .eq('user_id', userId);
    if (error) throw error;
    res.json({ success: true, inventory: data.map(r => ({ ...r.store_items, purchasedAt: r.purchased_at })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


// 4. إضافة منتج (Admin) - نسخة محدثة ذكية 🌟
async function addStoreItem(req, res) {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'File is required' });
  
  const { title, description, price, category, pathId, subjectId } = req.body;
  
  let finalTitle = title;
  let finalDesc = description;
  try {
      try { finalTitle = JSON.parse(title); } catch (e) {}
      try { finalDesc = JSON.parse(description); } catch (e) {}
  } catch(e) {}

  let finalFilePath = file.path;

  try {
    const stats = fs.statSync(finalFilePath);
    const fileSizeInBytes = stats.size;
    const mimeType = file.mimetype;

    // ✅ 1. تحديد نوع الملف للتخزين في قاعدة البيانات (DB Type)
    let dbType = 'file';
    if (mimeType === 'application/pdf') dbType = 'pdf';
    else if (mimeType.startsWith('image/')) dbType = 'image';
    else if (mimeType.startsWith('video/')) dbType = 'video';
    else if (mimeType.startsWith('audio/')) dbType = 'audio';

    // ✅ 2. تحديد نوع المورد لـ Cloudinary (Resource Type)
    // Cloudinary يعامل الصوت عادة كـ video للتمكن من تشغيله
    let resourceType = 'raw';
    if (mimeType.startsWith('image/')) resourceType = 'image';
    else if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) resourceType = 'video';
    else if (mimeType === 'application/pdf') resourceType = 'image'; // خدعة الـ PDF للتنقل بين الصفحات

    // الرفع
    const uploadResult = await cloudinary.uploader.upload(finalFilePath, { 
        folder: 'edustore_products', 
        resource_type: resourceType,
        // PDF فقط يحتاج flags attachment للحفاظ عليه كمستند
        flags: mimeType === 'application/pdf' ? "attachment" : undefined 
    });

    // ✅ 3. توليد الصور المصغرة (Thumbnails) بذكاء
    let thumbnailUrl = null;
    let previewImages = [];

    if (dbType === 'image') {
        thumbnailUrl = uploadResult.secure_url;
        previewImages.push(uploadResult.secure_url);
    } 
    else if (dbType === 'video') {
        // Cloudinary يولد تلقائياً jpg للفيديو بتغيير الامتداد
        thumbnailUrl = uploadResult.secure_url.replace(/\.[^/.]+$/, ".jpg");
    }
    else if (dbType === 'audio') {
        // للصوت، لا يوجد صورة، يمكننا وضع رابط صورة افتراضية أو تركه null والفرونت يضع أيقونة
        thumbnailUrl = null; 
    }
    else if (dbType === 'pdf') {
        const baseUrl = uploadResult.secure_url;
        thumbnailUrl = baseUrl.replace('.pdf', '.jpg');
        // توليد معاينة للصفحات
        const publicId = uploadResult.public_id;
        for (let i = 1; i <= 5; i++) {
            const imageUrl = cloudinary.url(publicId, {
                resource_type: 'image',
                format: 'jpg',
                page: i,
                transformation: [{ width: 800, quality: "auto" }]
            });
            previewImages.push(imageUrl);
        }
    }

    // 4. الحفظ في قاعدة البيانات
    const { data, error } = await supabase.from('store_items').insert({
        title: finalTitle,
        description: finalDesc,
        price: parseInt(price) || 0,
        file_url: uploadResult.secure_url,
        file_size: fileSizeInBytes,
        category: category || 'general',
        path_id: pathId || null,
        subject_id: subjectId || null,
        is_active: true,
        
        // البيانات الجديدة
        thumbnail_url: thumbnailUrl,
        preview_images: previewImages,
        
        // ✅ هنا نضع النوع الحقيقي بدلاً من تثبيته على pdf
        type: dbType, 
        
        pages_count: previewImages.length > 0 ? previewImages.length : null 
    }).select().single();

    if (error) throw error;
    
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    
    res.json({ success: true, item: data });

  } catch (err) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error("Admin Upload Error:", err);
    res.status(500).json({ error: err.message });
  }
}
// 5. جلب العناصر المتوفرة فقط
async function getAvailableItems(req, res) {
    try {
      const userId = req.user?.id;
      const { data: owned } = await supabase.from('user_inventory').select('item_id').eq('user_id', userId);
      const ownedIds = owned.map(i => i.item_id);
  
      let query = supabase.from('store_items').select('*').eq('is_active', true);
      if (ownedIds.length > 0) query = query.not('id', 'in', `(${ownedIds.join(',')})`);
  
      const { data: items, error } = await query;
      if (error) throw error;
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
}

// 6. حذف من المكتبة
async function removeFromInventory(req, res) {
    const userId = req.user?.id;
    const { itemId } = req.params;
    try {
      await supabase.from('user_inventory').delete().eq('user_id', userId).eq('item_id', itemId);
      res.json({ success: true, message: 'Removed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
}

// 7. قراءة المحتوى
async function getItemContent(req, res) {
    const userId = req.user?.id;
    const { itemId } = req.params;
    try {
        const { data: item, error } = await supabase.from('store_items').select('*').eq('id', itemId).single();
        if (error) throw error;
        res.json({ success: true, content: item.content, fileUrl: item.file_url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// Helpers
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

module.exports = {
    getStoreItems,
    purchaseItem,
    getMyInventory,
    addStoreItem,
    getAvailableItems,
    removeFromInventory,
    getItemContent
};
