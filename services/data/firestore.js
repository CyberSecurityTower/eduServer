// services/data/firestore.js (سنعيد تسميته وظيفياً لـ dataService.js لاحقاً)
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// دالة مساعدة للحصول على النسخة (للحفاظ على توافق الكود القديم مؤقتاً)
function getFirestoreInstance() {
  return supabase;
}

module.exports = { getFirestoreInstance, admin: null }; 
// admin: null لأننا لم نعد بحاجة لـ firebase-admin
