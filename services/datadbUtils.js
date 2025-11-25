
'use strict';

/**
 * دالة مساعدة لتحويل البيانات القادمة من Supabase (snake_case)
 * إلى الصيغة التي يفهمها التطبيق (camelCase)
 */
function toCamelCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => toCamelCase(v));
  } else if (obj != null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      // تحويل user_id -> userId
      const newKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      result[newKey] = toCamelCase(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

/**
 * دالة مساعدة لتحويل بيانات التطبيق (camelCase)
 * إلى صيغة قاعدة البيانات (snake_case) للحفظ
 */
function toSnakeCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => toSnakeCase(v));
  } else if (obj != null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      // تحويل userId -> user_id
      const newKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      result[newKey] = toSnakeCase(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

// بديل لـ FieldValue.serverTimestamp()
const nowISO = () => new Date().toISOString();

module.exports = {
  toCamelCase,
  toSnakeCase,
  nowISO
};
