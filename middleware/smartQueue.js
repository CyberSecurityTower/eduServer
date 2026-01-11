// middleware/smartQueue.js
'use strict';

const logger = require('../utils/logger');

const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB Total Buffer
const MAX_QUEUE_SIZE = 50; 
const QUEUE_TIMEOUT_MS = 300000; // دقيقة واحدة كحد أقصى للانتظار في الطابور

let currentLoadBytes = 0;
let requestQueue = []; // غيّرناها لـ let لنتمكن من التعديل عليها بسهولة

const processQueue = () => {
    if (requestQueue.length === 0) return;

    // تصفية الطلبات التي انتهت مهلة انتظارها
    const now = Date.now();
    requestQueue = requestQueue.filter(item => {
        if (now - item.queuedAt > QUEUE_TIMEOUT_MS) {
            item.reject('Queue timeout'); // نرفض الطلب
            return false;
        }
        return true;
    });

    // محاولة تمرير الطلبات
    // نستخدم نسخة للتكرار لأننا سنعدل المصفوفة الأصلية
    const queueSnapshot = [...requestQueue]; 
    
    for (const item of queueSnapshot) {
        if (currentLoadBytes + item.size <= MAX_TOTAL_BYTES) {
            // 1. حجز المساحة
            currentLoadBytes += item.size;
            
            // 2. إزالة من الطابور
            requestQueue = requestQueue.filter(q => q.id !== item.id);
            
            // 3. السماح بالمرور
            logger.log(`🚦 Queue Released: ${(item.size / 1024 / 1024).toFixed(2)}MB. Load: ${(currentLoadBytes / 1024 / 1024).toFixed(2)}MB`);
            item.next();
        }
    }
};

const smartQueueMiddleware = (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength === 0) return next();

    // دالة لتنظيف الحمل عند انتهاء الطلب
    const cleanup = () => {
        currentLoadBytes -= contentLength;
        if (currentLoadBytes < 0) currentLoadBytes = 0;
        processQueue(); // نداء للطلبات التالية
    };

    // 1. المسار السريع
    if (currentLoadBytes + contentLength <= MAX_TOTAL_BYTES) {
        currentLoadBytes += contentLength;
        res.on('finish', cleanup);
        res.on('close', cleanup);
        return next();
    }

    // 2. الطابور
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'Server busy. Queue full.' });
    }

    logger.warn(`🟡 Queued request (${(contentLength/1024/1024).toFixed(2)}MB). Position: ${requestQueue.length + 1}`);

    // إضافة للطابور مع Timestamp ومعرف فريد
    const queueItem = {
        id: Date.now() + Math.random(),
        size: contentLength,
        queuedAt: Date.now(),
        next: () => {
            res.on('finish', cleanup);
            res.on('close', cleanup);
            next();
        },
        reject: (reason) => {
            if (!res.headersSent) res.status(503).json({ error: reason });
        }
    };
    
    requestQueue.push(queueItem);
};

module.exports = smartQueueMiddleware;
