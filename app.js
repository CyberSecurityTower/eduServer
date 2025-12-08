// app.js
'use strict';

const express = require('express');
const cors = require('cors');
const requestIdMiddleware = require('./middleware/requestId'); 
const rateLimiter = require('./middleware/rateLimiter'); // ✅ استيراد
const appRoutes = require('./routes');
const logger = require('./utils/logger');

const app = express();

// --- إعدادات Middleware ---

// 1. تفعيل CORS
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-job-secret']
}));

// 2. تحليل JSON
app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));

// 3. إضافة معرف الطلب
app.use(requestIdMiddleware); 

// 4. تفعيل الحماية من الطلبات المتكررة (Rate Limiting) ✅
app.use(rateLimiter);

// --- المسارات Routes ---

app.get('/', (req, res) => {
  res.status(200).send('EduAI Server is Running ✅');
});

app.use('/', appRoutes);

// --- معالجة الأخطاء ---
app.use((err, req, res, next) => {
  logger.error(`Unhandled error for request ${req.requestId}:`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

module.exports = app;
