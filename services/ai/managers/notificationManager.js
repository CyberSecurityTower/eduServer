
// services/ai/managers/notificationManager.js
'use strict';

const CONFIG = require('../../../config');
const { escapeForPrompt, extractTextFromResult } = require('../../../utils');
const { sendUserNotification } = require('../../data/helpers'); // Re-use the helper
const logger = require('../../../utils/logger');
const { getFirestoreInstance } = require('../../data/firestore'); // تأكد من الاستيراد
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


async function runReEngagementManager(userId, intensity = 'gentle') {
  try {
    const db = getFirestoreInstance();

    // 1. جلب "كل شيء" عن المستخدم (وليس فقط البروجرس)
    const [userDoc, aiProfileDoc, progressDoc] = await Promise.all([
        db.collection('users').doc(userId).get(),
        db.collection('aiMemoryProfiles').doc(userId).get(),
        db.collection('userProgress').doc(userId).get()
    ]);

    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    const aiData = aiProfileDoc.exists ? aiProfileDoc.data().behavioralInsights : {};
    const progress = progressDoc.exists ? progressDoc.data() : {};
    
    // 2. استخراج الأسلحة الشخصية (Personal Hooks)
    const userName = userData.firstName || 'صديقي';
    const facts = userData.userProfileData?.facts || {};
    
    // نختار "خطاف" (Hook) واحد عشوائي لكي لا تكون الرسالة مزدحمة
    const hooks = [];
    if (facts.dream) hooks.push(`remember your dream to be a ${facts.dream}`);
    if (facts.friend) hooks.push(`maybe study like ${facts.friend}`);
    if (facts.motivation) hooks.push(`fuel your ${facts.motivation}`);
    
    const personalHook = hooks.length > 0 ? hooks[Math.floor(Math.random() * hooks.length)] : '';

    // آخر درس توقف عنده
    const lastIncompleteTask = progress?.dailyTasks?.tasks?.find(t => t.status === 'pending');
    const taskContext = lastIncompleteTask ? `Last incomplete task: ${lastIncompleteTask.title}` : 'No specific tasks.';

    // النبرة (Tone) حسب الشدة والبروفايل
    const userStyle = aiData.style || 'Friendly';
    let toneInstruction = "";
    
    if (intensity === 'gentle') {
        toneInstruction = `Tone: Warm, ${userStyle}, zero pressure. Just checking in.`;
    } else if (intensity === 'motivational') {
        toneInstruction = `Tone: Encouraging, ${userStyle}. Remind them of their goals/streak.`;
    } else if (intensity === 'urgent') {
        toneInstruction = `Tone: Emotional and urgent. "We miss you". Use local Algerian slang heavily.`;
    }

    // 3. البرومبت "العبقري"
    const prompt = `
    You are EduAI, a close study companion to ${userName}.
    
    **The Situation:** User hasn't opened the app for a while (${intensity} phase).
    **User Persona:** Likes ${userStyle} interactions.
    **Personal Hook:** ${personalHook}
    **Study Context:** ${taskContext}
    
    **Task:** Write a very short, highly personalized Push Notification (Arabic/Algerian Derja).
    - Max 15 words.
    - Mention their name or a personal fact naturally if it fits.
    - DO NOT sound like a robot. Sound like a concerned friend sending a WhatsApp message.
    
    **Example (if dream is Pilot):** "يا كابتن ${userName}، الطيارة راهي تستنى! ✈️ طوّلت الغيبة."
    **Output:** ONLY the notification text.
    `;

    if (!generateWithFailoverRef) return null;
    
    const res = await generateWithFailoverRef('notification', prompt, { label: 'ReEngagementManager' });
    const text = await extractTextFromResult(res);
    
    return text ? text.replace(/"/g, '') : null;

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
