
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// تأكد من وجود هذه المتغيرات في ملف .env
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // نستخدم Service Role حصراً في الباك إند

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase URL or Key is missing!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = supabase;
