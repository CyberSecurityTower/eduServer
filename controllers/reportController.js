// controllers/reportController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * إرسال بلاغ عن محتوى (درس أو رسالة)
 */
async function submitContentReport(req, res) {
  const userId = req.user?.id; // نأخذ المعرف من التوكن الموثق
  const { lessonId, reason, messageContent } = req.body;

  if (!reason || !messageContent) {
    return res.status(400).json({ error: 'Reason and message content are required.' });
  }

  try {
    // إدراج البيانات في جدول content_reports
    const { data, error } = await supabase
      .from('content_reports')
      .insert({
        user_id: userId,
        // ملاحظة: تأكد من اسم العمود في قاعدة بياناتك (هل هو lesson_id أم مجرد metadata)
        // بناءً على الصورة، الجدول يحتوي على id, user_id, message_content, reason, created_at
        // سنضيف الـ lessonId داخل حقل الـ reason أو message إذا لم يوجد عمود مخصص، 
        // لكن الأفضل إضافته كعمود إذا كان موجوداً.
        message_content: messageContent,
        reason: reason,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    logger.warn(`🚩 New Content Report by User ${userId}: [${reason}]`);

    return res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Thank you for your feedback.',
      reportId: data.id
    });

  } catch (err) {
    logger.error('Submit Content Report Error:', err.message);
    return res.status(500).json({ error: 'Failed to submit report. Please try again later.' });
  }
}

module.exports = { submitContentReport };
