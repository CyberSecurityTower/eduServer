// controllers/workLensController.js
'use strict';

const supabase = require('../services/data/supabase');
const logger = require('../utils/logger');

/**
 * 🔍 WorkLens Core Engine
 * البحث الموحد في (المرفوعات + المشتريات + المتجر)
 */
async function executeSearch(req, res) {
    const { query, scope } = req.body;
    const userId = req.user?.id;

    // 1. التحقق من المدخلات
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.json({ success: true, count: 0, results: [] });
    }

    // تحديد نطاق البحث الافتراضي
    // scopes: 'workspace' (ملفاتي) | 'store' (المتجر العام)
    const searchScope = (scope === 'store') ? 'store' : 'workspace';

    try {
        const startTime = Date.now();
        
        // 2. استدعاء المحرك في قاعدة البيانات (RPC)
        const { data, error } = await supabase.rpc('search_worklens_v1', {
            query_text: query.trim(),
            search_scope: searchScope,
            requesting_user_id: userId
        });

        if (error) {
            // خطأ في قاعدة البيانات (مثل أن الدالة غير موجودة بعد)
            console.error("❌ WorkLens RPC Error:", error.message);
            throw error;
        }

        const duration = Date.now() - startTime;
        
        // 3. تنسيق النتائج (Data Formatting)
        // نحول البيانات الخام إلى شكل موحد يفهمه الفرونت أند بسهولة
        const formattedResults = (data || []).map(item => {
            // تحديد نوع الملف (لأجل الأيقونات في التطبيق)
            let itemType = 'unknown';
            let contextLabel = '';

            if (item.origin_table === 'lesson_sources') {
                itemType = 'upload'; // ملف مرفوع
                contextLabel = 'My Uploads';
            } else if (item.origin_table === 'store_items') {
                // إذا كنا في الووركسبايس فهو "شراء"، وإذا في الستور فهو "منتج"
                itemType = searchScope === 'workspace' ? 'purchased_item' : 'store_product';
                contextLabel = searchScope === 'workspace' ? 'Purchased' : 'EduStore';
            }

            return {
                id: item.object_id,          // الآيدي الحقيقي للملف/المنتج
                title: item.title,
                description: item.description, // قد يكون null
                type: itemType,              // upload | purchased_item | store_product
                context: contextLabel,       // نص توضيحي (مثلاً "من ملفاتك")
                relevance: item.rank         // درجة تطابق البحث (للتطوير المستقبلي)
            };
        });

        // طباعة للمراقبة (اختياري)
        // console.log(`🔍 WorkLens: "${query}" [${searchScope}] -> found ${formattedResults.length} items in ${duration}ms`);

        return res.json({
            success: true,
            meta: {
                query,
                scope: searchScope,
                duration_ms: duration
            },
            count: formattedResults.length,
            results: formattedResults
        });

    } catch (err) {
        logger.error('WorkLens Controller Error:', err.message);
        return res.status(500).json({ error: 'Internal search error' });
    }
}

module.exports = { executeSearch };
