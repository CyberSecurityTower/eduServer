// services/data/firestore.js
const { createClient } = require('@supabase/supabase-js');

// لاحظ: لا يوجد require('dotenv') هنا

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getFirestoreInstance() {
  return supabase;
}

module.exports = { getFirestoreInstance, admin: null };
