// src/utils/scraper.js
'use strict';

const logger = require('./logger');

/**
 * يقوم بجلب محتوى الرابط وتنظيفه من أكواد HTML
 * @param {string} url 
 * @returns {Promise<string>} المحتوى النصي
 */
async function fetchUrlContent(url) {
  try {
    // 1. فحص صحة الرابط
    if (!url || !url.startsWith('http')) return '';

    // 2. الجلب (Timeout 5 ثواني لكي لا نعطل الشات)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { 
        signal: controller.signal,
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EduAIBot/1.0; +http://eduai.app)' // لكي لا ترفضنا المواقع
        }
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) return `[Error: Unable to access URL ${url} - Status: ${response.status}]`;

    const html = await response.text();

    // 3. تنظيف الـ HTML (Simple Regex approach)
    // نحذف السكربتات والستايل أولاً
    let text = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                   .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "");
    
    // نحذف باقي التاجات
    text = text.replace(/<[^>]*>?/gm, ' ');
    
    // تنظيف المسافات الزائدة
    text = text.replace(/\s+/g, ' ').trim();

    // نأخذ أول 6000 حرف فقط (لتوفير التوكيز)
    return `\n\n--- [URL Context Start: ${url}] ---\n${text.substring(0, 6000)}\n--- [URL Context End] ---\n`;

  } catch (error) {
    logger.warn(`Scraper Failed for ${url}: ${error.message}`);
    return `[System: Failed to read content from ${url}]`;
  }
}

module.exports = { fetchUrlContent };
