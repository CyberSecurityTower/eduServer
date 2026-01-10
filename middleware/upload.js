// middleware/upload.js
'use strict';

const multer = require('multer');
const path = require('path');
const os = require('os');

const tempDir = os.tmpdir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'eduapp-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  // القائمة المسموحة
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain' // زدتلك Text file بالك يحتاجوه
  ];

  if (allowedTypes.includes(file.mimeType) || allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type.'), false);
  }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    // 🔥 هنا التغيير: رجعناها 50 ميغا
    limits: { fileSize: 50 * 1024 * 1024 } 
});

module.exports = upload;
