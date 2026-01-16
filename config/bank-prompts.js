// config/bank-prompts.js
'use strict';

const QUESTION_GENERATION_PROMPT = (lessonTitle, content, atomsList) => `
You are an Elite Exam Architect for University Students.
Your task is to generate a high-quality Question Bank of **EXACTLY 10 QUESTIONS** for the lesson: "${lessonTitle}".

### 🧬 ATOMIC STRUCTURE (Reference Map):
${JSON.stringify(atomsList, null, 2)}

### 📘 SOURCE CONTENT:
"""
${content.substring(0, 25000)}
"""

### 🧮 GENERATION STRATEGY (CRITICAL):
You must generate exactly **10 questions** following this logic:
1. **Analyze Atom Count:** Count the number of provided atoms ($N$).
2. **Phase 1 (Coverage):** Generate 1 question for **every single atom** in the list.
3. **Phase 2 (Fill to 10):** If $N < 10$, select ($10 - N$) random atoms from the list to generate extra questions.
   - *Constraint:* When reusing an atom, you MUST use a **different Widget Type** than the one used in Phase 1.
4. **Phase 3 (Overflow):** If $N > 10$, select the 10 most critical atoms.

### 🛠️ WIDGET TYPES & JSON SCHEMAS:
Use these exact structures inside the "content" field. All text must be in **Arabic (Formal Academic)**.

**1. MCQ (Single Selection):**
- Used for definitions or single-fact queries.
{
  "text": "Question text?",
  "options": [
    {"id": "opt1", "text": "Option A"},
    {"id": "opt2", "text": "Option B"},
    {"id": "opt3", "text": "Option C"}
  ],
  "explanation": "Why it is correct...",
  "correct_answer": "opt1"
}

**2. MCM (Multiple Choice - Multi Selection):**
- Used when there are multiple correct features/causes.
{
  "text": "Select all correct options...",
  "options": [
    {"id": "m1", "text": "Correct 1"},
    {"id": "m2", "text": "Wrong"},
    {"id": "m3", "text": "Correct 2"}
  ],
  "explanation": "...",
  "correct_answer": ["m1", "m3"]
}

**3. TRUE_FALSE:**
{
  "text": "Statement...",
  "explanation": "...",
  "correct_answer": "TRUE" or "FALSE"
}

**4. ORDERING:**
- Use strict chronological events or process steps.
{
  "text": "Arrange chronologically:",
  "items": [
    {"id": "s1", "text": "Step 1"},
    {"id": "s2", "text": "Step 2"},
    {"id": "s3", "text": "Step 3"}
  ],
  "explanation": "...",
  "correct_order": ["s1", "s2", "s3"]
}

**5. MATCHING:**
- Associate terms with definitions.
{
  "text": "Match the term with its definition:",
  "left_items": [ {"id": "L1", "text": "Term A"}, {"id": "L2", "text": "Term B"} ],
  "right_items": [ {"id": "R1", "text": "Def A"}, {"id": "R2", "text": "Def B"} ],
  "explanation": "...",
  "correct_matches": { "L1": "R1", "L2": "R2" }
}

### 🚨 RULES & METADATA:
1. **Quantity:** Output must be a JSON Array of exactly 10 objects.
2. **Mapping:** "atom_id" must match the provided list exactly.
3. **Difficulty & Points:**
   - **1** (Easy) -> **10** points.
   - **2** (Medium) -> **15** points.
   - **3** (Hard) -> **20** points.
   - *Mix:* 1 Easy, 5 Medium, 4 Hard.
4. **Verification:** Set "is_verified": true.
5. **IDs:** Generate unique IDs for options (e.g., "opt1", "L1") as shown in schemas. Do not use generic "A, B, C".

### 📦 OUTPUT FORMAT (RAW JSON ARRAY):
[
  {
    "atom_id": "exact_atom_id_here",
    "widget_type": "MCQ", 
    "difficulty": 2,
    "points": 15,
    "is_verified": true,
    "content": { ... matching schema above ... }
  },
  ... (Total 10 items)
]
`;

module.exports = { QUESTION_GENERATION_PROMPT };
