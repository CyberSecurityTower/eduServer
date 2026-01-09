// src/utils/scraper.js
'use strict';

const logger = require('./logger');

// الدالة الداخلية للجلب (كما هي)
async function _fetchContent(url) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 ثواني فقط
        
        const res = await fetch(url, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'EduAIBot/1.0' } 
        });
        clearTimeout(timeoutId);
        
        if (!res.ok) return '';
        const html = await res.text();
        // تنظيف سريع
        const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gim, "")
                         .replace(/<style[^>]*>[\s\S]*?<\/style>/gim, "")
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ').trim();
        return text.substring(0, 5000);
    } catch (e) {
        return '';
    }
}

/**
 * دالة ذكية: تأخذ الرسالة، تفحص وجود روابط، تجلب المحتوى، وترجع الرسالة "مدعمة"
 * إذا لم تجد روابط، ترجع الرسالة كما هي.
 */
async function enrichMessageWithContext(message) {
    if (!message) return "";

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const foundUrls = message.match(urlRegex);

    if (foundUrls && foundUrls.length > 0) {
        // نأخذ أول رابط فقط
        const url = foundUrls[0];
        const content = await _fetchContent(url);
        
        if (content) {
            return `${message}\n\n--- [URL Context: ${url}] ---\n${content}\n--- [End Context] ---`;
        }
    }

    return message;
}

module.exports = { enrichMessageWithContext };
