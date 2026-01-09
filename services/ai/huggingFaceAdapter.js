// services/ai/huggingFaceAdapter.js
'use strict';
const fetch = require('node-fetch');

// سنستخدم Qwen حالياً لأنه أسرع وأكثر استقراراً في التجربة من DeepSeek
const MODELS = {
    'deepseek': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 
    'qwen': 'Qwen/Qwen2.5-72B-Instruct', 
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history, modelKey = 'qwen') { // 👈 غيرنا الافتراضي لـ Qwen للتجربة
    
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

    const modelId = MODELS[modelKey] || MODELS['qwen'];
    const url = `https://api-inference.huggingface.co/models/${modelId}`;

    console.log(`🔌 HF Request: Model=${modelId} | Key=${apiKey.substring(0, 5)}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false',
                'x-wait-for-model': 'true' // 🔥 هذا هو السطر السحري! يخبرهم بالانتظار حتى يصحو الموديل
            },
            body: JSON.stringify({
                messages: messages, 
                max_tokens: 2048,
                temperature: 0.6
            })
        });

        const result = await response.json();

        // 🛑 التقاط الأخطاء وطباعتها بوضوح
        if (!response.ok) {
            console.error('❌ HF RAW ERROR:', JSON.stringify(result)); // لترى الخطأ في اللوج
            
            // إذا كان الخطأ 503، يعني الموديل يجهز نفسه
            if (result.error && result.error.includes('loading')) {
                throw new Error(`503_LOADING:${result.estimated_time || 5}`);
            }
            // أخطاء أخرى (مثل المفتاح غلط، أو الموديل يحتاج موافقة)
            throw new Error(`HF_API_ERROR: ${JSON.stringify(result)}`);
        }

        // استخراج النص
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
        // إعادة رمي الخطأ ليتم التقاطه في index.js
        throw error;
    }
}

module.exports = { callHuggingFace };
