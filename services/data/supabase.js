
'use strict';

const { createClient } = require('@supabase/supabase-js');

// في Render، المتغيرات تكون موجودة تلقائياً في process.env
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  // هذا التنبيه سيظهر في Logs الخاصة بـ Render إذا نسيت إضافة المتغيرات في لوحة التحكم
  console.error('❌ Supabase URL or Key is missing! Check Render Environment Variables.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = supabase;
