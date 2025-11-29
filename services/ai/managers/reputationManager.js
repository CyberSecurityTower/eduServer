// services/ai/managers/reputationManager.js
'use strict';

const supabase = require('../../data/supabase');

/**
 * حساب قوة الصوت (Vote Weight)
 * Admin = 1000 (كلمة مسموعة فوراً)
 * Legend = 10
 * Délégué = Score + Bonus (2)
 * Newbie = 1
 */
async function calculateVoteWeight(userId) {
  const { data: user } = await supabase
    .from('users')
    .select('reputation_score, role')
    .eq('id', userId)
    .single();

  if (!user) return 1;

  // 👑 GOD MODE: أنت (الأدمين)
  if (user.role === 'admin') return 1000;

  let score = user.reputation_score || 10;
  let weight = 1;

  // الرتب العادية
  if (score < 50) weight = 1;       // Newbie
  else if (score < 200) weight = 3; // Active
  else if (score < 500) weight = 5; // Trusted
  else weight = 10;                 // Legend

  // 📢 Délégué Bonus (دفعة بسيطة لكن ليست حصانة)
  if (user.role === 'delegue') {
      weight += 2; 
  }

  return weight;
}

/**
 * تعديل النقاط (مكافأة أو عقاب)
 */
async function adjustReputation(userId, amount, reason) {
  const { data: user } = await supabase.from('users').select('reputation_score, role').eq('id', userId).single();
  if (!user) return;

  // الأدمين لا تتغير نقاطه
  if (user.role === 'admin') return;

  let finalAmount = amount;

  // عقاب مضاعف للديليغي إذا أخطأ (لأنه مسؤول)
  if (user.role === 'delegue' && amount < 0) {
      finalAmount = amount * 1.5;
  }

  let newScore = (user.reputation_score || 10) + finalAmount;
  if (newScore < 0) newScore = 0;

  await supabase.from('users').update({ reputation_score: newScore }).eq('id', userId);
  console.log(`⚖️ Reputation: User ${userId} -> ${finalAmount} (${reason})`);
}

module.exports = { calculateVoteWeight, adjustReputation };
