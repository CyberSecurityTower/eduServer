
'use strict';

const { createClient } = require('@supabase/supabase-js');

// تأكد أنك تستخدم المتغيرات من ملف .env أو ضع المفتاح مباشرة هنا مؤقتاً للتجربة
const supabaseUrl = process.env.SUPABASE_URL || 'https://wlghgzsgsefvwtdysqsw.supabase.co';

// ⚠️ هام جداً: استخدم SERVICE_ROLE_KEY هنا وليس Anon Key
// هذا المفتاح يبدأ عادة بـ eyJ... ويسمح للباك إند بقراءة وكتابة كل شيء
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsZ2hnenNnc2Vmdnd0ZHlzcXN3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Mzc2NDg3NywiZXhwIjoyMDc5MzQwODc3fQ.qQeIrBoUARn1L0QS2I_JLXzdRWarxnCyiFletid0tL0'; 

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = supabase;
