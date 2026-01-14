// services/data/supabase.js
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 🕵️‍♂️ كود كشف الحقيقة: اطبع أول 10 حروف من المفتاح
console.log("---------------------------------------------------");
console.log("🔍 DEBUG SUPABASE KEY:");
console.log("Is Key Present?", !!supabaseKey);
console.log("Key Start:", supabaseKey ? supabaseKey.substring(0, 15) + "..." : "MISSING");
console.log("---------------------------------------------------");

if (!supabaseKey) {
  console.error('❌ CRITICAL ERROR: SUPABASE_SERVICE_ROLE_KEY is missing!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: fetch }
});

module.exports = supabase;
