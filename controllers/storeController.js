// controllers/storeController.js
'use strict';

const supabase = require('../services/data/supabase');
const sourceManager = require('../services/media/sourceManager');
const logger = require('../utils/logger');
const cloudinary = require('../config/cloudinary'); 
const sharp = require('sharp');
const path = require('path');
const fs = require('fs'); // 👈👈👈 هذا هو السطر المفقود! أضفه هنا

// ... (باقي الدوال getStoreItems, purchaseItem, getMyInventory كما هي) ...

// 1. جلب قائمة المتجر (للمستخدم)
async function getStoreItems(req, res) {
  try {
    const userId = req.user?.id;
    
    // 1. معرفة تخصص الطالب الحالي
    // نجلب selected_path_id من جدول users
    const { data: userProfile } = await supabase
        .from('users')
        .select('selected_path_id')
        .eq('id', userId)
        .single();

    const userPath = userProfile?.selected_path_id;

    // 2. بناء استعلام ذكي
    let query = supabase
      .from('store_items')
      .select('*')
      .eq('is_active', true);

    // المنطق:
    // اعرض الملفات التي تتبع تخصص الطالب (path_id = userPath)
    // أو الملفات العامة التي ليس لها تخصص (path_id IS NULL)
    if (userPath) {
        query = query.or(`path_id.eq.${userPath},path_id.is.null`);
    } else {
        // إذا الطالب لم يختر تخصصاً بعد، اعرض له العام فقط
        query = query.is('path_id', null);
    }
    
    // (اختياري) الفلترة حسب المادة إذا أرسلها الفرونت إند
    // مثلاً: المستخدم دخل لمتجر مادة "الفيزياء" ويريد ملفاتها فقط
    if (req.query.subjectId) {
        query = query.eq('subject_id', req.query.subjectId);
    }

    const { data: items, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    // 3. التحقق من الملكية (كما كان سابقاً)
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

// 3. جلب مكتبة المستخدم
async function getMyInventory(req, res) {
  const userId = req.user?.id;
  try {
    const { data, error } = await supabase
      .from('user_inventory')
      .select(`purchased_at, store_items (*)`)
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false });

    if (error) throw error;

    const inventory = data.map(row => ({
      ...row.store_items,
      purchasedAt: row.purchased_at
    }));

    res.json({ success: true, inventory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 4. (Admin) إضافة منتج جديد (المصححة)
async function addStoreItem(req, res) {
  const file = req.file;
  const { title, description, price, category, content, type, metadata, pathId, subjectId, lessonId } = req.body;

  if (!file) return res.status(400).json({ error: 'File is required' });

  let finalFilePath = file.path;
  let isCompressed = false;

  try {
    // 🔥 ضغط الصور
    if (file.mimetype.startsWith('image/')) {
        const compressedPath = path.join(path.dirname(file.path), `compressed-${file.filename}`);
        
        await sharp(file.path)
            .resize(1200, null, { withoutEnlargement: true })
            .jpeg({ quality: 80, mozjpeg: true })
            .toFile(compressedPath);

        finalFilePath = compressedPath;
        isCompressed = true;
        
        // (اختياري) طباعة التوفير
        // نستخدم fs هنا بأمان الآن
        const originalSize = file.size;
        const newSize = fs.statSync(compressedPath).size;
        console.log(`📉 Image Compressed: ${(originalSize/1024).toFixed(2)}KB -> ${(newSize/1024).toFixed(2)}KB`);
    }

    // 1. حساب حجم الملف
    const stats = fs.statSync(finalFilePath);
    const fileSizeFormatted = formatBytes(stats.size);

    // 2. الرفع إلى Cloudinary
    const uploadResult = await cloudinary.uploader.upload(finalFilePath, {
        folder: 'edustore_products',
        resource_type: 'auto',
        access_mode: 'public',
        image_metadata: true
    });

    // 3. استخراج البيانات
    let pagesCount = 0;
    let previewImages = [];
    
    if (uploadResult.format === 'pdf' || (type && type === 'pdf')) {
        pagesCount = uploadResult.pages || 0;
        if (pagesCount > 0) {
            previewImages = generatePreviewUrls(uploadResult.public_id, uploadResult.version, pagesCount);
        }
    } else if (uploadResult.resource_type === 'image') {
        pagesCount = 1;
        previewImages = [uploadResult.secure_url];
    }

    // 4. Thumbnail
    let derivedThumbnail = uploadResult.secure_url;
    if (uploadResult.format === 'pdf') {
        derivedThumbnail = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/w_400,f_jpg,q_auto,pg_1/v${uploadResult.version}/${uploadResult.public_id}.jpg`;
    }

    // 5. الحفظ في DB
    const { data, error } = await supabase.from('store_items').insert({
        title,
        description,
        price: parseInt(price) || 0,
        file_url: uploadResult.secure_url,
        file_size: fileSizeFormatted,
        pages_count: pagesCount,
        preview_images: previewImages,
        thumbnail_url: derivedThumbnail,
        content: content || null,
        category: category || 'general',
        type: type || (uploadResult.format === 'pdf' ? 'pdf' : 'image'),
        metadata: metadata ? JSON.parse(metadata) : {},
        path_id: pathId || null,       // إذا لم يرسل، يكون عاماً (null)
        subject_id: subjectId || null, // اختياري
        lesson_id: lessonId || null,   // اختياري
        is_active: true
    }).select().single();

    if (error) throw error;

    // التنظيف (Clean up)
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    if (isCompressed && fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
     
    logger.success(`📦 Added Pro Item: ${title} (${pagesCount} pages, ${fileSizeFormatted})`);
    res.json({ success: true, item: data });

  } catch (err) {
    logger.error('Add Store Item Error:', err.message);
    // التنظيف في حال الخطأ
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    if (isCompressed && fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);   
    res.status(500).json({ error: err.message });
  }
}

// 5. قراءة المحتوى
async function getItemContent(req, res) {
    const userId = req.user?.id;
    const { itemId } = req.params;

    try {
        const { data: inventory } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('user_id', userId)
            .eq('item_id', itemId)
            .single();

        const isAdmin = req.user?.role === 'admin' || req.isAdmin;

        if (!inventory && !isAdmin) {
            return res.status(403).json({ error: 'You need to buy this item first.' });
        }

        const { data: item, error } = await supabase
            .from('store_items')
            .select('content, file_url, title')
            .eq('id', itemId)
            .single();

        if (error || !item) return res.status(404).json({ error: 'Item not found' });

        res.json({ 
            success: true, 
            content: item.content,
            fileUrl: item.file_url,
            title: item.title 
        });

    } catch (err) {
        logger.error('Get Item Content Error:', err.message);
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

function generatePreviewUrls(publicId, version, pageCount) {
    const previews = [];
    const maxPreviews = Math.min(pageCount, 5);
    for (let i = 1; i <= maxPreviews; i++) {
        const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/w_600,f_jpg,q_auto,pg_${i}/v${version}/${publicId}.jpg`;
        previews.push(url);
    }
    return previews;
}

module.exports = {
  getStoreItems,
  purchaseItem,
  getMyInventory,
  addStoreItem,
  getItemContent
};
