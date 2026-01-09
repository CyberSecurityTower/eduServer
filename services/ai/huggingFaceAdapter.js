// services/ai/huggingFaceAdapter.js
'use strict';
const fetch = require('node-fetch');

// 🧠 قائمة العباقرة (موديلات قوية ومجانية على Inference API)
const MODELS = {
    // موديل قوي جداً في التفكير المنطقي والبرمجة
    'deepseek': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 
    // منافس شرس لـ GPT-4
    'qwen': 'Qwen/Qwen2.5-72B-Instruct',
    // احتياطي كلاسيكي قوي
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history, modelKey = 'deepseek') {
    
    // 1. تحويل الهيستوري من Gemini Format إلى OpenAI/HF Format
    let messages = [];

    // System Prompt
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }

    // Chat History
    if (history && Array.isArray(history)) {
        history.forEach(msg => {
            messages.push({
                role: msg.role === 'model' ? 'assistant' : 'user',
                content: msg.text || (msg.parts ? msg.parts[0].text : '')
            });
        });
    }

    // Current Prompt
    messages.push({ role: 'user', content: prompt });

    const modelId = MODELS[modelKey] || MODELS['deepseek'];
    const url = `https://api-inference.huggingface.co/models/${modelId}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false' // نطلب عدم استخدام الكاش للحصول على إجابة جديدة
            },
            body: JSON.stringify({
                inputs: messages, // النظام الجديد يدعم messages مباشرة للموديلات الحديثة
                parameters: {
                    max_new_tokens: 2048,
                    temperature: 0.7,
                    return_full_text: false
                }
            })
        });

        // التعامل مع حالة "الموديل نائم ويحتاج تحميل"
        if (response.status === 503) {
            const errData = await response.json();
            throw new Error(`503_LOADING:${errData.estimated_time || 5}`);
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HF_ERROR_${response.status}: ${errText}`);
        }

        const result = await response.json();
        
        // استخراج النص (يختلف حسب الموديل، هذا الكود يتعامل مع الأشكال الشائعة)
        let outputText = '';
        if (Array.isArray(result) && result[0]) {
             outputText = result[0].generated_text || result[0].message?.content || '';
             // تنظيف: أحياناً يرجع الموديل البرومبت معه، نزيله إذا لزم الأمر
        } else if (result.generated_text) {
             outputText = result.generated_text;
        }

        return outputText;

    } catch (error) {
        throw error;
    }
}

module.exports = { callHuggingFace };
