// services/ai/huggingFaceAdapter.js
'use strict';
const fetch = require('node-fetch');

const MODELS = {
    'deepseek': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 
    'qwen': 'Qwen/Qwen2.5-72B-Instruct', 
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history, modelKey = 'deepseek') { // نعود لـ deepseek كافتراضي
    
    // 1. تجهيز الرسائل
    let messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    
    if (history && Array.isArray(history)) {
        history.forEach(msg => {
            messages.push({
                role: msg.role === 'model' ? 'assistant' : 'user',
                content: msg.text || (msg.parts ? msg.parts[0].text : '')
            });
        });
    }
    messages.push({ role: 'user', content: prompt });

    const modelId = MODELS[modelKey] || MODELS['deepseek'];
    
    // 🔥🔥 التصحيح الحاسم هنا: استخدام الرابط الجديد (Router) 🔥🔥
    const url = `https://router.huggingface.co/hf-inference/models/${modelId}`;
    console.log(`🕵️‍♂️ DEBUG KEY: Start='${apiKey ? apiKey.substring(0, 4) : 'NULL'}' | Length=${apiKey ? apiKey.length : 0} | HasSpace=${apiKey.includes(' ')}`);

    // طباعة للتأكد في اللوج
    console.log(`🔌 HF Request (Router): Model=${modelId} | Key=${apiKey.substring(0, 5)}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false',
                'x-wait-for-model': 'true' // إجبار الانتظار للموديلات النائمة
            },
            body: JSON.stringify({
                messages: messages, 
                max_tokens: 2048,
                temperature: 0.6,
                stream: false
            })
        });

        // التعامل مع الأخطاء
        if (!response.ok) {
            const errText = await response.text();
            let errJson;
            try { errJson = JSON.parse(errText); } catch (e) { errJson = { error: errText }; }

            console.error('❌ HF ROUTER ERROR:', JSON.stringify(errJson)); 

            // إذا كان الموديل يتحمل (Loading)
            if (response.status === 503 || (errJson.error && errJson.error.includes('loading'))) {
                throw new Error(`503_LOADING:${errJson.estimated_time || 5}`);
            }
            
            // أخطاء أخرى
            throw new Error(`HF_API_ERROR: ${errJson.error || response.statusText}`);
        }

        const result = await response.json();
        
        // استخراج الرد
        let outputText = '';
        if (result.choices && result.choices[0]) {
            outputText = result.choices[0].message.content;
        } else if (Array.isArray(result) && result[0]) {
            outputText = result[0].generated_text || result[0].message?.content || '';
        } else if (result.generated_text) {
            outputText = result.generated_text;
        }

        if (!outputText) throw new Error('HF returned empty response');

        return outputText;

    } catch (error) {
        throw error;
    }
}

module.exports = { callHuggingFace };
