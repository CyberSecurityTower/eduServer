
// services/engines/ghostTeacher.js
'use strict';

const supabase = require('../data/supabase');
const { extractTextFromResult } = require('../../utils');
const logger = require('../../utils/logger');

let generateWithFailoverRef;

// Dependency Injection
function initGhostEngine(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
}

/**
 * 🕵️‍♂️ الماسح الضوئي الذكي (Smart Scanner)
 * يبحث عن الدروس التي ليس لها سجل في جدول المحتوى
 */
async function scanAndFillEmptyLessons() {
  logger.info('👻 Ghost Teacher Scanner Started (Safe Mode)...');
  
  // 1. جلب الدروس فقط (بدون Join لتجنب خطأ العلاقات)
  const { data: allLessons, error: lessonsError } = await supabase
    .from('lessons')
    .select('id, title, subject_id'); // 👈 حذفنا subjects(title)

  if (lessonsError || !allLessons) {
    logger.error('❌ Error loading lessons:', lessonsError?.message);
    return;
  }

  // 2. جلب أسماء المواد يدوياً (Manual Mapping)
  // نجمع كل الـ subject_ids الفريدة
  const subjectIds = [...new Set(allLessons.map(l => l.subject_id).filter(Boolean))];
  
  const { data: subjectsData } = await supabase
    .from('subjects')
    .select('id, title')
    .in('id', subjectIds);

  // نصنع خريطة سريعة: { subject_id: "Math", ... }
  const subjectMap = {};
  if (subjectsData) {
      subjectsData.forEach(s => { subjectMap[s.id] = s.title; });
  }

  // 3. دمج البيانات يدوياً
  const enrichedLessons = allLessons.map(lesson => ({
      ...lesson,
      subjects: { title: subjectMap[lesson.subject_id] || 'General' } // 👈 محاكاة الهيكل القديم
  }));

  // 4. جلب المحتوى الموجود (نفس الكود القديم)
  const { data: existingContents, error: contentError } = await supabase
    .from('lessons_content')
    .select('lesson_id');

  if (contentError) {
    logger.error('❌ Error loading lesson contents:', contentError.message);
    return;
  }

  const existingIds = new Set(existingContents?.map(x => x.lesson_id) || []);

  // 5. الفلترة (نستخدم القائمة المدمجة enrichedLessons)
  const emptyLessons = enrichedLessons.filter(l => !existingIds.has(l.id));

  if (emptyLessons.length === 0) {
    logger.info('👻 All lessons have content. System is clean.');
    return;
  }

  logger.info(`👻 Found ${emptyLessons.length} truly empty lessons. Processing batch of 5...`);

  for (const lesson of emptyLessons.slice(0, 5)) {
    await generateAndSaveLessonContent(lesson);
  }
}

/**
 * Generate lesson Markdown and save it in DB
 */
async function generateAndSaveLessonContent(lesson) {
  try {
      const subjectTitle = lesson.subjects?.title || 'General';
      
      // 🔥 البرومبت المعدل: تم الهروب من علامات التنصيص المائلة (Backticks) لتجنب أخطاء الكود
      const prompt = `
      You are an Academic Content Generator.
      Subject: ${subjectTitle}
      Lesson: "${lesson.title}"

      **Task:** Generate the lesson content in **Formal Arabic (الفصحى)**.
      
      **STRICT RULES:**
      1. **NO INTRODUCTIONS:** Do NOT say "Welcome students", "Today we discuss", or "In this lesson".
      2. **START IMMEDIATELY:** Start directly with the Markdown Title.
      3. **FORMAT:** Use clean Markdown.
      
      **Required Structure:**
      # ${lesson.title}
      
      (Write a direct definition/intro to the concept here...)
      
### CRITICAL FORMATTING RULES (DO NOT IGNORE):
1.  **Direction & Language:** The output MUST be in the same language as the input (Arabic or English). If Arabic, ensure the flow is logical for Right-to-Left reading.
2.  **Bold Headers:** All headers (# H1, ## H2, ### H3) must be concise and catchy.
3.  **Emphasis:** Use **Bold** frequently for key terms, definitions, and important concepts within paragraphs.
4.  **No Nesting:** NEVER put a \`spoiler\`, \`chart\`, or \`steps\` block INSIDE a blockquote (\`> !tip\`). Interactive elements must stand alone on their own lines.
5.  **Math Formatting:** Do NOT use complex LaTeX (like \`\\text{}\`). Write math equations in a clean, readable format inside the \`math\` block. Example: \`H2O -> 2H + O\` or \`Assets = Liabilities + Equity\`.
6.  **Visual Spacing:** Do not stack two visual components (like a Chart and a Table) immediately after each other. Always put a sentence or two of explanation in between.

### YOUR TOOLKIT (Custom Markdown):

**1. Text Structure:**
   - \`# Main Title\` (Only one at the top)
   - \`## Section Title\` (Use for main topics)
   - \`### Sub-section\` (Use for details)
   - \`**Bold**\` for emphasis.
   - \`*\` for bullet points.

**2. Alert Boxes (Blockquotes):**
   - Use these to break monotony.
   - \`> !tip This is a helpful tip.\`
   - \`> !warn Watch out for this common mistake.\`
   - \`> !info Fun fact or extra context.\`
   - \`> !note Key takeaway for exams.\`
   - \`> "Quote text here" | Author Name\`

**3. Interactive Components (Use \`\`\`code blocks):**
   *Write the JSON on a SINGLE line to avoid parsing errors.*

   - **Spoiler (Hidden Info):**
     \`\`\`spoiler The hidden answer is here \`\`\`

   - **Math Equation:**
     \`\`\`math E = mc^2 \`\`\`

   - **Steps (Process/Timeline):**
     Language: \`steps\`
     JSON: \`[{"label": "Step 1", "desc": "Description", "active": true}, {"label": "Step 2", "desc": "Description", "active": false}]\`

   - **Comparison Table:**
     Language: \`table\`
     JSON: \`{"headers": ["Col A", "Col B"], "rows": [["Val 1", "Val 2"], ["Val 3", "Val 4"]]}\`

   - **Charts (Only if data exists):**
     Language: \`chart:pie\` OR \`chart:bar\`
     JSON: \`{"labels": ["A", "B"], "datasets": [{"data": [10, 20]}]}\`

### INPUT PROCESSING:
**Input:** Lesson Title + Source Material.
**Task:**
1.  Start with a hook/intro.
2.  Break down the source into logical sections (H2).
3.  Insert *at least* one interactive element (Table, Steps, or Spoiler) where appropriate.
4.  End with a Summary.

### OUTPUT GENERATION:
Generate the Markdown content now. Ensure no Markdown syntax errors.

أنت مهندس محتوى تعليمي محترف. مهمتك تحويل النص الخام إلى درس Markdown تفاعلي لتطبيق موبايل.

### ⚠️ قواعد صارمة جداً (لا تخالفها أبداً):

1. **تنسيق المكونات التفاعلية (Interactive Components):**
   - يجب كتابة الكود داخل "Code Block" ثلاثي العلامات (\`\`\`).
   - **هام جداً:** يجب أن يكون اسم المكون (اللغة) في السطر الأول، والـ JSON في السطر الثاني، وإغلاق العلامات في السطر الثالث.
   
   ✅ **الشكل الصحيح (مقبول):**
   \`\`\`steps
   [{"label": "خطوة 1", "desc": "شرح", "active": true}]
   \`\`\`

   ❌ **الشكل الخاطئ (مرفوض):**
   \`\`\`steps [{"label": "خطوة 1"}] \`\`\`

2. **قواعد الـ JSON:**
   - يجب أن يكون الـ JSON في **سطر واحد فقط** (Minified).
   - تأكد من إغلاق جميع الأقواس \`[]\` و \`{}\`.
   - لا تضع أي نص إضافي قبل أو بعد الـ JSON داخل البلوك.

3. **اللغة والتنسيق:**
   - اللغة: العربية الفصحى.
   - الاتجاه: النص موجه للعرب (RTL).
   - استخدم **Bold** للكلمات المهمة.
   - العناوين: # للرئيسي، ## للفرعي.

### 🛠️ المكونات المتاحة (انسخ الأسماء بدقة):

- **خطوات (Steps):**
  \`\`\`steps
  [{"label": "العنوان", "desc": "الوصف", "active": true}]
  \`\`\`

- **جدول (Table):**
  \`\`\`table
  {"headers": ["أ", "ب"], "rows": [["1", "2"]]}
  \`\`\`

- **معادلة (Math):**
  \`\`\`math
  الناتج = الدخل - الاستهلاك
  \`\`\`

- **إجابة مخفية (Spoiler):**
  \`\`\`spoiler
  الإجابة الصحيحة هي...
  \`\`\`

- **ملاحظات (Blockquotes):**
  > !tip نصيحة مفيدة
  > !warn تحذير هام
  > !info معلومة إثرائية
  > !note ملاحظة هامة

### المدخلات:
[عنوان الدرس] + [المصدر]

### المخرجات:
كود Markdown فقط، بدون مقدمات أو خاتمة من عندك. ابدأ بالكود فوراً.

4. **التنسيق الجمالي (Visual Styling):**
   - استخدم الفاصل الأفقي \`---\` (ثلاث شرطات) للفصل بين كل قسم رئيسي وآخر. هذا سيتحول تلقائياً لخط فاصل ملون وأنيق.
   - اجعل العنوان الرئيسي للدرس يبدأ بـ \`#\` (هاشتاج واحد).
   - اجعل عناوين الفقرات تبدأ بـ \`##\` (هاشتاجين).
   - لا تستخدم العناوين الفرعية \`###\` إلا للضرورة القصوى. او عنوان الدرس في البداية او العناصر الأساسية
   here's full example:
   
# مدخل نظري عام إلى علم الاقتصاد وعلاقته بالعلوم الأخرى

هل تساءلت يوماً **لماذا لا تستطيع الحكومات طبع النقود وتوزيعها على الجميع لإنهاء الفقر؟** أو لماذا يرتفع سعر السلعة فجأة عندما يقل وجودها في السوق؟
أهلاً بك في عالم الاقتصاد، العلم الذي يحكم قراراتنا اليومية، مصير الشركات، ومستقبل الأمم.

في هذا الدرس، سنغوص في **ماهية الاقتصاد**، تطوره التاريخي، فروعه الأساسية، وعلاقته الوثيقة بالعلوم المحيطة به.

---

## أولاً: مفهوم علم الاقتصاد وأصل التسمية

قبل الخوض في النظريات، دعنا نكتشف جذر الكلمة. كلمة "اقتصاد" (Economics) ليست مصطلحاً حديثاً، بل لها جذور تاريخية عميقة.

> !info **أصل الكلمة (Etymology)**
> تعود كلمة اقتصاد إلى الأصل اليوناني **"Oikonomia"**، وهي كلمة مركبة من شقين: **"Oikos"** وتعني المنزل، و **"Nomos"** وتعني قانون أو إدارة. وبذلك كان المعنى الحرفي هو **"قواعد إدارة المنزل"**.

### تعاريف علم الاقتصاد عبر التاريخ
تطور تعريف الاقتصاد بتطور الفكر البشري، وإليك أبرز وجهات النظر:

**1. آدم سميث (Adam Smith) - أب الاقتصاد الحديث:**
عرفه في كتابه الشهير "ثروة الأمم" (1776م) بأنه **"علم الثروة"**. حيث يركز على الوسائل التي تمكن الأمم من الاغتناء.

**2. ميلتون فريدمان (Milton Friedman):**
يرى أن الاقتصاد هو **"العلم الذي يدرس الطرق التي تمكن المجتمع من حل مشاكله الاقتصادية"**.

**3. النظرية الكلاسيكية الجديدة (New Classical):**
تعتمد هذه المدرسة على **العقلانية (Rationality)** والتحليل الرياضي الدقيق.

> !note **جوهر النظرية الكلاسيكية الجديدة:**
> تفترض أن الأسواق تضبط نفسها بنفسها (Market Clearing)، وأن الأفراد يتصرفون دائماً بعقلانية لتعظيم منافعهم. وتعتمد هذه المدرسة بشكل كبير على **النمذجة الرياضية** لإثبات صحة نظرياتها.

**4. التعريف الشامل (علم الندرة):**
هو العلم الذي يدرس السلوك الإنساني كعلاقة بين **حاجات غير محدودة** و **موارد نادرة** ذات استعمالات بديلة.

حاول تخمين المعادلة الأساسية للمشكلة الاقتصادية قبل كشفها:

\`\`\`spoiler
المشكلة الاقتصادية = حاجات بشرية لا نهائية + موارد طبيعية محدودة
\`\`\`

---

## ثانياً: منهجية البحث وعلاقته بالعلوم الأخرى

الاقتصاد ليس جزيرة معزولة، بل هو علم اجتماعي يتفاعل بذكاء مع العلوم الأخرى.

> !tip **طبيعة البحث الاقتصادي:**
> يعتمد الاقتصاد في دراسته على المنهج **الوصفي والتحليلي**. فهو يبدأ بوصف الظاهرة (مثل البطالة)، ثم ينتقل لتحليلها باستخدام الأدوات الرياضية والإحصائية لاستخلاص النتائج والتوقعات.

### شبكة العلاقات مع العلوم الأخرى:
*   **علم الاجتماع:** الاقتصاد يدرس سلوك الإنسان، وعلم الاجتماع يدرس البيئة التي يعيش فيها. لا يمكن فهم الاستهلاك دون فهم المجتمع.
*   **السياسة:** العلاقة وثيقة جداً (الاقتصاد السياسي). الاستقرار السياسي يجذب الاستثمار، والقرارات الاقتصادية قد تسقط حكومات.
*   **الإحصاء والرياضيات:** هما لغة الاقتصاد الحديث (الاقتصاد القياسي)، حيث نحول النظريات إلى أرقام ومعادلات دقيقة.
*   **التاريخ:** هو المعمل الذي نستفيد فيه من تجارب الماضي (مثل أزمة 1929) لتجنب أخطاء المستقبل.
                               
---

## ثالثاً: أقسام علم الاقتصاد (الجزئي والكلي)

ينقسم علم الاقتصاد عادة إلى فرعين رئيسيين يكملان بعضهما البعض، مثل النظر إلى "شجرة واحدة" مقابل النظر إلى "الغابة بأكملها".

**1. الاقتصاد الجزئي (Microeconomics):** المجهر الذي يدرس سلوك الفرد أو الشركة الواحدة.
**2. الاقتصاد الكلي (Macroeconomics):** النظرة الشاملة للاقتصاد القومي ككل.

إليك مقارنة دقيقة بين الفرعين:

\`\`\`table
{"headers": ["وجه المقارنة", "الاقتصاد الجزئي (Micro)", "الاقتصاد الكلي (Macro)"], "rows": [["وحدة الدراسة", "الفرد، الأسرة، الشركة", "الدولة، المجتمع الدولي"], ["الهدف", "تعظيم منفعة الفرد/ربح الشركة", "تحقيق الاستقرار والنمو الاقتصادي"], ["مثال", "سعر البرتقال في السوق", "معدل البطالة أو التضخم في الجزائر"]]}
\`\`\`

---

## رابعاً: المشكلة الاقتصادية وأسئلتها الكبرى

السبب الرئيسي لوجود علم الاقتصاد هو **"الندرة"**. لو كانت الموارد وفيرة كالخيال، لما احتجنا للاقتصاد. أي نظام اقتصادي في العالم يحاول الإجابة على ثلاث أسئلة مصيرية لحل هذه المشكلة:

\`\`\`steps
[{"label": "1. ماذا ننتج؟", "desc": "تحديد نوع وكمية السلع (هل نزرع قمحاً أم نصنع سيارات؟)", "active": true}, {"label": "2. كيف ننتج؟", "desc": "تحديد التقنية والموارد المستخدمة (عمالة كثيفة أم آلات متطورة؟)", "active": false}, {"label": "3. لمن ننتج؟", "desc": "كيفية توزيع الناتج والعائد على أفراد المجتمع (من يستفيد؟)", "active": false}]
\`\`\`

> !warn **مفهوم الندرة:**
> الندرة في الاقتصاد لا تعني "الفقر"، بل تعني أن الموارد **محدودة** مقارنة بالرغبات. حتى الدول الغنية تعاني من الندرة لأنها لا تستطيع تحقيق *كل* رغبات مواطنيها في آن واحد.

---

## خامساً: عناصر الإنتاج (مفتاح النشاط الاقتصادي)

لكي تتم عملية الإنتاج، لابد من تضافر أربعة عناصر أساسية، ولكل عنصر عائد مادي خاص به:

1.  **الأرض (الموارد الطبيعية):** كل ما في الطبيعة، وعائدها يسمى **"الريع"**.
2.  **العمل (Labor):** الجهد البشري (عضلي أو ذهني)، وعائده يسمى **"الأجر"**.
3.  **رأس المال (Capital):** الآلات والمعدات (وليس المال السائل فقط)، وعائده يسمى **"الفائدة"**.
4.  **التنظيم (Entrepreneurship):** إدارة وجمع العناصر السابقة، وعائده يسمى **"الربح"**.

يمكن تمثيل ذلك بمعادلة إنتاجية بسيطة:

\`\`\`math
الإنتاج = الأرض + العمل + رأس المال + التنظيم
\`\`\`

---

# ملخص الدرس

*   **علم الاقتصاد** هو علم إدارة الموارد النادرة لتلبية الحاجات اللانهائية.
*   يعتمد المنهج **الوصفي والتحليلي** ويستخدم الرياضيات كأداة أساسية (خاصة في المدرسة الكلاسيكية الجديدة).
*   ينقسم إلى **جزئي** (دراسة الوحدات الفردية) و **كلي** (دراسة المتغيرات القومية).
*   محور الدراسة هو الإجابة على الأسئلة الثلاثة: **ماذا ننتج؟ كيف ننتج؟ ولمن ننتج؟**   
---
<yt_link_url>             
     
      `;

      if (!generateWithFailoverRef)
        throw new Error('AI generator not initialized');

      // نستخدم 'chat' (الذي يجب أن يكون مربوطاً بـ Pro أو Flash حسب رصيدك)
      const res = await generateWithFailoverRef('chat', prompt, { 
          label: 'GhostGenerator', 
          timeoutMs: 90000 
      });
      
      const content = await extractTextFromResult(res);

if (content && content.length > 100) {
    logger.info(`💾 Saving content for lesson: ${lesson.id}...`);

    // 1. الحفظ في lessons_content
    const { error: insertError } = await supabase
        .from('lessons_content')
        .upsert({
            id: lesson.id, 
            subject_id: lesson.subject_id, 
            content: content,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' }); 

          if (insertError) {
              logger.error(`❌ DB Insert Error:`, insertError.message);
              return;
          }

          // 2. تحديث العلامة في جدول lessons (لأغراض الـ UI فقط)
          await supabase.from('lessons').update({
              has_content: true,
              ai_memory: { 
                generated_by: 'ghost_teacher_v2',
                generated_at: new Date().toISOString(),
                is_ai_generated: true
              }
          }).eq('id', lesson.id);

          logger.success(`✅ Generated & Saved: ${lesson.title}`);
      } else {
          logger.error(`❌ AI Returned Empty or Short Content for: ${lesson.title}`);
      }

  } catch (err) {
      logger.error(`Failed to generate for lesson ${lesson.id}:`, err.message);
  }
}

/**
 * المعلم الشبح (للشرح بالدارجة)
 */
async function explainLessonContent(lessonId, userId) {
  try {
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('title, subjects(title), ai_memory')
      .eq('id', lessonId)
      .single();

    if (error || !lesson) throw new Error('Lesson not found');

    // Cache check
    if (lesson.ai_memory?.ghost_explanation) {
      logger.info(`👻 Using cached explanation for ${lessonId}`);
      return { content: lesson.ai_memory.ghost_explanation, isGenerated: false };
    }

    // Generate explanation
    const prompt = `
    You are the Ghost Teacher. Explain the lesson in Derja + Academic Arabic.

    Subject: ${lesson.subjects?.title}
    Lesson: ${lesson.title}

    Structure:
    1. مقدمة
    2. الزبدة
    3. مثال جزائري
    4. خلاصة
    `;

    const modelResp = await generateWithFailoverRef('chat', prompt);
    const explanation = await extractTextFromResult(modelResp);

    await supabase
      .from('lessons')
      .update({
        ai_memory: {
          ...lesson.ai_memory,
          ghost_explanation: explanation,
          generated_at: new Date().toISOString()
        }
      })
      .eq('id', lessonId);

    return { content: explanation, isGenerated: true };

  } catch (err) {
    logger.error(`Failed to explain lesson ${lessonId}:\n`, err.message);
    return {
      content: 'عذراً، المعلم الشبح راهو شارب قهوة ☕',
      isError: true
    };
  }
}

module.exports = {
  initGhostEngine,
  explainLessonContent,
  generateAndSaveLessonContent,
  scanAndFillEmptyLessons
};
