
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');
const LRUCache = require('../services/data/cache');

// كاش بسيط لتخزين مفتاح الـ API
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
    // 1. طباعة الطلب القادم من الفرونت اند
    console.log('\n🔵 [Quick Search] Incoming Request:');
    console.log('📥 Body:', JSON.stringify(req.body, null, 2));
    console.log('👤 User ID:', req.user ? req.user.id : 'No Auth Info');

    const { query, language = 'Arabic' } = req.body;

    if (!query) {
        console.log('⚠️ Error: Query is missing in request body.');
        return res.status(400).json({ error: 'Search query is required' });
    }

    try {
        // 2. جلب المفتاح
        const apiKey = await getQuickSearchKey();
        
        if (!apiKey) {
            console.error('❌ Error: API Key is missing in Database/Settings.');
            logger.error('Quick Search: API Key not found in system_settings');
            return res.status(503).json({ error: 'Service configuration error' });
        }

        console.log('🔑 API Key retrieved successfully.');

        // 3. إعداد الاتصال بجوجل
        const genAI = new GoogleGenerativeAI(apiKey);
        const modelName = 'gemini-2.5-flash-lite';
        console.log(`🤖 Initializing Model: ${modelName}`);
        
        const model = genAI.getGenerativeModel({ model: modelName });

        const prompt = `
        You are a quick dictionary and fact-checker.
        User Query: "${query}"
        
        Task: Provide a direct, concise definition or explanation in ${language}.
        - Max 3 sentences.
        - No filler words (like "Here is the answer").
        - If it's a scientific term, define it simply.
        `;
        
        console.log('📝 Prompt sent to AI:', prompt);

        // 4. إرسال الطلب وانتظار الرد
        const result = await model.generateContent(prompt);
        
        // طباعة كائن الاستجابة الخام من جوجل (للتشخيص العميق)
        console.log('🤖 Raw Google Response Object:', JSON.stringify(result, null, 2));

        const response = await result.response;
        const text = response.text();

        // 5. طباعة ما تم إرجاعه وتجهيزه للفرونت اند
        console.log('✅ AI Text Generated:', text);

        const responsePayload = { 
            result: text, 
            source: 'ai_quick_search' 
        };

        console.log('📤 Sending Response to Frontend:', JSON.stringify(responsePayload, null, 2));
        console.log('--------------------------------------------------\n');

        return res.json(responsePayload);

    } catch (error) {
        // 6. طباعة الأخطاء بالتفصيل الممل
        console.error('\n❌ [Quick Search] CRITICAL ERROR:');
        console.error('⚠️ Error Message:', error.message);
        
        // طباعة تفاصيل الخطأ القادمة من جوجل (إذا وجدت)
        if (error.response) {
            console.error('🛑 Google API Error Details:', JSON.stringify(error.response, null, 2));
        }
        
        // طباعة الـ Stack Trace لمعرفة مكان الخطأ في الكود
        console.error('📍 Stack Trace:', error.stack);
        console.log('--------------------------------------------------\n');

        logger.error('Quick Search Error:', error.message);
        return res.status(500).json({ 
            error: 'Failed to fetch results.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined 
        });
    }
}

module.exports = { quickSearch };
