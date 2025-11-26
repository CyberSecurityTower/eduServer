
// app.js
'use strict';

const express = require('express');
const cors = require('cors');
// تأكد أن المسارات للملفات التالية صحيحة بناءً على هيكلة مجلداتك
const requestIdMiddleware = require('./middleware/requestId'); 
const appRoutes = require('./routes');
const logger = require('./utils/logger');

const app = express();

// --- إعدادات Middleware ---

// 1. تفعيل CORS للسماح للفرونت إند بالاتصال من أي مكان
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-job-secret']
}));

// 2. تحليل البيانات القادمة (JSON) مع رفع الحد الأقصى للحجم
app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));

// 3. إضافة معرف لكل طلب (Logging)
app.use(requestIdMiddleware); 

// --- المسارات Routes ---

// فحص الصحة (Health Check) لـ Render
app.get('/', (req, res) => {
  res.status(200).send('EduAI Server is Running ✅');
});

// باقي مسارات التطبيق
app.use('/', appRoutes);

// --- معالجة الأخطاء Error Handling ---
app.use((err, req, res, next) => {
  logger.error(`Unhandled error for request ${req.requestId}:`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

module.exports = app;
