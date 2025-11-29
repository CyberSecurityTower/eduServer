// services/ai/managers/groupManager.js
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');
const { calculateVoteWeight } = require('./reputationManager');

async function getGroupMemory(groupId) {
  if (!groupId) return null;
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  return data?.shared_knowledge || {};
}

async function updateGroupKnowledge(groupId, userId, factType, key, value) {
  if (!groupId || !userId) return;

  // 1. جلب البيانات الحالية
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  let knowledge = data?.shared_knowledge || {};

  // تهيئة الهيكل
  if (!knowledge[factType]) knowledge[factType] = {};
  if (!knowledge[factType][key]) knowledge[factType][key] = { candidates: {}, is_verified: false };

  const entry = knowledge[factType][key];

  // 🔒 GOD MODE CHECK: إذا كانت المعلومة مثبتة من الأدمين، لا أحد يغيرها إلا الأدمين
  const voteWeight = await calculateVoteWeight(userId);
  const isGod = voteWeight >= 1000;

  if (entry.is_verified && !isGod) {
      console.log(`🛡️ Blocked update: Fact '${key}' is verified by Admin.`);
      return { blocked: true };
  }

  // 2. تسجيل التصويت
  if (!entry.candidates[value]) entry.candidates[value] = 0;
  entry.candidates[value] += voteWeight;

  // 3. تحديد الفائز
  let winnerValue = null;
  let maxVotes = 0;
  Object.entries(entry.candidates).forEach(([val, votes]) => {
      if (votes > maxVotes) {
          maxVotes = votes;
          winnerValue = val;
      }
  });

  // تحديث القيم النهائية
  entry.confirmed_value = winnerValue;
  entry.confidence_score = maxVotes;
  
  // إذا كان الأدمين هو من صوت، نثبت المعلومة فوراً
  if (isGod) {
      entry.is_verified = true;
      entry.candidates = { [value]: 1000 }; // مسح باقي الآراء الخاطئة
  }

  // 4. الحفظ
  await supabase.from('study_groups').update({ 
      shared_knowledge: knowledge,
      updated_at: nowISO()
  }).eq('id', groupId);

  return { success: true, winnerValue, isVerified: entry.is_verified };
}

module.exports = { getGroupMemory, updateGroupKnowledge };
