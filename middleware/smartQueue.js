// middleware/smartQueue.js
'use strict';

const logger = require('../utils/logger');

// إعدادات السعة (Budget)
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // السقف الإجمالي: 100 ميغا
const MAX_QUEUE_SIZE = 50; // طابور الانتظار: أقصى حد 50 شخص يستناو

// حالة النظام الحالية (State)
let currentLoadBytes = 0;
const requestQueue = [];

/**
 * دالة لمحاولة تمرير المنتظرين في الطابور
 */
const processQueue = () => {
    if (requestQueue.length === 0) return;

    // نرتبو الطابور؟ لا، نخلوه FIFO (الأول فالأول) باش ما نحقروش مول الملف الكبير
    // لكن الذكاء هنا: نفوتو أي واحد "يسمح بيه الحجم المتبقي"
    
    // ننسخ الطابور للتعديل
    for (let i = 0; i < requestQueue.length; i++) {
        const item = requestQueue[i];
        
        // هل المكان يكفي لهذا الملف؟
        if (currentLoadBytes + item.size <= MAX_TOTAL_BYTES) {
            // نزيدو الحمل
            currentLoadBytes += item.size;
            
            // نحوه من الطابور
            requestQueue.splice(i, 1);
            i--; // نعدلو العداد لأننا حذفنا عنصر

            // نسمحولو بالمرور
            // logger.info(`🚦 Queue Released: File size ${(item.size / 1024 / 1024).toFixed(2)}MB. Current Load: ${(currentLoadBytes / 1024 / 1024).toFixed(2)}MB`);
            item.next(); 
        }
    }
};

/**
 * الميدلويير الرئيسي
 */
const smartQueueMiddleware = (req, res, next) => {
    // 1. معرفة حجم الملف قبل رفعه (من الهيدر)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    // إذا ما كاش هيدر أو الحجم 0 (طلب وهمي)، نفوتوه لـ Multer يتصرف معاه
    if (contentLength === 0) return next();

    // 2. التحقق من أن الملف الواحد لا يتجاوز 50 ميغا (حماية أولية)
    if (contentLength > 50 * 1024 * 1024) {
        return res.status(413).json({ error: 'File too large. Max limit is 50MB.' });
    }

    // 3. هل السيرفر فارغ؟ (Direct Pass)
    if (currentLoadBytes + contentLength <= MAX_TOTAL_BYTES) {
        currentLoadBytes += contentLength;
        // console.log(`🟢 Direct Pass. Load: ${(currentLoadBytes/1024/1024).toFixed(2)}MB`);
        
        // نربطو دالة عند انتهاء الطلب (سواء نجح أو فشل) لتنظيف الحجم
        res.on('finish', () => {
            currentLoadBytes -= contentLength;
            // console.log(`🔻 Request Done. Load freed. Current: ${(currentLoadBytes/1024/1024).toFixed(2)}MB`);
            processQueue(); // نشوفو لي وراه
        });
        
        res.on('close', () => { // في حالة انقطاع الاتصال فجأة
             currentLoadBytes -= contentLength;
             processQueue();
        });

        return next();
    }

    // 4. السيرفر معمر -> للطابور (Queue)
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'Server is extremely busy. Please try again later.' });
    }

    // إضافة للطابور
     console.log(`🟡 Queued. Size: ${(contentLength/1024/1024).toFixed(2)}MB`);
    
    requestQueue.push({
        size: contentLength,
        next: () => {
            // نفس منطق التنظيف عند الانتهاء
            res.on('finish', () => {
                currentLoadBytes -= contentLength;
                processQueue();
            });
            res.on('close', () => {
                currentLoadBytes -= contentLength;
                processQueue();
            });
            next();
        }
    });
};

module.exports = smartQueueMiddleware;
