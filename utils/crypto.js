
// utils/crypto.js
'use strict';
const crypto = require('crypto');

// يجب وضع هذا المفتاح في ملف .env ويكون طويلاً ومعقداً
// مثال: ADMIN_SECRET_KEY=my_super_secret_long_key_for_eduapp_2025
const SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'default_secret_key_change_me_please';
const ALGORITHM = 'aes-256-cbc';

// دالة لضمان أن المفتاح دائماً 32 بايت (مهم جداً لـ AES-256)
const getKey = () => crypto.createHash('sha256').update(SECRET_KEY).digest();

function encryptForAdmin(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(16); // Initialization Vector (عشوائي دائماً)
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    // نرجع النص بصيغة: IV:EncryptedData
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error('Encryption Error:', e);
    return null;
  }
}

function decryptForAdmin(text) {
  if (!text) return null;
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    console.error('Decryption Error:', e);
    return null; // إذا فشل فك التشفير (مثلاً المفتاح خطأ)
  }
}

module.exports = { encryptForAdmin, decryptForAdmin };
