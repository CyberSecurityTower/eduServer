
// services/ai/managers/groupManager.js
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');

// جلب الذاكرة المشتركة للفوج
async function getGroupMemory(groupId) {
  if (!groupId) return null;
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  return data?.shared_knowledge || {};
}

// تحديث الذاكرة المشتركة (مع منطق التصويت)
async function updateGroupKnowledge(groupId, factType, key, value) {
  if (!groupId) return;

  // 1. جلب البيانات الحالية
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  let knowledge = data?.shared_knowledge || {};

  // تهيئة الهيكل إذا لم يكن موجوداً
  if (!knowledge[factType]) knowledge[factType] = {};
  if (!knowledge[factType][key]) knowledge[factType][key] = { candidates: {} };

  // 2. منطق التصويت (Voting Logic)
  const entry = knowledge[factType][key]; // مثلاً exams -> economics
  
  // زيادة التصويت للقيمة الجديدة
  if (!entry.candidates[value]) {
      entry.candidates[value] = 1;
  } else {
      entry.candidates[value]++;
  }

  // 3. تحديد القيمة الفائزة (الأكثر تكراراً)
  let winnerValue = null;
  let maxVotes = 0;
  let conflictDetected = false;

  Object.entries(entry.candidates).forEach(([val, votes]) => {
      if (votes > maxVotes) {
          maxVotes = votes;
          winnerValue = val;
      }
  });

  // كشف التضارب: هل هناك قيمة أخرى قريبة جداً في عدد الأصوات؟
  const totalVotes = Object.values(entry.candidates).reduce((a, b) => a + b, 0);
  if (totalVotes > 3 && maxVotes / totalVotes < 0.6) {
      conflictDetected = true; // تضارب قوي (مثلاً 4 يقولون 12 و 3 يقولون 15)
  }

  // تحديث الحالة النهائية
  entry.confirmed_value = winnerValue;
  entry.confidence_score = maxVotes;
  entry.has_conflict = conflictDetected;

  // 4. الحفظ في الداتابيز
  await supabase.from('study_groups').update({ 
      shared_knowledge: knowledge,
      last_updated_at: nowISO()
  }).eq('id', groupId);

  return { conflictDetected, winnerValue };
}

module.exports = { getGroupMemory, updateGroupKnowledge };
