
// services/ai/managers/plannerManager.js
'use strict';

const crypto = require('crypto');
const CONFIG = require('../../../config');
const { getFirestoreInstance, admin } = require('../../data/firestore');
const { fetchUserWeaknesses, cacheDel } = require('../../data/helpers');
const { extractTextFromResult, ensureJsonOrRepair } = require('../../../utils');
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency

function initPlannerManager(dependencies) {
  if (!dependencies.generateWithFailover) {
    throw new Error('Planner Manager requires generateWithFailover for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Planner Manager initialized.');
}

const db = getFirestoreInstance();

// Planner manager: create a simple study plan JSON
async function runPlannerManager(userId, pathId = null) {
  const weaknesses = await fetchUserWeaknesses(userId);
  const weaknessesPrompt = weaknesses.length > 0
    ? `<context>\nThe user has shown weaknesses in the following areas:\n${weaknesses.map(w => `- In subject "${w.subjectTitle}", the lesson "${w.lessonTitle}" (ID: ${w.lessonId}) has a mastery of ${w.masteryScore || 0}%.`).join('\n')}\n</context>`
    : '<context>The user is new or has no specific weaknesses. Suggest a general introductory plan to get them started.</context>';

  const prompt = `You are an elite academic coach. Create an engaging, personalized study plan.\n${weaknessesPrompt}\n<rules>\n1.  Generate 2-4 daily tasks.\n2.  All task titles MUST be in clear, user-friendly Arabic.\n3.  **Clarity:** If a task is for a specific subject (e.g., "Physics"), mention it in the title, like "مراجعة الدرس الأول في الفيزياء".\n4.  You MUST create a variety of task types.\n5.  Each task MUST include 'relatedLessonId' and 'relatedSubjectId'.\n6.  Output MUST be ONLY a valid JSON object: { "tasks": [ ... ] }\n</rules>`;

  if (!generateWithFailoverRef) {
    logger.error('runPlannerManager: generateWithFailover is not set.');
    const fallback = [{ id: crypto.randomUUID(), title: 'مراجعة المفاهيم الأساسية', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    return { tasks: fallback, source: 'fallback' };
  }

  const res = await generateWithFailoverRef('planner', prompt, { label: 'Planner', timeoutMs: CONFIG.TIMEOUTS.default });
  const raw = await extractTextFromResult(res);
  const parsed = await ensureJsonOrRepair(raw, 'planner');

  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    const fallback = [{ id: crypto.randomUUID(), title: 'مراجعة المفاهيم الأساسية', type: 'review', status: 'pending', relatedLessonId: null, relatedSubjectId: null }];
    await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: fallback, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    return { tasks: fallback, source: 'fallback' };
  }

  const tasksToSave = parsed.tasks.slice(0, 5).map((t) => ({
    id: t.id || crypto.randomUUID(),
    title: String(t.title || 'مهمة تعليمية'),
    type: ['review', 'quiz', 'new_lesson', 'practice', 'study'].includes(String(t.type || '').toLowerCase()) ? String(t.type).toLowerCase() : 'review',
    status: 'pending',
    relatedLessonId: t.relatedLessonId || null,
    relatedSubjectId: t.relatedSubjectId || null,
  }));

  await db.collection('userProgress').doc(userId).set({ dailyTasks: { tasks: tasksToSave, generatedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
  await cacheDel('progress', userId);
  return { tasks: tasksToSave, source: 'AI' };
}

module.exports = {
  initPlannerManager,
  runPlannerManager,
};
