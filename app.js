// app.js
'use strict';

const express = require('express');
const cors = require('cors');
const requestIdMiddleware = require('./middleware/requestId'); 
const rateLimiter = require('./middleware/rateLimiter');
const appRoutes = require('./routes');
const logger = require('./utils/logger');
const activityTracker = require('./middleware/activityTracker'); 

const app = express();

// --- إعدادات Middleware ---

// ✅ أضف هذا السطر قبل المسارات (Routes)
// ملاحظة: لكي يلتقط الـ ID، يفضل وضعه هنا، لكنه سيسجل الطلبات "المجهولة" حتى يتم التحقق من التوكن
// الحل الأفضل: نضعه هنا ليحسب الـ RPM العام، ونعتمد على التوكن إذا توفر
app.use((req, res, next) => {
    // محاولة بسيطة لقراءة التوكن إذا لم يمر عبر requireAuth بعد
    if (!req.user && req.headers.authorization) {
        const token = req.headers.authorization.split(' ')[1];
        // فك تشفير بسيط للحصول على ID فقط (لأغراض الإحصاء)
        const base64Url = token.split('.')[1];
        if(base64Url) {
            try {
                const payload = JSON.parse(Buffer.from(base64Url, 'base64').toString());
                req.temp_user_id = payload.sub; // sub هو الـ ID في Supabase
            } catch(e) {}
        }
    }
    next();
});

// تفعيل التراكر
app.use((req, res, next) => {
    // نمرر الـ ID سواء من req.user (الموثوق) أو req.temp_user_id (السريع)
    const uid = req.user?.id || req.temp_user_id;
    require('./services/monitoring/liveStats').trackRequest(uid);
    next();
});
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
