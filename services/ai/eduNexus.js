// services/ai/eduNexus.js
'use strict';

const supabase = require('../../data/supabase');
const { nowISO } = require('../../data/dbUtils');
const { calculateVoteWeight } = require('./managers/reputationManager'); // تأكد من المسار

// جلب بيانات النكسوس (الذاكرة المشتركة)
async function getNexusMemory(groupId) {
  if (!groupId) return null;
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  return data?.shared_knowledge || {};
}

// تحديث النكسوس (مع منطق التصويت)
async function updateNexusKnowledge(groupId, userId, factType, key, value) {
  if (!groupId || !userId) return;

  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  let knowledge = data?.shared_knowledge || {};

  if (!knowledge[factType]) knowledge[factType] = {};
  if (!knowledge[factType][key]) knowledge[factType][key] = { candidates: {}, is_verified: false };

  const entry = knowledge[factType][key];
  const voteWeight = await calculateVoteWeight(userId);
  const isGod = voteWeight >= 1000;

  if (entry.is_verified && !isGod) return { blocked: true };

  if (!entry.candidates[value]) entry.candidates[value] = 0;
  entry.candidates[value] += voteWeight;

  let winnerValue = null;
  let maxVotes = 0;
  Object.entries(entry.candidates).forEach(([val, votes]) => {
      if (votes > maxVotes) {
          maxVotes = votes;
          winnerValue = val;
      }
  });

  entry.confirmed_value = winnerValue;
  entry.confidence_score = maxVotes;
  
  if (isGod) {
      entry.is_verified = true;
      entry.candidates = { [value]: 1000 };
  }

  await supabase.from('study_groups').update({ 
      shared_knowledge: knowledge,
      updated_at: nowISO()
  }).eq('id', groupId);

  return { success: true, winnerValue, isVerified: entry.is_verified };
}

module.exports = { getNexusMemory, updateNexusKnowledge };
