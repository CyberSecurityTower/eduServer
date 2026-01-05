
// config/tiers.js
'use strict';

const TIERS = {
  // 1. الباقة المجانية (EduStart)
  free: {
    label: 'EduStart',
    badge: null,
    daily_limit: 5, // 5 طلبات ذكية فقط يومياً
    features: ['chat_basic', 'quiz_simple'],
    description: 'ابدأ رحلتك التعليمية'
  },

  // 2. باقة الرواد (EduPioneer) - لزملائك حالياً
  pioneer: {
    label: 'EduPioneer',
    badge: '🛡️ Pioneer',
    daily_limit: 500, // حد مريح جداً
    features: ['*'], // الوصول لكل شيء
    description: 'نسخة حصرية للنخبة الأولى'
  },

  // 3. الباقة المدفوعة (EduPrime)
  pro: {
    label: 'EduPrime',
    badge: '⚡ Prime',
    daily_limit: 150, 
    features: ['chat_advanced', 'quiz_complex', 'ghost_teacher', 'pdf_chemist', 'exam_predictions', 'no_ads'],
    description: 'للطالب الذي يريد التفوق'
  },

  // 4. باقة المهندس (EduArchitect) - أنت
  admin: {
    label: 'EduArchitect',
    badge: '🏗️ Architect',
    daily_limit: 999999,
    features: ['*'],
    description: 'مهندس النظام'
  }
};

module.exports = TIERS;
