
// utils/cryptoHelper.js
'use strict';

const crypto = require('crypto');

// 🔐 مفتاح سري ثابت بين الباك-إند والفرونت-إند (يجب أن يكون 32 حرفاً لـ AES-256)
// في الإنتاج، ضعه في متغيرات البيئة .env
const SECRET_KEY = process.env.ARENA_SECRET_KEY || 'x-tactical-arena-secure-key-2026'; 
const IV_LENGTH = 16; // For AES, this is always 16

function encryptAnswer(data) {
    try {
        // تحويل البيانات (سواء كانت نص، كائن، مصفوفة) إلى سترينغ
        const text = JSON.stringify(data);
        
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET_KEY), iv);
        
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        // النتيجة تكون: IV:EncryptedData (عشان نقدر نفكها في الفرونت)
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
        console.error("Encryption Error:", e);
        return null;
    }
}

module.exports = { encryptAnswer };
