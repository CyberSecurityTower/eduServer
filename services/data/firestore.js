
// services/data/firestore.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// التأكد من وجود المتغيرات
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('CRITICAL: Supabase URL or Key is missing.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// خريطة الجداول بناءً على الصور المرفقة
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
  'curriculumEmbeddings': 'curriculum_embeddings', // تأكد من إنشاء هذا الجدول إذا لم يكن موجوداً
  'userMemoryEmbeddings': 'user_memory_embeddings'
};

// خريطة الحقول (CamelCase -> SnakeCase)
function mapField(field) {
    const mapping = {
        'userId': 'user_id',
        'pathId': 'path_id',
        'subjectId': 'subject_id',
        'lessonId': 'lesson_id',
        'createdAt': 'created_at',
        'updatedAt': 'updated_at',
        'sendAt': 'send_at',
        'executeAt': 'execute_at',
        'startedAt': 'started_at',
        'finishedAt': 'finished_at',
        'lastError': 'last_error',
        'fcmToken': 'fcm_token',
        'targetId': 'target_id',
        'selectedPathId': 'selected_path_id',
        'profileStatus': 'profile_status',
        'aiDiscoveryMissions': 'ai_discovery_missions',
        'aiNoteToSelf': 'ai_note_to_self',
        'firstName': 'first_name',
        'lastName': 'last_name',
        'boxType': 'box_type'
    };
    return mapping[field] || field;
}

function toSnakeCase(data) {
  const newData = {};
  for (const key in data) {
    const newKey = mapField(key);
    let val = data[key];
    
    // التعامل مع التواريخ
    if (val && typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    
    // تجاهل القيم الخاصة بالمحاكاة (Mock) لأننا سنعالجها يدوياً
    if (val === '___ARRAY_UNION___' || val === '___INCREMENT___') {
        continue; 
    }

    newData[newKey] = val;
  }
  return newData;
}

// محاكاة كائن Admin الخاص بفايربيس
const adminMock = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      // علامات خاصة سنعالجها في الـ Controller
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
  }
};

class QueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.query = supabase.from(tableName).select('*');
    this.isSingleDoc = false;
    this.docId = null;
  }

  doc(id) {
    // إذا لم يتم تمرير ID، ننشئ واحد جديد (لعمليات الإضافة)
    this.docId = id || crypto.randomUUID();
    this.isSingleDoc = true;
    // ملاحظة: لا نفلتر هنا بـ eq لأننا قد نكون بصدد إنشاء مستند جديد
    return this;
  }

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
      case 'array-contains': 
        // Postgres uses @> for array containment
        this.query = this.query.contains(finalField, [finalValue]); 
        break;
      default: this.query = this.query.eq(finalField, finalValue);
    }
    return this;
  }

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
      // جلب مستند واحد
      const { data, error } = await supabase.from(this.tableName).select('*').eq('id', this.docId).maybeSingle();
      
      return {
        exists: !!data,
        id: this.docId,
        data: () => data || {},
        ref: { update: (d) => this.update(d), set: (d, o) => this.set(d, o) }
      };
    }

    // جلب مجموعة
    const { data, error } = await this.query;
    if (error) {
        // تجاهل أخطاء "الجدول غير موجود" أو "البيانات فارغة"
        console.warn(`[Supabase Read] Table: ${this.tableName}, Error: ${error.message}`);
        return { empty: true, docs: [], forEach: () => {}, size: 0 };
    }

    const docs = (data || []).map(item => ({
      id: item.id,
      exists: true,
      data: () => item,
      ref: { 
        update: async (d) => {
           await supabase.from(this.tableName).update(toSnakeCase(d)).eq('id', item.id);
        },
        delete: async () => {
           await supabase.from(this.tableName).delete().eq('id', item.id);
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
    // إضافة مستند جديد (الـ ID يتم توليده تلقائياً من Supabase إذا لم يمرر)
    const payload = toSnakeCase(data);
    
    // إذا لم يكن هناك ID في البيانات، Supabase سينشئه (إذا كان العمود uuid DEFAULT gen_random_uuid())
    // لكن لكي نرجع الـ ID للكود، نستخدم .select()
    const { data: res, error } = await supabase.from(this.tableName).insert(payload).select();
    
    if (error) {
        console.error(`[Supabase Add Error] ${this.tableName}:`, error.message);
        throw error;
    }
    return { id: res && res[0] ? res[0].id : null };
  }

  async set(data, options = {}) {
    const payload = { id: this.docId, ...toSnakeCase(data) };
    // Upsert: إدراج أو تحديث
    const { error } = await supabase.from(this.tableName).upsert(payload);
    if (error) console.error(`[Supabase Set Error] ${this.tableName}:`, error.message);
  }

  async update(data) {
    if (!this.docId) {
        console.error("Cannot update without docId");
        return;
    }
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
    // حالة 1: مجموعة مباشرة (users)
    if (parts.length === 1) {
      const mappedName = TABLE_MAP[parts[0]] || parts[0];
      return new QueryBuilder(mappedName);
    } 
    
    // حالة 2: Sub-collection (محاكاة)
    // Firestore: userNotifications/{userId}/inbox
    // Supabase: user_notifications WHERE user_id = userId AND box_type = 'inbox'
    if (parts[0] === 'userNotifications' && parts[2] === 'inbox') {
      return new QueryBuilder('user_notifications')
        .where('user_id', '==', parts[1])
        .where('box_type', '==', 'inbox');
    }
    
    // Firestore: userBehaviorAnalytics/{userId}/events
    if (parts[0] === 'userBehaviorAnalytics' && parts[2] === 'events') {
        // بما أن الجدول مسطح في الصور، سنضيف البيانات للجدول الرئيسي ونفلتر بالـ user_id
        return new QueryBuilder('user_behavior_analytics').where('user_id', '==', parts[1]);
    }

    // Default Fallback
    const lastPart = parts[parts.length - 1];
    return new QueryBuilder(TABLE_MAP[lastPart] || lastPart); 
  }

  batch() {
    const operations = [];
    return {
      set: (ref, data) => operations.push(ref.set(data)),
      update: (ref, data) => operations.push(ref.update(data)),
      delete: (ref) => operations.push(ref.delete()),
      commit: async () => {
        // تنفيذ العمليات بالتتابع (ليس Atomic حقيقي في هذا المحاكي البسيط، لكن يفي بالغرض)
        await Promise.all(operations); 
      } 
    };
  }
}

const dbInstance = new FirestoreAdapter();

module.exports = { 
  getFirestoreInstance: () => dbInstance, 
  initializeFirestore: () => dbInstance, 
  admin: adminMock 
};
