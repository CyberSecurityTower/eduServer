// controllers/leaderController.js
'use strict';

const supabase = require('../services/data/supabase');
const { sendUserNotification } = require('../services/data/helpers');
const logger = require('../utils/logger');

/**
 * 📢 Broadcast Message
 * إرسال إشعار لجميع طلاب الفوج الخاص بالليدر فقط
 */
async function broadcastToGroup(req, res) {
  const { title, message } = req.body;
  const { groupId, id: leaderId } = req.leaderProfile;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required.' });
  }

  try {
    // 1. جلب طلاب الفوج فقط (Security by filtering)
    // نستثني الليدر نفسه من الإشعار
    const { data: members, error } = await supabase
      .from('users')
      .select('id, fcm_token')
      .eq('group_id', groupId)
      .neq('id', leaderId);

    if (error) throw error;

    if (!members || members.length === 0) {
      return res.status(404).json({ error: 'No members found in your group.' });
    }

    logger.info(`📢 Leader ${leaderId} broadcasting to Group ${groupId} (${members.length} users)`);

    // 2. إرسال الإشعارات (Batch Processing)
    // نستخدم Promise.all لضمان السرعة، ونستخدم دالة المساعدة لضمان تسجيل الإشعار في Inbox كل طالب
    const notifyPromises = members.map(member => {
        return sendUserNotification(member.id, {
            title: `📢 تنبيه من الليدر: ${title}`,
            message: message,
            type: 'system', // أو نوع جديد 'leader_announcement'
            meta: { 
                sentBy: leaderId,
                groupId: groupId
            }
        }, member.fcm_token); // نمرر التوكن إذا كان موجوداً لتجنب الاستعلام مرة أخرى
    });

    // لا ننتظر انتهاء الإرسال لتجنب تأخير الاستجابة (Fire & Forget جزئي)
    Promise.allSettled(notifyPromises).then(() => {
        logger.success(`✅ Broadcast completed for group ${groupId}`);
    });

    return res.status(200).json({ 
        success: true, 
        message: `Notification queued for ${members.length} students.`,
        target_group: groupId
    });

  } catch (err) {
    logger.error('Broadcast Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 📅 Update Schedule
 * تعديل حصة في الجدول (يجب التأكد أن الحصة تابعة لفوج الليدر)
 */
async function updateScheduleItem(req, res) {
  const { scheduleId } = req.params;
  const updates = req.body; // { room, start_time, type, etc... }
  const { groupId } = req.leaderProfile;

  try {
    // 1. الأمن أولاً: هل هذه الحصة تابعة لفوج هذا الليدر؟
    const { data: scheduleItem, error: fetchError } = await supabase
        .from('group_schedules')
        .select('group_id')
        .eq('id', scheduleId)
        .single();

    if (fetchError || !scheduleItem) {
        return res.status(404).json({ error: 'Schedule item not found.' });
    }

    // 2. نقطة التحقق الحاسمة (The Gatekeeper Check)
    if (scheduleItem.group_id !== groupId) {
        logger.warn(`🚨 Security Alert: Leader of ${groupId} tried to edit schedule of ${scheduleItem.group_id}`);
        return res.status(403).json({ error: 'You can only edit schedules for your own group.' });
    }

    // 3. التنفيذ الآمن
    const { data, error } = await supabase
        .from('group_schedules')
        .update(updates)
        .eq('id', scheduleId)
        .select()
        .single();

    if (error) throw error;

    return res.json({ success: true, data });

  } catch (err) {
    logger.error('Update Schedule Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 📝 Create Exam
 * إنشاء امتحان للفوج
 */
async function createGroupExam(req, res) {
    const { subjectId, examDate, type, roomAllocation } = req.body;
    const { groupId } = req.leaderProfile;

    if (!subjectId || !examDate) {
        return res.status(400).json({ error: 'Subject ID and Date are required.' });
    }

    try {
        // 1. نحتاج معرف المسار (Path ID) لأن جدول الامتحانات يعتمد عليه
        const { data: groupData } = await supabase
            .from('study_groups')
            .select('path_id')
            .eq('id', groupId)
            .single();
            
        if (!groupData) throw new Error('Group path not found');

        // 2. إدراج الامتحان
        // ملاحظة: بما أن جدول الامتحانات يستخدم path_id، هذا الامتحان سيظهر لكل الفوج
        // إذا كنت تريد تخصيصه للفوج فقط، يجب إضافة rooms_allocation في الـ metadata
        const { data, error } = await supabase
            .from('exams')
            .insert({
                path_id: groupData.path_id,
                subject_id: subjectId,
                exam_date: examDate,
                type: type || 'DS', // Devoir Surveillé
                created_at: new Date().toISOString(),
                // نخزن تخصيص القاعات إذا وجد، ونربطه بالفوج
                rooms_allocation: roomAllocation ? { [groupId]: roomAllocation } : null
            })
            .select()
            .single();

        if (error) throw error;

        // 3. إشعار الطلاب بوجود امتحان جديد (اختياري)
        // يمكن استدعاء broadcastToGroup داخلياً هنا

        res.status(201).json({ success: true, exam: data });

    } catch (err) {
        logger.error('Create Exam Error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
  broadcastToGroup,
  updateScheduleItem,
  createGroupExam
};
