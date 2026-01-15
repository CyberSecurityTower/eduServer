
// services/data/supabase.js
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  console.error('❌ CRITICAL ERROR: SUPABASE_SERVICE_ROLE_KEY is missing!');
  process.exit(1);
}

// 🔥 التعديل هنا: إضافة الهيدر يدوياً لضمان وصوله
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { 
    autoRefreshToken: false, 
    persistSession: false 
  },
  global: { 
    fetch: fetch,
    headers: { 'Authorization': `Bearer ${supabaseKey}` } // إجبار التوثيق
  }
});

module.exports = supabase;
