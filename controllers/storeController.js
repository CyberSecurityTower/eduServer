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



// 4. [UPDATED] إضافة منتج (Admin) - نسخة محدثة ومرنة 🌟
async function addStoreItem(req, res) {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'File is required' });
  
  // 1. استخراج البيانات وتنظيفها
  const { title, description, price, category, pathId, subjectId } = req.body;
  
  // دالة مساعدة لتنظيف المعرفات (لأن FormData تحول null إلى نص "null")
  const cleanId = (id) => (!id || id === 'null' || id === 'undefined' || id === '') ? null : id;

  const finalPathId = cleanId(pathId);
  const finalSubjectId = cleanId(subjectId);

  // دالة مساعدة لتحليل JSON الآمن
  const parseJsonSafe = (str) => {
      try {
          if (typeof str === 'string' && (str.startsWith('{') || str.startsWith('"'))) {
              return JSON.parse(str);
          }
          return str;
      } catch (e) {
          return str;
      }
  };

  const finalTitle = parseJsonSafe(title);
  const finalDesc = parseJsonSafe(description);
  const finalFilePath = file.path;

  try {
    const stats = fs.statSync(finalFilePath);
    const fileSizeInBytes = stats.size;
    const mimeType = file.mimetype;

    // ✅ 2. تحديد نوع الملف (DB Type vs Cloudinary Resource Type)
    let dbType = 'file';
    let resourceType = 'raw'; // الافتراضي

    if (mimeType === 'application/pdf') {
        dbType = 'pdf';
        resourceType = 'image'; // نرفع PDF كصورة لتمكين إنشاء Thumbnails، لكن نضيف flag للتحميل
    } else if (mimeType.startsWith('image/')) {
        dbType = 'image';
        resourceType = 'image';
    } else if (mimeType.startsWith('video/')) {
        dbType = 'video';
        resourceType = 'video';
    } else if (mimeType.startsWith('audio/')) {
        dbType = 'audio';
        resourceType = 'video'; // Cloudinary يعامل الصوت كفيديو للمعالجة
    }

    // ✅ 3. الرفع إلى Cloudinary
    console.log(`📤 Uploading ${dbType} to Cloudinary...`);
    const uploadResult = await cloudinary.uploader.upload(finalFilePath, { 
        folder: 'edustore_products', 
        resource_type: resourceType,
        // لملفات PDF: هذا يجعل الرابط يحفز التحميل بدلاً من العرض المباشر كصورة
        flags: mimeType === 'application/pdf' ? "attachment" : undefined 
    });

    // ✅ 4. توليد الصور المصغرة والمعاينة (Smart Previews)
    let thumbnailUrl = null;
    let previewImages = [];

    if (dbType === 'image') {
        thumbnailUrl = uploadResult.secure_url;
        // للصورة نفسها، المعاينة هي الصورة
        previewImages.push(uploadResult.secure_url);
    } 
    else if (dbType === 'video') {
        // تغيير الامتداد إلى jpg للحصول على صورة من الفيديو
        thumbnailUrl = uploadResult.secure_url.replace(/\.[^/.]+$/, ".jpg");
    }
    else if (dbType === 'pdf') {
        // الصورة المصغرة هي الصفحة الأولى
        // نستخدم public_id لتوليد رابط صورة ثابت
        thumbnailUrl = cloudinary.url(uploadResult.public_id, {
            resource_type: 'image',
            format: 'jpg',
            page: 1,
            transformation: [{ width: 400, quality: "auto" }] // جودة متوسطة للغلاف
        });

        // توليد معاينة لأول 3 صفحات (يمكن زيادتها)
        for (let i = 1; i <= 3; i++) {
            const pageUrl = cloudinary.url(uploadResult.public_id, {
                resource_type: 'image',
                format: 'jpg',
                page: i,
                transformation: [{ width: 800, quality: "auto" }] // جودة عالية للمعاينة
            });
            previewImages.push(pageUrl);
        }
    }
    // للصوت audio نتركها null أو نضع صورة افتراضية في الفرونت إند

    // ✅ 5. الحفظ في قاعدة البيانات Supabase
    const { data, error } = await supabase.from('store_items').insert({
        title: finalTitle,
        description: finalDesc,
        price: parseInt(price) || 0,
        
        // معلومات الملف
        file_url: uploadResult.secure_url,
        file_size: fileSizeInBytes,
        type: dbType,
        
        // التصنيف والربط
        category: category || 'general',
        path_id: finalPathId,       // تم التنظيف
        subject_id: finalSubjectId, // تم التنظيف
        
        // المظهر
        thumbnail_url: thumbnailUrl,
        preview_images: previewImages,
        pages_count: previewImages.length > 0 ? previewImages.length : null,
        
        is_active: true
    }).select().single();

    if (error) throw error;
    
    // نجاح
    res.json({ success: true, item: data });

  } catch (err) {
    console.error("❌ Admin Upload Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    // ✅ 6. تنظيف الملفات المؤقتة دائماً
    if (file?.path && fs.existsSync(file.path)) {
        try {
            fs.unlinkSync(file.path);
        } catch (unlinkErr) {
            console.warn("⚠️ Failed to delete temp file:", unlinkErr.message);
        }
    }
  }
}

// 🆕 8. تحديث بيانات منتج (Admin)
async function updateStoreItem(req, res) {
    const { itemId } = req.params;
    const { title, description, price, isActive, pathId } = req.body;

    try {
        const updates = {};
        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (price !== undefined) updates.price = parseInt(price);
        if (isActive !== undefined) updates.is_active = isActive;
        if (pathId !== undefined) updates.path_id = pathId;

        const { data, error } = await supabase
            .from('store_items')
            .update(updates)
            .eq('id', itemId)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, item: data, message: 'Item updated successfully' });

    } catch (err) {
        logger.error('Update Store Item Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// 🆕 9. حذف منتج نهائياً (Admin)
async function deleteStoreItem(req, res) {
    const { itemId } = req.params;

    try {
        // 1. جلب رابط الملف ونوعه من قاعدة البيانات قبل الحذف
        // نحتاج النوع (type) لمعرفة هل نحذفه كـ image أم video أم raw من كلاوديناري
        const { data: item, error: fetchError } = await supabase
            .from('store_items')
            .select('file_url, type') 
            .eq('id', itemId)
            .single();

        if (fetchError || !item) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // 2. حذف الملف من Cloudinary (إذا وجد الرابط)
        if (item.file_url) {
            try {
                // استخراج public_id من الرابط
                // مثال الرابط: https://res.cloudinary.com/.../upload/v12345/edustore_products/filename.pdf
                const urlParts = item.file_url.split('/');
                const uploadIndex = urlParts.indexOf('upload');
                
                if (uploadIndex !== -1) {
                    // نتخطى 'upload' و 'v1234' (رقم الإصدار)
                    // النتيجة تكون: edustore_products/filename.pdf
                    const pathParts = urlParts.slice(uploadIndex + 2);
                    let publicIdWithExt = pathParts.join('/');
                    
                    // إزالة الامتداد (.pdf, .jpg) للحصول على public_id الصافي
                    // Cloudinary destroy API يتطلب public_id بدون امتداد (للصور والفيديو)
                    let publicId = publicIdWithExt.substring(0, publicIdWithExt.lastIndexOf('.'));

                    // تحديد نوع المورد (Resource Type) بناءً على ما خزنناه في الداتابيز
                    let resourceType = 'image'; // الافتراضي (الـ PDF يُرفع كـ image عادة)
                    
                    if (item.type === 'video' || item.type === 'audio') {
                        resourceType = 'video';
                    } else if (item.type === 'file') {
                        resourceType = 'raw';
                        // للملفات الخام (Raw)، أحياناً يتطلب الأمر الإبقاء على الامتداد، لكن الغالب بدون
                    }

                    console.log(`🗑️ Deleting Cloudinary Asset: ${publicId} [${resourceType}]`);
                    
                    await cloudinary.uploader.destroy(publicId, { 
                        resource_type: resourceType,
                        invalidate: true // مسح الكاش من CDN
                    });
                }
            } catch (cloudErr) {
                // نسجل الخطأ لكن لا نوقف العملية، الأهم حذف السجل من الداتابيز
                logger.error(`⚠️ Cloudinary Delete Warning: ${cloudErr.message}`);
            }
        }

        // 3. الحذف من قاعدة البيانات
        const { error } = await supabase
            .from('store_items')
            .delete()
            .eq('id', itemId);

        if (error) throw error;

        res.json({ success: true, message: 'Item deleted permanently (DB + Cloud Asset)' });

    } catch (err) {
        logger.error('Delete Store Item Error:', err.message);
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
    getItemContent,
    updateStoreItem,
    deleteStoreItem  
};
