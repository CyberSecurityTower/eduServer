// middleware/upload.js
'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// نستخدم مجلد الـ temp تاع النظام باش نتفاداو مشاكل الصلاحيات في Render
const tempDir = os.tmpdir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    // نسمي الملف باسم فريد باش ما يتخلطوش
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'eduapp-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// فلتر لرفض الملفات الخبيثة (نقبلو الصور، PDF، Word, PowerPoint)
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation' // pptx
  ];

  if (allowedTypes.includes(file.mimeType) || allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only Images, PDF, and Office docs are allowed.'), false);
  }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 15 * 1024 * 1024 } // الحد الأقصى 15MB
});

module.exports = upload;
