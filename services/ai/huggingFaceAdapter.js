'use strict';
const fetch = require('node-fetch');

const MODELS = {
    // نستخدم Qwen عبر الـ Router الجديد
    'deepseek': 'Qwen/Qwen2.5-72B-Instruct', 
    'qwen': 'Qwen/Qwen2.5-72B-Instruct', 
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history, modelKey = 'deepseek') {
    
    // تجهيز الرسائل
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
    
    // ✅ التصحيح: العودة إلى رابط Router لأنه هو الوحيد المدعوم الآن
    const url = `https://router.huggingface.co/hf-inference/models/${modelId}`;

    console.log(`🔌 HF Request: Model=${modelId} | KeyPrefix=${apiKey ? apiKey.substring(0, 4) : 'NULL'}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false',
                'x-wait-for-model': 'true'
            },
            body: JSON.stringify({
                messages: messages, 
                max_tokens: 2048,
                temperature: 0.6,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            let errJson;
            try { errJson = JSON.parse(errText); } catch (e) { errJson = { error: errText }; }

            console.error('❌ HF API ERROR:', JSON.stringify(errJson)); 

            if (response.status === 503 || JSON.stringify(errJson).toLowerCase().includes('loading')) {
                throw new Error(`503_LOADING:${errJson.estimated_time || 10}`);
            }
            
            throw new Error(`HF_API_ERROR: ${errJson.error || response.statusText}`);
        }

        const result = await response.json();
        
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
