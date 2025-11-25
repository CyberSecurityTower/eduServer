
'use strict';

/**
 * تحويل من snake_case (قاعدة البيانات) إلى camelCase (الكود)
 */
function toCamelCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => toCamelCase(v));
  } else if (obj != null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      const newKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      result[newKey] = toCamelCase(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

/**
 * تحويل من camelCase (الكود) إلى snake_case (قاعدة البيانات)
 */
function toSnakeCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => toSnakeCase(v));
  } else if (obj != null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      const newKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      result[newKey] = toSnakeCase(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

// دالة الوقت بصيغة ISO
const nowISO = () => new Date().toISOString();

module.exports = {
  toCamelCase,
  toSnakeCase,
  nowISO
};
