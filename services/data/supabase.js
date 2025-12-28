// services/data/supabase.js
'use strict';

require('dotenv').config(); // تأكد من تحميل المتغيرات
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;

// 🔥 التعديل الحاسم: إجبار الكود على قراءة المفتاح السفلي من الصورة
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// تحقق من أن المفتاح تم تحميله
if (!supabaseKey) {
  console.error('❌ CRITICAL ERROR: SUPABASE_SERVICE_ROLE_KEY is missing in .env file!');
  process.exit(1); // إيقاف السيرفر فوراً لتنتبه
}

// طباعة أول 5 أحرف للتأكد (لأغراض التصحيح فقط)
console.log(`🔑 Supabase Init with Key: ${supabaseKey.substring(0, 10)}... (Should be Service Role)`);

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = supabase;
