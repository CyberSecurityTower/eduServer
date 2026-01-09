'use strict';
const fetch = require('node-fetch');

// 🟢 استخدام موديلات مستقرة ومجانية
const MODELS = {
    // سنستخدم Qwen 2.5 بدلاً من DeepSeek لأنه متاح ومستقر ومجاني حالياً
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

    // اختيار الموديل
    const modelId = MODELS[modelKey] || MODELS['deepseek'];
    
    // 🟢 التغيير هنا: استخدام الرابط القياسي (api-inference) بدلاً من router لتجنب أخطاء Not Found
    const url = `https://api-inference.huggingface.co/models/${modelId}`;

    console.log(`🔌 HF Request: Model=${modelId} | KeyPrefix=${apiKey ? apiKey.substring(0, 4) : 'NULL'}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-use-cache': 'false',
                'x-wait-for-model': 'true' // مهم جداً للانتظار
            },
            body: JSON.stringify({
                messages: messages, 
                max_tokens: 2048, // تقليل التوكنز قليلاً لضمان السرعة
                temperature: 0.6,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            let errJson;
            try { errJson = JSON.parse(errText); } catch (e) { errJson = { error: errText }; }

            console.error('❌ HF API ERROR:', JSON.stringify(errJson)); 

            // التعامل مع تحميل الموديل (Model Loading)
            if (response.status === 503 || (errJson.error && JSON.stringify(errJson).toLowerCase().includes('loading'))) {
                // هذا الخطأ طبيعي في البداية، يعني أن الموديل يستيقظ
                throw new Error(`503_LOADING:${errJson.estimated_time || 10}`);
            }
            
            throw new Error(`HF_API_ERROR: ${errJson.error || response.statusText}`);
        }

        const result = await response.json();
        
        // استخراج الرد بمرونة
        let outputText = '';
        if (result.choices && result.choices[0]) {
            outputText = result.choices[0].message.content;
        } else if (Array.isArray(result) && result[0]) {
            // أحياناً HF يرجع مصفوفة مباشرة
            outputText = result[0].generated_text || result[0].message?.content || '';
        } else if (result.generated_text) {
            outputText = result.generated_text;
        }

        // تنظيف الرد إذا كان يحتوي على System prompt بالخطأ
        if (typeof outputText === 'string' && outputText.includes(prompt)) {
             // بعض الموديلات تعيد السؤال، نحذفه
             outputText = outputText.replace(prompt, '').trim();
        }

        if (!outputText) throw new Error('HF returned empty response');

        return outputText;

    } catch (error) {
        throw error;
    }
}

module.exports = { callHuggingFace };
