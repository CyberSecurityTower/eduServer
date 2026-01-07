
--- START OF FILE searchController.js ---
// controllers/searchController.js
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const LRUCache = require('../services/data/cache');

// كاش بسيط لتخزين مفتاح الـ API حتى لا نطلبه من الداتابايز في كل مرة
const keyCache = new LRUCache(1, 1000 * 60 * 60); // ساعة واحدة

async function getQuickSearchKey() {
    let key = keyCache.get('QUICK_SEARCH_KEY');
    if (key) return key;

    const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'QUICK_SEARCH_API_KEY')
        .single();
    
    if (data && data.value) {
        keyCache.set('QUICK_SEARCH_KEY', data.value);
        return data.value;
    }
    return null;
}

async function quickSearch(req, res) {
    const { query, language = 'Arabic' } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    try {
        // 1. جلب المفتاح المخصص
        const apiKey = await getQuickSearchKey();
        
        if (!apiKey) {
            logger.error('Quick Search: API Key not found in system_settings');
            return res.status(503).json({ error: 'Service configuration error' });
        }

        // 2. إعداد الاتصال المباشر (تجاوز الـ KeyManager)
        const genAI = new GoogleGenerativeAI(apiKey);
        // نستخدم الموديل الخفيف والسريع كما طلبت
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' }); 
        // ملاحظة: تأكد من اسم الموديل الدقيق في جوجل، حالياً gemini-2.0-flash-lite-preview-02-05 هو الأحدث، 
        // أو استخدم 'gemini-1.5-flash' إذا لم يكن 2.5 متاحاً للعامة بعد باسمه الرسمي.

        // 3. هندسة البرومبت للاستجابة السريعة
        const prompt = `
        You are a quick dictionary and fact-checker.
        User Query: "${query}"
        
        Task: Provide a direct, concise definition or explanation in ${language}.
        - Max 3 sentences.
        - No filler words (like "Here is the answer").
        - If it's a scientific term, define it simply.
        `;

        // 4. الطلب
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        return res.json({ 
            result: text, 
            source: 'ai_quick_search' 
        });

    } catch (error) {
        logger.error('Quick Search Error:', error.message);
        return res.status(500).json({ error: 'Failed to fetch results.' });
    }
}

module.exports = { quickSearch };
