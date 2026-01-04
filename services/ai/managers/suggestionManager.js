
// services/ai/managers/suggestionManager.js
'use strict';

const logger = require('../../../utils/logger');

// قائمة الاقتراحات الثابتة (Pool of Suggestions)
const STATIC_SUGGESTIONS_POOL = [
    "نصيحة للدراسة",      
    "لخص لي هاد الدرس",          
    "واش هي أهم المفاهيم هنا؟",          
    "هل هذا الدرس صعيب؟",             
    "أعطيني كويز على هاد الدرس",            
    "واش هي العناصر الأساسية؟",               
    "وين راني واصل؟",            
    "أعطيني مثال عملي",             
    "كيفاش نقدر نحفظو بسهولة؟",            
    "شرح لي العنصر الأول" ,
    "إشرح لي كأني طفل",
    "قم بتبسيط المفاهيم الرئيسية",
    "إصنع بطاقات فلاشكارد للدرس"
];

function initSuggestionManager(dependencies) {
  // لم نعد بحاجة لحقن التبعيات هنا، لكن نبقي الدالة لعدم كسر الكود في index.js
  // generateWithFailoverRef = dependencies.generateWithFailover; 
}

/**
 * دالة خلط عشوائي (Fisher-Yates Shuffle)
 */
function shuffleArray(array) {
    const arr = [...array]; // نسخة لتجنب تعديل الأصل
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function runSuggestionManager(userId) {
  try {
    // نقوم بخلط القائمة واختيار أول 4 عناصر
    const shuffled = shuffleArray(STATIC_SUGGESTIONS_POOL);
    const selectedSuggestions = shuffled.slice(0, 4);

    return selectedSuggestions;

  } catch (error) {
    logger.error(`SuggestionManager failed for ${userId}:`, error.message);
    // في أسوأ الحالات نرجع أول 4 عناصر
    return STATIC_SUGGESTIONS_POOL.slice(0, 4);
  }
}

module.exports = {
  initSuggestionManager,
  runSuggestionManager,
};
