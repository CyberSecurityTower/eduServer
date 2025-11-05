
// services/ai/managers/notificationManager.js
'use strict';

const CONFIG = require('../../../config');
const { escapeForPrompt, extractTextFromResult } = require('../../../utils');
const { sendUserNotification } = require('../../data/helpers'); // Re-use the helper
const logger = require('../../../utils/logger');

let generateWithFailoverRef; // Injected dependency
let getProgressRef; // Injected dependency

function initNotificationManager(dependencies) {
  if (!dependencies.generateWithFailover || !dependencies.getProgress) {
    throw new Error('Notification Manager requires generateWithFailover and getProgress for initialization.');
  }
  generateWithFailoverRef = dependencies.generateWithFailover;
  getProgressRef = dependencies.getProgress;
  logger.info('Notification Manager initialized.');
}

// Notification manager: produce quick acknowledgement or notification text
async function runNotificationManager(type = 'ack', language = 'Arabic', data = {}) {
  let prompt;
  const commonRules = `\n<rules>\n1. Respond in natural, encouraging ${language}.\n2. Be concise and positive.\n3. Do NOT include any formatting like markdown or JSON.\n</rules>`;

  switch (type) {
    case 'task_completed':
      prompt = `Create a short, celebratory message in ${language} for completing a task. The task title is: "${data.taskTitle || 'a task'}". Example: "رائع! تم إنجاز مهمة: ${data.taskTitle}"`;
      break;
    case 'task_added':
      prompt = `Create a short, welcoming message in ${language} for adding a new task. The task title is: "${data.taskTitle || 'a new task'}". Example: "تمت إضافة مهمة جديدة: ${data.taskTitle}"`;
      break;
    case 'task_removed':
      prompt = `Create a short, neutral message in ${language} for removing a task. The task title is: "${data.taskTitle || 'a task'}". Example: "تم حذف مهمة: ${data.taskTitle}"`;
      break;
    case 'task_updated':
      prompt = `Create a short, generic message in ${language} confirming that the to-do list was updated.`;
      break;
    case 'ack':
      prompt = `Return a short acknowledgement in ${language} (max 12 words) confirming the user's action was received, e.g., \"تم استلام طلبك، جاري العمل عليه\". Return ONLY the sentence.`;
      break;
    default:
      return (language === 'Arabic') ? "تم تحديث طلبك بنجاح." : 'Your request has been updated.';
  }

  try {
    if (!generateWithFailoverRef) {
      logger.error('runNotificationManager: generateWithFailover is not set.');
      return language === 'Arabic' ? 'تم تحديث طلبك.' : 'Your request has been updated.';
    }
    const res = await generateWithFailoverRef('notification', prompt + commonRules, { label: 'NotificationManager', timeoutMs: CONFIG.TIMEOUTS.notification });
    const text = await extractTextFromResult(res);
    if (text) return text;
    if (type === 'task_completed') return `أحسنت! تم إنجاز مهمة: ${data.taskTitle}`;
    if (type === 'task_added') return `تمت إضافة مهمة: ${data.taskTitle}`;
    return language === 'Arabic' ? 'تم تحديث قائمة مهامك.' : 'Your to-do list has been updated.';
  } catch (err) {
    logger.error('runNotificationManager error:', err.message);
    return language === 'Arabic' ? 'تم تحديث طلبك.' : 'Your request has been updated.';
  }
}

async function runReEngagementManager(userId) {
  if (!getProgressRef) {
    logger.error('runReEngagementManager: getProgress is not set.');
    return null;
  }
  const progress = await getProgressRef(userId);
  const lastIncompleteTask = progress?.dailyTasks?.tasks?.find(t => t.status === 'pending');

  let context = "The user has been inactive for a couple of days.";
  if (lastIncompleteTask) {
    context += ` Their last incomplete task was "${lastIncompleteTask.title}".`;
  } else {
    context += " They don't have any specific pending tasks.";
  }

  const prompt = `You are a warm and caring study coach, not a robot.
  ${context}
  Write a short, friendly, and very gentle notification (1-2 sentences in Arabic) to re-engage them.
  - The tone should be zero-pressure. More like "Hey, thinking of you!" than "You have work to do!".
  - If they have an incomplete task, you can mention it in a very encouraging way.
  - Example if task exists: "مساء الخير! أتمنى أن تكون بخير. مهمة '${lastIncompleteTask.title}' لا تزال بانتظارك عندما تكون مستعدًا للعودة. ما رأيك أن ننجزها معًا؟"
  - Example if no task: "مساء الخير! كيف حالك؟ مر وقت لم نرك فيه. أتمنى أن كل شيء على ما يرام!"
  Respond with ONLY the notification text.`;

  try {
    if (!generateWithFailoverRef) {
      logger.error('runReEngagementManager: generateWithFailover is not set.');
      return null;
    }
    const res = await generateWithFailoverRef('notification', prompt, { label: 'ReEngagementManager' });
    return await extractTextFromResult(res);
  } catch (error) {
    logger.error(`ReEngagementManager failed for user ${userId}:`, error);
    return null;
  }
}

async function runInterventionManager(interventionType, data = {}) {
  let prompt;
  const language = 'Arabic'; // يمكن جعله ديناميكيًا لاحقًا

  const strictRules = `
<rules>
1.  Your response MUST be ONLY the final notification text, directly usable for the user.
2.  The text MUST be in natural, user-friendly ${language}.
3.  ABSOLUTELY NO conversational filler. Do not say "Here is the notification" or "Of course!".
</rules>
`;

  switch (interventionType) {
    case 'unplanned_lesson':
      prompt = `A user has proactively started studying a lesson titled "${data.lessonTitle}" that was NOT on their to-do list.
      Write a short, positive notification (1-2 sentences) that praises their initiative and gently asks if they'd like to add it to their daily plan.
      ${strictRules}`;
      break;

    case 'timer_procrastination':
      prompt = `A user started a study timer 2 minutes ago but hasn't started any lesson. They might be stuck.
      Write a short, gentle, and helpful notification (1-2 sentences) asking if everything is okay and if they need help choosing a task.
      ${strictRules}`;
      break;

    default:
      return '';
  }

  try {
    if (!generateWithFailoverRef) {
      logger.error('runInterventionManager: generateWithFailover is not set.');
      return "نحن هنا للمساعدة إذا احتجت أي شيء!";
    }
    const res = await generateWithFailoverRef('notification', prompt, { label: 'InterventionManager' });
    const rawText = await extractTextFromResult(res);
    return rawText.replace(/["']/g, '').trim();
  } catch (error) {
    logger.error(`InterventionManager failed for type ${interventionType}:`, error);
    return "نحن هنا للمساعدة إذا احتجت أي شيء!";
  }
}

module.exports = {
  initNotificationManager,
  runNotificationManager,
  runReEngagementManager,
  runInterventionManager,
  // sendUserNotification is now exported from services/data/helpers
};
