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

// Helper to convert keys from camelCase to snake_case for DB writing
function toSnakeCase(data) {
  const newData = {};
  for (const key in data) {
    // Mapping specific fields known to cause issues
    if (key === 'userId') newData['user_id'] = data[key];
    else if (key === 'sendAt') newData['send_at'] = data[key];
    else if (key === 'startedAt') newData['started_at'] = data[key];
    else if (key === 'finishedAt') newData['finished_at'] = data[key];
    else if (key === 'lastError') newData['last_error'] = data[key];
    else if (key === 'createdAt') newData['created_at'] = data[key];
    else if (key === 'updatedAt') newData['updated_at'] = data[key];
    else if (key === 'executeAt') newData['execute_at'] = data[key];
    else newData[key] = data[key];
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
        return { toDate: () => d, toMillis: () => d.getTime(), toISOString: () => d.toISOString() };
      },
      fromDate: (date) => ({ toDate: () => date, toMillis: () => date.getTime() })
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

  // ✅ التعديل الجوهري هنا: ترجمة الحقول أثناء البحث
  where(field, op, value) {
    let finalField = field;
    // ترجمة أسماء الأعمدة الشائعة
    if (field === 'userId') finalField = 'user_id';
    if (field === 'sendAt') finalField = 'send_at'; // 👈 الحل لمشكلتك
    if (field === 'status') finalField = 'status';
    if (field === 'executeAt') finalField = 'execute_at';

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
    let finalField = field;
    if (field === 'createdAt') finalField = 'created_at';
    if (field === 'updatedAt') finalField = 'updated_at';
    if (field === 'sendAt') finalField = 'send_at'; // 👈 وتصحيح الترتيب أيضاً
    
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
        // لا نريد إغراق اللوجز بأخطاء إذا كان الجدول فارغاً أو غير موجود بعد
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
    const payload = toSnakeCase(data); // ✅ تحويل البيانات قبل الإرسال
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
    // Subcollections Handling
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
