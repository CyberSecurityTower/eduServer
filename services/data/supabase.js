
// services/data/supabase.js
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
// ✅ استيراد node-fetch الأصلي بشكل صريح
const fetch = require('node-fetch');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  console.error('❌ CRITICAL ERROR: SUPABASE_SERVICE_ROLE_KEY is missing!');
  process.exit(1);
}

// ✅ تمرير الـ fetch الأصلي لعميل Supabase ليعزله عن أي تلاعب في global.fetch
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  global: {
    fetch: fetch // 👈 هذا السطر هو المنقذ!
  }
});

module.exports = supabase;
