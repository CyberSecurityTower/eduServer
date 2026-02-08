// middleware/verifyLeader.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

async function verifyLeader(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: No user session.' });
    }

    // 1. جلب بيانات البروفايل الحقيقية من الداتابايز (لضمان عدم تزوير التوكن)
    const { data: profile, error } = await supabase
      .from('users')
      .select('role, group_id')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(403).json({ error: 'Access denied: User profile not found.' });
    }

    // 2. التحقق من الرتبة
    // نفترض أن الرتبة في الداتابايز هي 'leader' أو 'admin' (الآدمن يملك صلاحيات الليدر)
    if (profile.role !== 'leader' && profile.role !== 'admin') {
      logger.warn(`⛔ Access blocked for user ${userId}: Not a leader.`);
      return res.status(403).json({ error: 'Forbidden: Leaderspace access only.' });
    }

    // 3. التحقق من تعيين الفوج
    if (!profile.group_id) {
      return res.status(400).json({ error: 'Configuration Error: Leader has no assigned group.' });
    }

    // 4. حقن بيانات الليدر في الطلب لاستخدامها في الكونترولر
    req.leaderProfile = {
      id: userId,
      role: profile.role,
      groupId: profile.group_id
    };

    next();

  } catch (err) {
    logger.error('Leader Middleware Error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = verifyLeader;
