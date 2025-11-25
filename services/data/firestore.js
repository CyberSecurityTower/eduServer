
// services/data/firestore.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// خريطة الجداول
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
  'userMemoryEmbeddings': 'user_memory_embeddings'
};

// ✅ دالة تحويل الأسماء (Mapping Helper)
// هذه الدالة هي "الجندي المجهول" الذي سيحل مشكلة sendAt vs send_at
function mapField(field) {
    const mapping = {
        'userId': 'user_id',
        'pathId': 'path_id',
        'subjectId': 'subject_id',
        'lessonId': 'lesson_id',
        'createdAt': 'created_at',
        'updatedAt': 'updated_at',
        'sendAt': 'send_at',       // 👈 الحل هنا
        'executeAt': 'execute_at', // وهنا
        'startedAt': 'started_at',
        'finishedAt': 'finished_at',
        'lastError': 'last_error',
        'fcmToken': 'fcm_token',
        'targetId': 'target_id'
    };
    return mapping[field] || field;
}

function toSnakeCase(data) {
  const newData = {};
  for (const key in data) {
    const newKey = mapField(key); // نستخدم نفس دالة التحويل
    
    let val = data[key];
    if (val && typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    newData[newKey] = val;
  }
  return newData;
}

// Mock Admin Object
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
      fromDate: (date) => ({ 
        toDate: () => date, 
        toMillis: () => date.getTime(),
        toISOString: () => date.toISOString()
      })
    }
  },
  messaging: () => ({ send: async () => {} })
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

  // ✅ تم تحديث دالة where لتستخدم mapField
  where(field, op, value) {
    const finalField = mapField(field); 

    let finalValue = value;
    if (value && typeof value === 'object') {
        if (typeof value.toISOString === 'function') finalValue = value.toISOString();
        else if (typeof value.toDate === 'function') finalValue = value.toDate().toISOString();
    }

    switch (op) {
      case '==': this.query = this.query.eq(finalField, finalValue); break;
      case '>': this.query = this.query.gt(finalField, finalValue); break;
      case '>=': this.query = this.query.gte(finalField, finalValue); break;
      case '<': this.query = this.query.lt(finalField, finalValue); break;
      case '<=': this.query = this.query.lte(finalField, finalValue); break;
      case 'in': this.query = this.query.in(finalField, finalValue); break;
      case 'array-contains': this.query = this.query.contains(finalField, [finalValue]); break;
      default: this.query = this.query.eq(finalField, finalValue);
    }
    return this;
  }

  // ✅ تم تحديث دالة orderBy لتستخدم mapField
  orderBy(field, dir = 'asc') {
    const finalField = mapField(field);
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
        // نتجاهل أخطاء الجداول الفارغة، لكن نظهر الأخطاء الأخرى مثل sendAt does not exist
        if (!error.message.includes('JSON object requested')) {
             console.warn(`[Supabase Read Error] ${this.tableName}:`, error.message);
        }
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

  async add(data) {
    const payload = toSnakeCase(data);
    const { data: res, error } = await supabase.from(this.tableName).insert(payload).select();
    if (error) console.error(`[Supabase Add Error] ${this.tableName}:`, error.message);
    return { id: res && res[0] ? res[0].id : null };
  }

  async set(data, options = {}) {
    const payload = { id: this.docId, ...toSnakeCase(data) };
    const { error } = await supabase.from(this.tableName).upsert(payload);
    if (error) console.error(`[Supabase Set Error] ${this.tableName}:`, error.message);
  }

  async update(data) {
    if (!this.docId) return; // Cannot update without ID
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
    return new QueryBuilder(TABLE_MAP[parts[parts.length - 1]] || parts[parts.length - 1]); 
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
