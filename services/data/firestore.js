// services/data/firestore.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// دالة مساعدة لتحويل مفاتيح البيانات إلى snake_case عند الكتابة
function toSnakeCase(data) {
  const newData = {};
  for (const key in data) {
    let newKey = key;
    if (key === 'userId') newKey = 'user_id';
    else if (key === 'sendAt') newKey = 'send_at';
    else if (key === 'startedAt') newKey = 'started_at';
    else if (key === 'finishedAt') newKey = 'finished_at';
    else if (key === 'lastError') newKey = 'last_error';
    else if (key === 'createdAt') newKey = 'created_at';
    else if (key === 'updatedAt') newKey = 'updated_at';
    else if (key === 'executeAt') newKey = 'execute_at';
    
    // ✅ إصلاح إضافي: إذا كانت القيمة كائن Timestamp، حولها لنص
    let val = data[key];
    if (val && typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    newData[newKey] = val;
  }
  return newData;
}

const adminMock = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion: (val) => val,
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
          // ✅ هذا ما يبحث عنه الكود: دالة toISOString
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
  messaging: () => ({ send: async (p) => console.log("[Mock FCM]", p.notification?.title) })
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
    this.query = supabase.from(this.tableName).select('*').eq('id', this.docId);
    return this;
  }

  where(field, op, value) {
    let finalField = field;
    if (field === 'userId') finalField = 'user_id';
    if (field === 'sendAt') finalField = 'send_at';
    if (field === 'status') finalField = 'status';
    if (field === 'executeAt') finalField = 'execute_at';

    // ✅✅✅ الإصلاح الجذري لمشكلة [object Object] ✅✅✅
    // إذا كانت القيمة كائناً (مثل Timestamp الخاص بـ adminMock)، نستخرج التاريخ كنص
    let finalValue = value;
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
      case '<=': this.query = this.query.lte(finalField, finalValue); break; // هنا كان يحدث الخطأ
      case 'in': this.query = this.query.in(finalField, finalValue); break;
      case 'array-contains': this.query = this.query.contains(finalField, [finalValue]); break;
      default: this.query = this.query.eq(finalField, finalValue);
    }
    return this;
  }

  orderBy(field, dir = 'asc') {
    let finalField = field;
    if (field === 'createdAt') finalField = 'created_at';
    if (field === 'updatedAt') finalField = 'updated_at';
    if (field === 'sendAt') finalField = 'send_at';
    if (field === 'executeAt') finalField = 'execute_at';
    
    this.query = this.query.order(finalField, { ascending: dir === 'asc' });
    return this;
  }

  limit(n) {
    this.query = this.query.limit(n);
    return this;
  }

  async get() {
    if (this.isSingleDoc) {
      const { data, error } = await this.query.maybeSingle();
      return {
        exists: !!data,
        id: this.docId,
        data: () => data || {},
        ref: { update: (d) => this.update(d), set: (d, o) => this.set(d, o) }
      };
    }

    const { data, error } = await this.query;
    if (error) {
        // تجاهل أخطاء الجداول الفارغة مؤقتاً لتقليل الضجيج
        if (!error.message.includes('does not exist')) {
            console.warn(`[Supabase Read] Table: ${this.tableName}, Error:`, error.message);
        }
        return { empty: true, docs: [], forEach: () => {} };
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

  async add(data) {
    const payload = toSnakeCase(data);
    const { data: res, error } = await supabase.from(this.tableName).insert(payload).select();
    if (error) console.error(`[Supabase Add] ${this.tableName}:`, error.message);
    return { id: res && res[0] ? res[0].id : null };
  }

  async set(data, options = {}) {
    const payload = { id: this.docId, ...toSnakeCase(data) };
    const { error } = await supabase.from(this.tableName).upsert(payload);
    if (error) console.error(`[Supabase Set] ${this.tableName}:`, error.message);
  }

  async update(data) {
    if (!this.docId) return;
    const payload = toSnakeCase(data);
    const { error } = await supabase.from(this.tableName).update(payload).eq('id', this.docId);
    if (error) console.error(`[Supabase Update] ${this.tableName}:`, error.message);
  }

  async delete() {
    if (!this.docId) return;
    await supabase.from(this.tableName).delete().eq('id', this.docId);
  }
}

class FirestoreAdapter {
  collection(path) {
    const parts = path.split('/');
    if (parts.length === 1) {
      const mappedName = TABLE_MAP[parts[0]] || parts[0];
      return new QueryBuilder(mappedName);
    } 
    if (parts[0] === 'userNotifications' && parts[2] === 'inbox') {
      return new QueryBuilder('user_notifications').where('user_id', '==', parts[1]).where('box_type', '==', 'inbox');
    }
    if (parts[0] === 'userBehaviorAnalytics') {
        return new QueryBuilder('user_behavior_analytics').where('user_id', '==', parts[1]);
    }
    return new QueryBuilder(parts[parts.length - 1]); 
  }

  batch() {
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
