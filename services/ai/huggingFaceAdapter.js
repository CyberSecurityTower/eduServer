// services/ai/huggingFaceAdapter.js
'use strict';
const fetch = require('node-fetch'); // تأكد أنك تستخدم node-fetch v2 أو v3 المدعوم

// قائمة الموديلات القوية (رتبناها حسب القوة)
const MODELS = {
    'deepseek': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', // موديل قوي جداً وذكي
    'qwen': 'Qwen/Qwen2.5-72B-Instruct',                   // منافس شرس لـ GPT-4
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'           // الخيار الكلاسيكي القوي
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history) {
    // 1. تحويل الهيستوري من صيغة Gemini إلى صيغة OpenAI/HF
    // Gemini: { role: 'user'|'model', text: '...' }
    // HF: { role: 'user'|'assistant', content: '...' }
    
    let messages = [];

    // إضافة System Prompt
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }

    // تحويل الهيستوري
    if (history && Array.isArray(history)) {
        history.forEach(msg => {
            messages.push({
                role: msg.role === 'model' ? 'assistant' : 'user',
                content: msg.text || msg.parts?.[0]?.text || ''
            });
        });
    }

    // إضافة الرسالة الحالية
    messages.push({ role: 'user', content: prompt });

    // اختيار الموديل (DeepSeek هو الأفضل حالياً للذكاء)
    const modelUrl = `https://api-inference.huggingface.co/models/${MODELS.deepseek}`;

    try {
        const response = await fetch(modelUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false' // نطلب عدم استخدام الكاش للحصول على ردود جديدة
            },
            body: JSON.stringify({
                inputs: messages, // بالنسبة لبعض الموديلات نرسل inputs كنص، وللبعض array
                // ملاحظة: واجهة Inference API الجديدة تدعم Chat Completion
                // إذا لم تعمل inputs كمصفوفة، نحتاج استخدام endpoint مختلف، لكن DeepSeek يدعمها غالباً
                parameters: {
                    max_new_tokens: 2048,
                    temperature: 0.7,
                    return_full_text: false
                }
            })
        });

        // التعامل مع حالة تحميل الموديل (503)
        if (response.status === 503) {
            const errData = await response.json();
            throw new Error(`503_LOADING:${errData.estimated_time || 10}`);
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HF_ERROR_${response.status}: ${errText}`);
        }

        const result = await response.json();

        // تنسيق الرد ليطابق صيغة Gemini (text)
        // عادة HF يرجع مصفوفة: [{ generated_text: "..." }]
        let outputText = '';
        if (Array.isArray(result) && result[0]) {
             // أحياناً يكون generated_text، وأحياناً يحتاج تنظيف
             outputText = result[0].generated_text || result[0].message?.content || '';
             
             // تنظيف الرد إذا أعاد تكرار البرومبت (مشكلة شائعة في HF)
             // (الكود هنا مبسط، DeepSeek عادة يرجع الرد فقط مع المعاملات الصحيحة)
        } else if (result.generated_text) {
             outputText = result.generated_text;
        }

        return outputText;

    } catch (error) {
        throw error;
    }
}

module.exports = { callHuggingFace };
