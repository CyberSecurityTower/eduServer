
// services/data/firestore.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// استخدام متغيرات البيئة أفضل
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// خريطة لربط أسماء المجموعات القديمة بأسماء الجداول الجديدة
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
  'userMemoryEmbeddings': 'user_memory_embeddings' // تأكد من الاسم في Supabase
};

// دالة لتحويل البيانات من JS (camelCase) إلى DB (snake_case)
function toSnakeCase(data) {
  const newData = {};
  for (const key in data) {
    let newKey = key;
    // تحويلات شائعة
    if (key === 'userId') newKey = 'user_id';
    else if (key === 'pathId') newKey = 'path_id';
    else if (key === 'subjectId') newKey = 'subject_id';
    else if (key === 'createdAt') newKey = 'created_at';
    else if (key === 'updatedAt') newKey = 'updated_at';
    else if (key === 'fcmToken') newKey = 'fcm_token';
    // ... أضف المزيد حسب الحاجة
    
    // معالجة التواريخ
    let val = data[key];
    if (val && typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    newData[newKey] = val;
  }
  return newData;
}

// محاكاة كائن Admin الخاص بفايربيز للحفاظ على توافق الكود القديم
const adminMock = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion: (val) => val, // Supabase لا يدعم هذا مباشرة في التحديث البسيط، يتطلب منطقاً خاصاً
      arrayRemove: (val) => val,
      increment: (val) => val,
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
        toMillis: () => date.getTime(),
        toISOString: () => date.toISOString()
      })
    }
  },
  messaging: () => ({ 
      send: async (p) => console.log("[Mock FCM] Sending notification:", p.notification?.title) 
      // ملاحظة: ستحتاج لربط Firebase Admin الحقيقي هنا إذا كنت تريد إرسال إشعارات فعلية
  })
};

class QueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.query = supabase.from(tableName).select('*');
    this.isSingleDoc = false;
    this.docId = null;
  }

  doc(id) {
    this.docId = id || crypto.randomUUID();
    this.isSingleDoc = true;
    // عند تحديد doc، نحصر البحث بهذا الـ ID
    this.query = supabase.from(this.tableName).select('*').eq('id', this.docId);
    return this;
  }

  where(field, op, value) {
    // تحويل أسماء الحقول
    let finalField = field;
    if (field === 'userId') finalField = 'user_id';
    if (field === 'status') finalField = 'status'; // عادة تبقى كما هي

    let finalValue = value;
    // معالجة كائنات التاريخ القادمة من الكود القديم
    if (value && typeof value === 'object') {
        if (typeof value.toISOString === 'function') {
            finalValue = value.toISOString();
        } else if (typeof value.toDate === 'function') {
            finalValue = value.toDate().toISOString();
        }
    }

    switch (op) {
      case '==': this.query = this.query.eq(finalField, finalValue); break;
      case '>': this.query = this.query.gt(finalField, finalValue); break;
      case '>=': this.query = this.query.gte(finalField, finalValue); break;
      case '<': this.query = this.query.lt(finalField, finalValue); break;
      case '<=': this.query = this.query.lte(finalField, finalValue); break;
      case 'in': this.query = this.query.in(finalField, finalValue); break;
      // array-contains في Postgres JSONB يحتاج operator خاص، cs (contains)
      case 'array-contains': this.query = this.query.contains(finalField, [finalValue]); break; 
      default: this.query = this.query.eq(finalField, finalValue);
    }
    return this;
  }

  orderBy(field, dir = 'asc') {
    let finalField = field;
    if (field === 'createdAt') finalField = 'created_at';
    
    this.query = this.query.order(finalField, { ascending: dir === 'asc' });
    return this;
  }

  limit(n) {
    this.query = this.query.limit(n);
    return this;
  }

  // تنفيذ الاستعلام (Read)
  async get() {
    if (this.isSingleDoc) {
      const { data, error } = await this.query.maybeSingle();
      
      // محاكاة Snapshot الخاص بفايربيز
      return {
        exists: !!data,
        id: this.docId,
        data: () => data || {},
        // نضيف ref هنا لتمكين doc.ref.update(...)
        ref: { 
            update: (d) => this.update(d), 
            set: (d, o) => this.set(d, o) 
        }
      };
    }

    const { data, error } = await this.query;
    if (error) {
        console.warn(`[Supabase Read Error] ${this.tableName}:`, error.message);
        return { empty: true, docs: [], forEach: () => {}, size: 0 };
    }

    const docs = (data || []).map(item => ({
      id: item.id,
      exists: true,
      data: () => item,
      ref: { 
        update: async (d) => {
           await supabase.from(this.tableName).update(toSnakeCase(d)).eq('id', item.id);
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

  // إضافة وثيقة جديدة (Create)
  async add(data) {
    const payload = toSnakeCase(data);
    // Supabase يرجع البيانات المضافة إذا طلبنا .select()
    const { data: res, error } = await supabase.from(this.tableName).insert(payload).select();
    
    if (error) {
        console.error(`[Supabase Add Error] ${this.tableName}:`, error.message);
        throw error;
    }
    return { id: res && res[0] ? res[0].id : null };
  }

  // تعيين وثيقة (Create or Replace)
  async set(data, options = {}) {
    const payload = { id: this.docId, ...toSnakeCase(data) };
    
    // إذا كان هناك merge: true، يجب أن نتعامل معه (Upsert في Supabase يقوم بذلك افتراضياً تقريباً)
    const { error } = await supabase.from(this.tableName).upsert(payload);
    
    if (error) console.error(`[Supabase Set Error] ${this.tableName}:`, error.message);
  }

  // تحديث وثيقة (Update)
  async update(data) {
    if (!this.docId) throw new Error("Cannot update without docId");
    
    // معالجة خاصة لـ ArrayUnion و ArrayRemove لأنها غير مدعومة مباشرة في Update بسيط
    // هنا نفترض تحديثاً بسيطاً، للعمليات المعقدة يجب جلب البيانات وتعديلها ثم حفظها
    // أو استخدام RPC functions في Supabase
    const payload = toSnakeCase(data);
    
    const { error } = await supabase.from(this.tableName).update(payload).eq('id', this.docId);
    if (error) console.error(`[Supabase Update Error] ${this.tableName}:`, error.message);
  }

  async delete() {
    if (!this.docId) return;
    await supabase.from(this.tableName).delete().eq('id', this.docId);
  }
}

class FirestoreAdapter {
  collection(path) {
    const parts = path.split('/');
    
    // حالة: collection('users')
    if (parts.length === 1) {
      const mappedName = TABLE_MAP[parts[0]] || parts[0];
      return new QueryBuilder(mappedName);
    } 
    
    // حالة: collection('users').doc(uid).collection('inbox') -> Subcollection
    // Supabase لا يدعم Subcollections، لذا قمنا بتسويتها في جداول مسطحة
    // مثال: userNotifications مع عمود user_id
    
    if (parts[0] === 'userNotifications' && parts[2] === 'inbox') {
      // نعيد QueryBuilder للجدول المسطح مع فلتر user_id
      const q = new QueryBuilder('user_notifications');
      return q.where('user_id', '==', parts[1]).where('box_type', '==', 'inbox');
    }
    
    if (parts[0] === 'userBehaviorAnalytics' && parts[2] === 'events') {
        const q = new QueryBuilder('user_behavior_analytics'); // افترضنا جدولاً واحداً للأحداث
        return q.where('user_id', '==', parts[1]);
    }

    // fallback لأي مسار آخر، نحاول تخمين اسم الجدول من آخر جزء
    return new QueryBuilder(TABLE_MAP[parts[parts.length - 1]] || parts[parts.length - 1]); 
  }

  batch() {
    // محاكاة بسيطة للـ batch (تنفيذ تسلسلي، ليس Transaction حقيقي)
    return {
      set: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete(),
      commit: async () => {} 
    };
  }
}

const dbInstance = new FirestoreAdapter();

module.exports = { 
  getFirestoreInstance: () => dbInstance, 
  initializeFirestore: () => dbInstance, 
  admin: adminMock 
};
