
// app.js
'use strict';

const express = require('express');
const cors = require('cors');
const requestIdMiddleware = require('./middleware/requestId'); 
const rateLimiter = require('./middleware/rateLimiter');
const activityTracker = require('./middleware/activityTracker'); 
const appRoutes = require('./routes');
const logger = require('./utils/logger');

const app = express();

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// --- إعدادات Middleware (مرة واحدة فقط) ---

// 1. CORS & Security Headers
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-job-secret', 'x-admin-secret', 'x-cron-secret']
}));

// 2. تحليل JSON
app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));

// 3. تتبع الطلبات (Request ID)
app.use(requestIdMiddleware);

// 4. 🔥 التتبع النشط (Activity Tracker) - يوضع قبل Rate Limiter لحساب النشاط
app.use(activityTracker);

// 5. الحماية من التكرار (Rate Limiter)
app.use(rateLimiter);

// --- المسارات Routes ---

app.get('/', (req, res) => {
  res.status(200).send('EduAI Server Brain V2.1 is Running ✅');
});

// توجيه كل الطلبات للملف الموحد
app.use('/', appRoutes);

// --- معالجة الأخطاء Global Error Handler ---
app.use((err, req, res, next) => {
  logger.error(`Unhandled error for request ${req.requestId}:`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An unexpected internal error occurred.' });
  }
});

module.exports = app;
