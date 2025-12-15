
// controllers/walletController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * جلب الرصيد الحالي
 */
async function getBalance(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('coins, role')
      .eq('id', userId)
      .single();

    if (error) throw error;

    // تحديد الرتبة بناءً على الكوينز (يمكن تطويرها لاحقاً)
    const coins = data.coins || 0;
    let rank = 'Student';
    if (coins > 1000) rank = 'Scholar 🎓';
    if (coins > 5000) rank = 'Master 🧠';
    if (coins > 10000) rank = 'Legend 🏆';

    return res.json({
      coins: coins,
      rank: rank
    });

  } catch (err) {
    logger.error('Get Balance Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch balance' });
  }
}

/**
 * صرف الكوينز (شراء ميزة)
 */
async function spendCoins(req, res) {
  const userId = req.user?.id;
  const { item_type, item_id, cost } = req.body;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!cost || cost <= 0) return res.status(400).json({ error: 'Invalid cost' });

  try {
    // 1. التحقق من الرصيد أولاً
    const { data: user } = await supabase
      .from('users')
      .select('coins')
      .eq('id', userId)
      .single();

    const currentBalance = user?.coins || 0;

    if (currentBalance < cost) {
      return res.status(402).json({ 
        error: 'رصيدك غير كافٍ! (Insufficient funds)', 
        current_balance: currentBalance 
      });
    }

    // 2. تنفيذ الخصم باستخدام RPC (لضمان الأمان)
    const { data: newBalance, error } = await supabase.rpc('process_coin_transaction', {
      p_user_id: userId,
      p_amount: -cost, // قيمة سالبة للخصم
      p_reason: `buy_${item_type}`,
      p_meta: { item_id }
    });

    if (error) throw error;

    logger.info(`💰 User ${userId} spent ${cost} coins on ${item_type}`);

    return res.json({
      success: true,
      new_balance: newBalance,
      message: 'Purchase successful'
    });

  } catch (err) {
    logger.error('Spend Coins Error:', err.message);
    return res.status(500).json({ error: 'Transaction failed' });
  }
}

module.exports = { getBalance, spendCoins };
