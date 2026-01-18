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
async function addStoreItem(req, res) {
  const file = req.file;
  // نستقبل المحتوى (content) من الـ Body
  const { title, description, price, category, content } = req.body;

  if (!file) return res.status(400).json({ error: 'File is required' });

  try {
    // 1. رفع الملف إلى Cloudinary
    // resource_type: 'auto' يسمح برفع PDF, Images, Video
    const uploadResult = await cloudinary.uploader.upload(file.path, {
        folder: 'edustore_products',
        resource_type: 'auto',
        use_filename: true,
        unique_filename: true,
        access_mode: 'public' // لضمان أن الرابط مباشر وقابل للوصول
    });

    // الرابط المباشر هو secure_url
    const directFileUrl = uploadResult.secure_url;

    // 2. الحفظ في قاعدة البيانات
    const { data, error } = await supabase.from('store_items').insert({
        title,
        description,
        price: parseInt(price) || 0,
        file_url: directFileUrl, //  الرابط المباشر
        content: content || null, // المحتوى النصي (يدوياً حالياً)
        category: category || 'general',
        is_active: true
    }).select().single();

    if (error) throw error;

    // 3. تنظيف الملف المؤقت
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    logger.success(`📦 Store Item Added: ${title} (Has Content: ${!!content})`);
    res.json({ success: true, item: data });

  } catch (err) {
    logger.error('Add Store Item Error:', err.message);
    // محاولة حذف الملف المؤقت في حال الفشل
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
module.exports = {
  getStoreItems,
  purchaseItem,
  getMyInventory,
  addStoreItem,
  getItemContent
};
