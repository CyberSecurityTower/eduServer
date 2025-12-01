
// services/ai/eduNexus.js
'use strict';

const supabase = require('../data/supabase');
const { nowISO } = require('../data/dbUtils');
const { calculateVoteWeight } = require('../ai/managers/reputationManager');
const CONFIG = require('../../config'); // استيراد الكونفيج

// جلب بيانات النكسوس
async function getNexusMemory(groupId) {
  if (!CONFIG.ENABLE_EDUNEXUS) return {};
  if (!groupId) return null;
  
  console.log(`🔍 EduNexus: Fetching memory for group ${groupId}...`); // LOG

  const { data, error } = await supabase
    .from('study_groups')
    .select('shared_knowledge')
    .eq('id', groupId)
    .single();

  if (error) {
    console.error('❌ EduNexus Error:', error.message);
    return {};
  }

  if (!data || !data.shared_knowledge) {
    console.warn('⚠️ EduNexus: No shared knowledge found (Empty).');
    return {};
  }

  console.log('✅ EduNexus Data Found:', JSON.stringify(data.shared_knowledge).substring(0, 100)); // LOG
  return data.shared_knowledge;
}

// تحديث النكسوس (مع منطق التصويت)

async function updateNexusKnowledge(groupId, userId, factType, key, value) {
  if (!CONFIG.ENABLE_EDUNEXUS) return { success: false, reason: 'disabled' }; 
  if (!groupId || !userId) return;

  console.log(`📝 EduNexus Update: Group=${groupId}, Type=${factType}, Key=${key}, Value=${value}`);

  // 1. جلب البيانات الحالية
  const { data } = await supabase.from('study_groups').select('shared_knowledge').eq('id', groupId).single();
  let knowledge = data?.shared_knowledge || {};

  // 2. تهيئة الهيكل إذا كان فارغاً
  if (!knowledge[factType]) knowledge[factType] = {};
  if (!knowledge[factType][key]) {
      knowledge[factType][key] = { 
          candidates: {}, 
          confirmed_value: null,
          confidence_score: 0,
          is_verified: false 
      };
  }

  const entry = knowledge[factType][key];
  
  // 3. حساب قوة الصوت
  const voteWeight = await calculateVoteWeight(userId);
  
  // 4. إضافة الصوت
  if (!entry.candidates[value]) entry.candidates[value] = 0;
  entry.candidates[value] += voteWeight;

  // 5. تحديد الفائز (الأكثر تصويتاً)
  let winnerValue = null;
  let maxVotes = 0;
  Object.entries(entry.candidates).forEach(([val, votes]) => {
      if (votes > maxVotes) {
          maxVotes = votes;
          winnerValue = val;
      }
  });

  // تحديث القيمة المعتمدة
  entry.confirmed_value = winnerValue;
  entry.confidence_score = maxVotes;
  
  // إذا كان المستخدم Admin، يتم التوثيق فوراً
  if (voteWeight >= 1000) {
      entry.is_verified = true;
  }

  // 6. الحفظ في Supabase
  const { error } = await supabase.from('study_groups').update({ 
      shared_knowledge: knowledge,
      last_updated_at: new Date().toISOString()
  }).eq('id', groupId);

  if (error) {
      console.error("❌ Failed to update EduNexus:", error.message);
      return { success: false };
  }

  console.log("✅ EduNexus Updated Successfully!");
  return { success: true, winnerValue, isVerified: entry.is_verified };
}

module.exports = { getNexusMemory, updateNexusKnowledge };
