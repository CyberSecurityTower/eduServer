
// services/ai/managers/todoManager.js
'use strict';

const crypto = require('crypto');
const CONFIG = require('../../../config');
const { getFirestoreInstance, admin } = require('../../data/firestore');
const { cacheDel } = require('../../data/helpers');
const { escapeForPrompt, extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initToDoManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('ToDo Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('ToDo Manager initialized.');
}

const db = getFirestoreInstance();

// ToDo manager: interpret todo instructions and return an action summary (lightweight implementation)
async function runToDoManager(userId, userRequest, currentTasks = []) {
  const prompt = `You are an expert To-Do List Manager AI. Modify the CURRENT TASKS based on the USER REQUEST.
<rules>
1.  **Precision:** You MUST only modify, add, or delete tasks explicitly mentioned in the user request.
2.  **Preservation:** You MUST preserve the exact original title, type, and language of all other tasks that were not mentioned in the request. This is a critical rule.
3.  **Output Format:** Respond ONLY with a valid JSON object: { "tasks": [ ... ] }. Each task must have all required fields (id, title, type, status, etc.).
</rules>

CURRENT TASKS:
${JSON.stringify(currentTasks)}

USER REQUEST:
"${escapeForPrompt(userRequest)}"`;

  if (!generateWithFailoverRef) {
    logger.error('runToDoManager: generateWithFailover is not set.');
    throw new Error('generateWithFailover is not initialized.');
  }
  const res = await generateWithFailoverRef('todo', prompt, { label: 'ToDoManager', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'todo');
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('ToDoManager returned invalid tasks.');

  const VALID_TASK_TYPES = new Set(['review', 'quiz', 'new_lesson', 'practice', 'study']);
  const normalizedTasks = parsed.tasks.map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || 'مهمة جديدة'),
    type: VALID_TASK_TYPES.has(String(t.type || '').toLowerCase()) ? String(t.type).toLowerCase() : 'review',
    status: String(t.status || 'pending').toLowerCase() === 'completed' ? 'completed' : 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  let changeDescription = { action: 'updated', taskTitle: null };
  const oldTaskIds = new Set(currentTasks.map(t => t.id));
  const newTaskIds = new Set(normalizedTasks.map(t => t.id));

  const completedTask = normalizedTasks.find(newTask => {
    const oldTask = currentTasks.find(old => old.id === newTask.id);
    return oldTask && oldTask.status === 'pending' && newTask.status === 'completed';
  });
  if (completedTask) {
    changeDescription = { action: 'completed', taskTitle: completedTask.title };
  } else {
    const addedTask = normalizedTasks.find(t => !oldTaskIds.has(t.id));
    if (addedTask) {
      changeDescription = { action: 'added', taskTitle: addedTask.title };
    } else {
      const removedTask = currentTasks.find(t => !newTaskIds.has(t.id));
      if (removedTask) {
        changeDescription = { action: 'removed', taskTitle: removedTask.title };
      }
    }
  }

  await db.collection('userProgress').doc(userId).set({
    dailyTasks: { tasks: normalizedTasks, generatedAt: admin.firestore.FieldValue.serverTimestamp() },
  }, { merge: true });
  await cacheDel('progress', userId);

  return { updatedTasks: normalizedTasks, change: changeDescription };
}

module.exports = {
  initToDoManager,
  runToDoManager,
};
