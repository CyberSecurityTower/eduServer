// services/data/firestore.js
const { createClient } = require('@supabase/supabase-js');

// إعداد الاتصال
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// الدالة الرئيسية للحصول على العميل
function getFirestoreInstance() {
  return supabase;
}

// ✅ الحل السحري: هذا السطر هو الجسر بين الكود القديم والجديد
// نجعل دالة التهيئة تشير ببساطة إلى دالة جلب العميل
const initializeFirestore = getFirestoreInstance;

module.exports = { 
  getFirestoreInstance, 
  initializeFirestore, // 👈 تأكد أننا نصدر هذا الاسم لكي يجده index.js
  admin: null 
};
