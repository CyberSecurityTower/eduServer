// services/data/firestore.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- الخدعة الذكية: محاكي Firebase Admin ---
// هذا الكائن يجعل الكود القديم يظن أنه لا يزال يتعامل مع Firebase
const adminMock = {
  firestore: {
    FieldValue: {
      // Supabase يحب التواريخ النصية (ISO)، لذا نستبدل timestamp الخاص بفايربيز
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion: (val) => val, // تبسيط
      arrayRemove: (val) => val,
      increment: (val) => val
    },
    Timestamp: {
      now: () => {
        const d = new Date();
        return { 
          toDate: () => d, 
          toMillis: () => d.getTime(),
          toISOString: () => d.toISOString() // إضافة مهمة لـ Supabase
        };
      },
      fromDate: (date) => ({ 
        toDate: () => date, 
        toMillis: () => date.getTime() 
      })
    }
  },
  // محاكاة الرسائل لتجنب تحطم النظام عند محاولة إرسال إشعار
  messaging: () => ({
    send: async (payload) => console.log("[Mock FCM] Would send:", payload)
  })
};

function getFirestoreInstance() {
  return supabase;
}

const initializeFirestore = getFirestoreInstance;

module.exports = { 
  getFirestoreInstance, 
  initializeFirestore, 
  admin: adminMock // ✅ الآن أصبح لدينا admin وهمي ينقذ الموقف
};
