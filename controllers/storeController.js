// controllers/storeController.js
'use strict';

const supabase = require('../services/data/supabase');
const sourceManager = require('../services/media/sourceManager'); // سنستخدمه لرفع الملفات
const logger = require('../utils/logger');
const cloudinary = require('../config/cloudinary'); 
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


/**
 * 4. (Admin) إضافة منتج جديد
 * التحديث: يستقبل المحتوى النصي يدوياً + يرفع الملف للكلاوديناري
 */

/**
 * 4. (Admin) إضافة منتج جديد (نسخة المحترفين)
 */
async function addStoreItem(req, res) {
  const file = req.file;
  const { title, description, price, category, content, type, metadata } = req.body;

  if (!file) return res.status(400).json({ error: 'File is required' });

  try {
    // 1. حساب حجم الملف
    const fileSizeFormatted = formatBytes(file.size);

    // 2. الرفع إلى Cloudinary
    const uploadResult = await cloudinary.uploader.upload(file.path, {
        folder: 'edustore_products',
        resource_type: 'auto',
        access_mode: 'public',
        image_metadata: true // ✅ مهم جداً: نطلب من كلاوديناري قراءة بيانات الملف (عدد الصفحات)
    });

    // 3. استخراج البيانات الذكية
    let pagesCount = 0;
    let previewImages = [];
    
    // إذا كان ملف PDF، كلاوديناري يرجع عدد الصفحات في الحقل 'pages'
    if (uploadResult.format === 'pdf' || (type && type === 'pdf')) {
        pagesCount = uploadResult.pages || 0;
        
        // توليد صور المعاينة (أول 5 صفحات)
        if (pagesCount > 0) {
            previewImages = generatePreviewUrls(uploadResult.public_id, uploadResult.version, pagesCount);
        }
    } 
    // إذا كان صورة عادية، نضع الصورة نفسها كمعاينة وحيدة
    else if (uploadResult.resource_type === 'image') {
        pagesCount = 1;
        previewImages = [uploadResult.secure_url];
    }

    // 4. إنشاء Thumbnail (صورة الغلاف) - الصفحة الأولى
    let derivedThumbnail = uploadResult.secure_url;
    if (uploadResult.format === 'pdf') {
        // نأخذ الصفحة الأولى كغلاف ونحولها لـ JPG
        derivedThumbnail = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/w_400,f_jpg,q_auto,pg_1/v${uploadResult.version}/${uploadResult.public_id}.jpg`;
    }

    // 5. الحفظ في قاعدة البيانات
    const { data, error } = await supabase.from('store_items').insert({
        title,
        description,
        price: parseInt(price) || 0,
        
        file_url: uploadResult.secure_url,
        file_size: fileSizeFormatted,   // ✅ "2.4 MB"
        pages_count: pagesCount,        // ✅ 34
        preview_images: previewImages,  // ✅ ["url_pg1", "url_pg2"...]
        thumbnail_url: derivedThumbnail, 
        
        content: content || null,
        category: category || 'general',
        type: type || (uploadResult.format === 'pdf' ? 'pdf' : 'image'),
        metadata: metadata ? JSON.parse(metadata) : {},
        is_active: true
    }).select().single();

    if (error) throw error;

    // تنظيف
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    logger.success(`📦 Added Pro Item: ${title} (${pagesCount} pages, ${fileSizeFormatted})`);
    res.json({ success: true, item: data });

  } catch (err) {
    logger.error('Add Store Item Error:', err.message);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
}

/**
 * 5. (User) قراءة محتوى العنصر
 * هذه الدالة مهمة جداً: تسمح فقط لمن "اشترى" العنصر بقراءة الـ content
 */
async function getItemContent(req, res) {
    const userId = req.user?.id;
    const { itemId } = req.params;

    try {
        // 1. التحقق من الملكية (هل اشترى الطالب هذا الملف؟)
        // أو هل هو أدمين (للمعاينة)
        // سنفترض التحقق من الملكية أولاً
        const { data: inventory } = await supabase
            .from('user_inventory')
            .select('id')
            .eq('user_id', userId)
            .eq('item_id', itemId)
            .single();

        // تحقق إضافي: هل هو أدمين؟
        const isAdmin = req.user?.role === 'admin' || req.isAdmin;

        if (!inventory && !isAdmin) {
            return res.status(403).json({ error: 'You need to buy this item first.' });
        }

        // 2. جلب المحتوى والرابط
        const { data: item, error } = await supabase
            .from('store_items')
            .select('content, file_url, title')
            .eq('id', itemId)
            .single();

        if (error || !item) return res.status(404).json({ error: 'Item not found' });

        res.json({ 
            success: true, 
            content: item.content, // النص الكامل
            fileUrl: item.file_url, // الرابط المباشر
            title: item.title 
        });

    } catch (err) {
        logger.error('Get Item Content Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// دالة مساعدة: تحويل الحجم من بايت إلى صيغة مقروءة
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// دالة مساعدة: توليد روابط المعاينة من رابط الكلاوديناري
function generatePreviewUrls(publicId, version, pageCount) {
    const previews = [];
    const maxPreviews = Math.min(pageCount, 5); // نأخذ 5 أو أقل إذا كان الملف صغيراً

    for (let i = 1; i <= maxPreviews; i++) {
        // صيغة كلاوديناري السحرية:
        // dn_pg_[رقم الصفحة] -> لجلب الصفحة
        // f_jpg -> لتحويلها لصورة
        // q_auto -> لضغط الصورة أوتوماتيكياً
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
