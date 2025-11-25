// services/data/firestore.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto'); // لتوليد IDs تلقائية

// 1. إعداد اتصال Supabase
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. خريطة ترجمة الأسماء (Firebase -> Supabase)
// هذا القاموس يوجه البيانات إلى الجداول الصحيحة التي أنشأتها في SQL
const TABLE_MAP = {
  'users': 'users',
  'jobs': 'jobs',
  'userProgress': 'user_progress',
  'educationalPaths': 'educational_paths',
  'lessonsContent': 'lessons_content',
  'chatSessions': 'chat_sessions',
  'scheduledActions': 'scheduled_actions',
  'userNotifications': 'user_notifications',
  'aiMemoryProfiles': 'ai_memory_profiles',
  'userBehaviorAnalytics': 'user_behavior_analytics',
  'curriculumEmbeddings': 'curriculum_embeddings',
  'userMemoryEmbeddings': 'memory_embeddings'
};

// 3. محاكي أدوات الأدمن (Admin Mock)
// يمنع انهيار السيرفر عند استدعاء دوال الوقت والعمليات الخاصة بفايربيز
const adminMock = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion: (val) => val, // Supabase يتعامل مع JSONB مباشرة
      arrayRemove: (val) => val,
      increment: (val) => val, // يمكن تنفيذها لاحقاً بـ RPC إذا لزم الأمر
      delete: () => null
    },
    Timestamp: {
      now: () => {
        const d = new Date();
        return { 
          toDate: () => d, 
          toMillis: () => d.getTime(), 
          toISOString: () => d.toISOString() 
        };
      },
      fromDate: (date) => ({ 
        toDate: () => date, 
        toMillis: () => date.getTime() 
      })
    }
  },
  messaging: () => ({
    send: async (payload) => console.log("[Mock FCM] Push Notification simulated:", payload.notification?.title)
  })
};

// 4. باني الاستعلامات (The Query Builder)
// هذا الكلاس يحول أوامر مثل .where().orderBy() إلى Supabase syntax
class QueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.query = supabase.from(tableName).select('*');
    this.isSingleDoc = false;
    this.docId = null;
    this.filtersApplied = false;
  }

  doc(id) {
    this.docId = id || crypto.randomUUID();
    this.isSingleDoc = true;
    // نعيد ضبط الاستعلام ليركز على مستند واحد
    this.query = supabase.from(this.tableName).select('*').eq('id', this.docId);
    return this;
  }

  where(field, op, value) {
    this.filtersApplied = true;
    // ترجمة المعاملات (Operators)
    // ملاحظة: التعامل مع الحقول المتداخلة (Nested Fields) في JSONB يتطلب سهم ->>
    // لكن للتبسيط سنفترض أعمدة مسطحة أو نستخدم النحو الأساسي
    let finalField = field;
    
    // تصحيح بسيط لبعض الحقول المشهورة
    if (field === 'userId') finalField = 'user_id';
    if (field === 'lessonId') finalField = 'lesson_id';

    switch (op) {
      case '==': this.query = this.query.eq(finalField, value); break;
      case '>': this.query = this.query.gt(finalField, value); break;
      case '>=': this.query = this.query.gte(finalField, value); break;
      case '<': this.query = this.query.lt(finalField, value); break;
      case '<=': this.query = this.query.lte(finalField, value); break;
      case 'in': this.query = this.query.in(finalField, value); break;
      case 'array-contains': this.query = this.query.contains(finalField, [value]); break;
      default: this.query = this.query.eq(finalField, value);
    }
    return this;
  }

  orderBy(field, dir = 'asc') {
    // تصحيح الحقول الزمنية
    if (field === 'createdAt') field = 'created_at';
    if (field === 'updatedAt') field = 'updated_at';
    if (field === 'executeAt') field = 'execute_at';
    
    this.query = this.query.order(field, { ascending: dir === 'asc' });
    return this;
  }

  limit(n) {
    this.query = this.query.limit(n);
    return this;
  }

  // تنفيذ القراءة (GET)
  async get() {
    // إذا كنا نبحث عن مستند واحد
    if (this.isSingleDoc) {
      const { data, error } = await this.query.maybeSingle(); // maybeSingle لا يرمي خطأ إذا لم يجد
      
      // محاكاة DocumentSnapshot
      return {
        exists: !!data,
        id: this.docId,
        data: () => data || {},
        ref: { update: (d) => this.update(d), set: (d, o) => this.set(d, o) }
      };
    }

    // إذا كنا نبحث عن مجموعة (QuerySnapshot)
    const { data, error } = await this.query;
    
    if (error) {
      console.warn(`[Supabase Read Error] Table: ${this.tableName}, Error:`, error.message);
      return { empty: true, docs: [], forEach: () => {} };
    }

    const docs = (data || []).map(item => ({
      id: item.id,
      exists: true,
      data: () => item,
      ref: { 
        update: async (d) => {
           await supabase.from(this.tableName).update(d).eq('id', item.id);
        }
      }
    }));

    return {
      empty: docs.length === 0,
      docs: docs,
      forEach: (fn) => docs.forEach(fn),
      size: docs.length
    };
  }

  // إضافة (ADD) - تنشئ ID تلقائي
  async add(data) {
    // تحويل الحقول للكتابة (camelCase -> snake_case) بشكل يدوي للأشياء المهمة
    if (data.userId) { data.user_id = data.userId; delete data.userId; }
    
    const { data: res, error } = await supabase.from(this.tableName).insert(data).select();
    if (error) console.error(`[Supabase Add Error] Table: ${this.tableName}`, error.message);
    return { id: res && res[0] ? res[0].id : null };
  }

  // تعيين (SET) - Upsert
  async set(data, options = {}) {
    const payload = { id: this.docId, ...data };
    if (payload.userId) { payload.user_id = payload.userId; delete payload.userId; }

    // دمج البيانات (Merge) يعني في SQL upsert
    const { error } = await supabase.from(this.tableName).upsert(payload);
    if (error) console.error(`[Supabase Set Error] Table: ${this.tableName}`, error.message);
  }

  // تحديث (UPDATE)
  async update(data) {
    if (!this.docId) return;
    // تنظيف البيانات الخاصة بـ Firebase قبل الإرسال
    const cleanData = { ...data };
    
    // التعامل مع التحديثات المعقدة مثل النقاط (JSONB path)
    // ملاحظة: هذا تبسيط، التحديثات العميقة في JSONB تتطلب منطقاً خاصاً
    // لكن للمستويات العليا سيعمل
    
    const { error } = await supabase.from(this.tableName).update(cleanData).eq('id', this.docId);
    if (error) console.error(`[Supabase Update Error] Table: ${this.tableName}, ID: ${this.docId}`, error.message);
  }

  async delete() {
    if (!this.docId) return;
    await supabase.from(this.tableName).delete().eq('id', this.docId);
  }
}

// 5. المترجم الرئيسي (Adapter)
// يستقبل طلبات مثل db.collection(...)
class FirestoreAdapter {
  collection(path) {
    const parts = path.split('/');
    
    // A. مجموعة بسيطة: db.collection('users')
    if (parts.length === 1) {
      const mappedName = TABLE_MAP[parts[0]] || parts[0];
      return new QueryBuilder(mappedName);
    } 
    
    // B. مجموعات فرعية (Subcollections) - سنقوم بتسطيحها (Flattening)
    
    // حالة 1: الإشعارات (userNotifications/{userId}/inbox)
    if (parts[0] === 'userNotifications' && parts[2] === 'inbox') {
      const userId = parts[1];
      const qb = new QueryBuilder('user_notifications');
      // نفلتر تلقائياً حسب المستخدم ونحدد النوع
      return qb.where('user_id', '==', userId).where('box_type', '==', 'inbox');
    }

    // حالة 2: التحليلات (userBehaviorAnalytics/{userId}/sessions)
    if (parts[0] === 'userBehaviorAnalytics') {
        // نوجه كل شيء لجدول التحليلات العام
        const qb = new QueryBuilder('user_behavior_analytics');
        return qb.where('user_id', '==', parts[1]);
    }

    // Fallback: نحاول تخمين الاسم
    console.log(`[Adapter] Warning: Unhandled subcollection path: ${path}`);
    return new QueryBuilder(parts[parts.length - 1]); 
  }

  // محاكاة Batch (تنفذ العمليات فوراً للتبسيط)
  batch() {
    return {
      set: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete(),
      commit: async () => console.log("[Batch] Auto-committed by Adapter")
    };
  }
}

const dbInstance = new FirestoreAdapter();

function getFirestoreInstance() {
  return dbInstance;
}

module.exports = { 
  getFirestoreInstance, 
  initializeFirestore: getFirestoreInstance, 
  admin: adminMock 
};
