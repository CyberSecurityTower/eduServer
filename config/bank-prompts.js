// config/bank-prompts.js
'use strict';

const QUESTION_GENERATION_PROMPT = (lessonTitle, content, atomsList) => `
You are an Elite Exam Architect for University Students.
Your task is to generate a high-quality Question Bank for the lesson: "${lessonTitle}".

### 🧬 ATOMIC STRUCTURE (Reference Map):
You MUST map each question to one of these specific Atom IDs based on the topic it covers:
${JSON.stringify(atomsList, null, 2)}

### 📘 SOURCE CONTENT:
"""
${content.substring(0, 25000)}
"""

### 🛠️ WIDGET TYPES & RULES:

1. **MCQ (Multiple Choice):**
   - 4 options total. 1 correct, 3 distractors.
   - JSON Structure: { "question": "...", "options": ["A", "B", "C", "D"], "correct_answer": "Correct Option Text" }

2. **TRUE_FALSE:**
   - JSON Structure: { "question": "Statement...", "correct_answer": true/false }

3. **ORDERING (Chronological/Process):**
   - Minimum 3 items, Maximum 5.
   - JSON Structure: { "question": "Arrange the following...", "correct_order": ["First", "Second", "Third"] }

4. **MATCHING (Association):**
   - 4 pairs.
   - JSON Structure: { "question": "Match the term with definition", "correct_matches": { "Term A": "Def A", "Term B": "Def B" } }

### 🚨 GENERATION RULES (FATAL IF IGNORED):
1. **Scope:** Generate exactly **10 to 15 questions**.
2. **Coverage:** Ensure every "Atom ID" from the list gets at least one question.
3. **Difficulty:** Mix of "Medium" (60%) and "Hard" (40%). No "Easy" questions.
4. **Mapping:** The "atom_id" field MUST match one of the IDs provided in the structure above exactly.
5. **Language:** Arabic (Formal Academic).
6. **Output:** A Single Valid JSON Array of objects.

### 📦 OUTPUT FORMAT (JSON ONLY):
[
  {
    "atom_id": "EXACT_ID_FROM_LIST",
    "widget_type": "MCQ", 
    "difficulty": "Medium",
    "content": { ...specific widget structure... }
  },
  ...
]
`;

module.exports = { QUESTION_GENERATION_PROMPT };
