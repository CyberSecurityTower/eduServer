// services/data/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // استخدم Service Role في الباك إند للحصول على صلاحيات كاملة

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
