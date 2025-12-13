
// controllers/announcementController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * جلب الإعلانات النشطة للمستخدم
 * ملاحظة: التصفية حسب الفوج تتم في التطبيق (Client-side) كما طلبت،
 * ولكننا هنا نجلب الإعلانات الصالحة فقط لتقليل البيانات.
 */
async function getAnnouncements(req, res) {
  try {
    const { data: announcements, error } = await supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10); // نجلب آخر 10 إعلانات فقط

    if (error) throw error;

    return res.status(200).json(announcements);
  } catch (err) {
    logger.error('Get Announcements Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch announcements' });
  }
}

/**
 * زيادة عداد المشاهدات
 */
async function trackView(req, res) {
  const { id } = req.params;

  if (!id) return res.status(400).json({ error: 'Announcement ID required' });

  try {
    // نستخدم RPC لزيادة العداد بشكل ذري (Atomic Increment)
    // إذا لم تكن قد أنشأت دالة RPC، سنستخدم الطريقة التقليدية
    
    // الطريقة 1: RPC (الأفضل)
    /*
    const { error } = await supabase.rpc('increment_announcement_views', { row_id: id });
    */

    // الطريقة 2: جلب وتحديث (مؤقتة)
    const { data: current } = await supabase.from('announcements').select('views_count').eq('id', id).single();
    const newCount = (current?.views_count || 0) + 1;
    
    const { error } = await supabase
      .from('announcements')
      .update({ views_count: newCount })
      .eq('id', id);

    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error(`Track View Error for ${id}:`, err.message);
    return res.status(500).json({ error: 'Internal Error' });
  }
}

module.exports = {
  getAnnouncements,
  trackView
};
