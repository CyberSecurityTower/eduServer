// services/ai/huggingFaceAdapter.js
'use strict';
const fetch = require('node-fetch');

const MODELS = {
    // هذا الموديل قوي جداً (32B) وممتاز في التفكير
    'deepseek': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 
    'qwen': 'Qwen/Qwen2.5-72B-Instruct',
    'llama': 'meta-llama/Llama-3.3-70B-Instruct'
};

async function callHuggingFace(apiKey, prompt, systemInstruction, history, modelKey = 'deepseek') {
    
    // إعداد الرسائل
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

    const modelId = MODELS[modelKey];
    const url = `https://api-inference.huggingface.co/models/${modelId}`;

    // console.log(`🔌 Connecting to HF Model: ${modelId}`); // Un-comment for deep debug

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false' 
            },
            body: JSON.stringify({
                messages: messages, // الواجهة الجديدة تدعم messages مباشرة
                max_tokens: 2048,
                temperature: 0.7,
                stream: false
            })
        });

        // التعامل مع الخطأ 503 (الموديل قيد التحميل)
        if (response.status === 503) {
            const errData = await response.json();
            throw new Error(`503_LOADING:${errData.estimated_time || 5}`);
        }

        if (!response.ok) {
            const errText = await response.text();
            // أحياناً يرجع 422 إذا كان الإدخال طويلاً جداً
            throw new Error(`HF_ERROR_${response.status}: ${errText.substring(0, 100)}`);
        }

        const result = await response.json();
        
        // استخراج الرد (يدعم chat completion format)
        let outputText = '';
        
        // فحص الهيكل الراجع من HF
        if (result.choices && result.choices[0] && result.choices[0].message) {
            outputText = result.choices[0].message.content;
        } 
        else if (Array.isArray(result) && result[0]) {
             // Fallback for older API format
             outputText = result[0].generated_text || result[0].message?.content || '';
        } 
        else if (result.generated_text) {
             outputText = result.generated_text;
        }

        // تنظيف الرد من "التفكير" <think> إذا كان DeepSeek
        // (اختياري: يمكنك تركه إذا أردت رؤية كيف يفكر الموديل)
        // outputText = outputText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        return outputText;

    } catch (error) {
        throw error;
    }
}

module.exports = { callHuggingFace };
