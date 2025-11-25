// services/data/firestore.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- 1. الـ Admin الوهمي (للأوقات والعمليات الحسابية) ---
const adminMock = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion: (val) => val, // ملاحظة: المصفوفات تحتاج معالجة خاصة لاحقاً
      arrayRemove: (val) => val,
      increment: (val) => val,
      delete: () => null
    },
    Timestamp: {
      now: () => {
        const d = new Date();
        return { toDate: () => d, toMillis: () => d.getTime(), toISOString: () => d.toISOString() };
      },
      fromDate: (date) => ({ toDate: () => date, toMillis: () => date.getTime() })
    }
  },
  messaging: () => ({ send: async (p) => console.log("[Mock FCM]", p) })
};

// --- 2. المترجم الفوري (The Magic Adapter) ---
// هذا الكلاس يحول أوامر collection/doc/get/where إلى أوامر Supabase

class FirestoreAdapter {
  constructor() {}

  collection(tableName) {
    return new QueryBuilder(tableName);
  }

  batch() {
    return {
      set: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete(),
      commit: async () => console.log("[Batch] Committed (Fake)")
    };
  }
}

class QueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.query = supabase.from(tableName).select('*');
    this.isSingleDoc = false;
    this.docId = null;
  }

  doc(id) {
    // إذا لم يتم تمرير ID، ننشئ واحداً جديداً (UUID) للبيانات الجديدة
    this.docId = id || crypto.randomUUID(); 
    this.isSingleDoc = true;
    // نجهز استعلام لجلب عنصر واحد
    this.query = supabase.from(this.tableName).select('*').eq('id', this.docId);
    return this;
  }

  where(field, op, value) {
    // ترجمة عوامل المقارنة
    switch (op) {
      case '==': this.query = this.query.eq(field, value); break;
      case '>': this.query = this.query.gt(field, value); break;
      case '>=': this.query = this.query.gte(field, value); break;
      case '<': this.query = this.query.lt(field, value); break;
      case '<=': this.query = this.query.lte(field, value); break;
      case 'in': this.query = this.query.in(field, value); break;
      case 'array-contains': this.query = this.query.cs(field, [value]); break; // jsonb contains
    }
    return this;
  }

  orderBy(field, dir = 'asc') {
    this.query = this.query.order(field, { ascending: dir === 'asc' });
    return this;
  }

  limit(n) {
    this.query = this.query.limit(n);
    return this;
  }

  // تنفيذ القراءة (GET)
  async get() {
    const { data, error } = this.isSingleDoc ? await this.query.single() : await this.query;
    
    if (error && error.code !== 'PGRST116') { // تجاهل خطأ "لا توجد نتائج"
        console.warn(`[Adapter Read Error] ${this.tableName}:`, error.message);
    }

    const docs = (Array.isArray(data) ? data : (data ? [data] : [])).map(item => ({
      id: item.id,
      exists: true,
      data: () => item,
      ref: { update: (d) => this.update(d) } // مرجع وهمي للتحديث
    }));

    // محاكاة Snapshot الخاص بفايربيز
    return {
      empty: docs.length === 0,
      exists: this.isSingleDoc ? !!data : false, // للمستند الواحد
      docs: docs,
      forEach: (fn) => docs.forEach(fn),
      data: () => data // للمستند الواحد
    };
  }

  // تنفيذ الكتابة (SET/ADD)
  async set(data, options = {}) {
    // دمج البيانات إذا طلب ذلك
    const payload = { id: this.docId, ...data };
    // نستخدم upsert (إدراج أو تحديث)
    const { error } = await supabase.from(this.tableName).upsert(payload);
    if (error) console.error(`[Adapter Set Error]`, error.message);
  }

  async add(data) {
    const { data: res, error } = await supabase.from(this.tableName).insert(data).select();
    if (error) console.error(`[Adapter Add Error]`, error.message);
    return { id: res ? res[0].id : null };
  }

  async update(data) {
    if (!this.docId) return; // لا يمكن تحديث مجموعة
    const { error } = await supabase.from(this.tableName).update(data).eq('id', this.docId);
    if (error) console.error(`[Adapter Update Error]`, error.message);
  }
  
  async delete() {
     if (!this.docId) return;
     await supabase.from(this.tableName).delete().eq('id', this.docId);
  }
}

// --- 3. التصدير ---

const dbInstance = new FirestoreAdapter();

function getFirestoreInstance() {
  return dbInstance;
}

module.exports = { 
  getFirestoreInstance, 
  initializeFirestore: getFirestoreInstance, // Alias
  admin: adminMock 
};
