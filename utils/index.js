
// utils/index.js
'use strict';

const CONFIG = require('../config');
const logger = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const escapeForPrompt = (s) => (s ? String(s).replace(/"/g, '\\"') : '');
const safeSnippet = (text, max = 2000) => (typeof text === 'string' ? (text.length <= max ? text : `${text.slice(0, max)}...[truncated]`) : '');
const shuffled = (arr) => arr.slice().sort(() => Math.random() - 0.5);

async function withTimeout(promise, ms = CONFIG.TIMEOUTS.default, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function extractTextFromResult(result) {
  try {
    if (!result) return '';

    if (result.response && typeof result.response.text === 'function') {
      const t = await result.response.text();
      if (t) return String(t).trim();
    }

    if (typeof result === 'string') return result.trim();
    if (result.text && typeof result.text === 'string') return result.text.trim();
    if (result.outputText && typeof result.outputText === 'string') return result.outputText.trim();
    if (result.output && typeof result.output === 'string') return result.output.trim();
    if (result.data && typeof result.data === 'string') return result.data.trim();

    if (Array.isArray(result.output)) {
      const collected = [];
      for (const block of result.output) {
        if (block.content && Array.isArray(block.content)) {
          for (const c of block.content) {
            if (typeof c.text === 'string' && c.text.trim()) collected.push(c.text.trim());
            else if (c.parts && Array.isArray(c.parts)) collected.push(c.parts.join('').trim());
          }
        } else if (typeof block.text === 'string' && block.text.trim()) {
          collected.push(block.text.trim());
        }
      }
      if (collected.length) return collected.join('\n').trim();
    }

    if (result.candidates && Array.isArray(result.candidates) && result.candidates.length) {
      const candTexts = result.candidates.map(c => {
        if (typeof c.text === 'string') return c.text;
        if (c.message && c.message.content && Array.isArray(c.message.content)) {
          return c.message.content.map(cc => cc.text || (cc.parts && cc.parts.join(''))).filter(Boolean).join('');
        }
        return '';
      }).filter(Boolean);
      if (candTexts.length) return candTexts.join('\n').trim();
    }

    if (result.output && result.output[0] && result.output[0].content) {
      const parts = result.output[0].content.map(c => c.text || (c.parts && c.parts.join(''))).filter(Boolean);
      if (parts.length) return parts.join('\n').trim();
    }

    let dumped = '';
    try {
      dumped = JSON.stringify(result);
    } catch (e) {
      try {
        dumped = String(result);
      } catch (e2) {
        dumped = '';
      }
    }
    return dumped ? dumped.slice(0, 2000) : '';

  } catch (err) {
    logger.error('extractTextFromResult failed:', err && err.message ? err.message : err);
    return '';
  }
}

function parseJSONFromText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    let candidate = match[0].replace(/```(?:json)?/g, '').trim();
    candidate = candidate.replace(/,\s*([}\]])/g, '$1'); // Fix trailing commas
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

// This function now depends on `generateWithFailover` from services/ai/failover.js
// It will be passed as a dependency during initialization.
let generateWithFailoverRef;
function setGenerateWithFailover(fn) {
  generateWithFailoverRef = fn;
}

async function ensureJsonOrRepair(rawText, repairPool = 'review') {
  const parsed = parseJSONFromText(rawText);
  if (parsed) return parsed;
  const repairPrompt = `The following text should be a single valid JSON object. Fix it and return ONLY the JSON. If impossible, return {}.\n\nTEXT:\n${rawText}`;
  try {
    if (!generateWithFailoverRef) {
      logger.error('ensureJsonOrRepair: generateWithFailover is not set.');
      return null;
    }
    const res = await generateWithFailoverRef(repairPool, repairPrompt, { label: 'JSONRepair', timeoutMs: 5000 });
    const fixed = await extractTextFromResult(res);
    return parseJSONFromText(fixed);
  } catch (e) {
    logger.error('ensureJsonOrRepair failed:', e.message);
    return null;
  }
}
/**
 * دالة الوعي الزمني (النسخة المعتمدة على Intl)
 * تحل مشكلة اختلاف الأيام بدقة
 */
function getAlgiersTimeContext() {
  const now = new Date();
  
  // نطلب من النظام استخراج الوقت واليوم حسب توقيت الجزائر تحديداً
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Algiers',
    hour12: false,
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric'
  });

  const parts = formatter.formatToParts(now);
  
  // استخراج القيم الصحيحة
  const dayName = parts.find(p => p.type === 'weekday').value; // سيخرج "Friday"
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  
  const timeString = `${hour}:${minute < 10 ? '0' + minute : minute}`;

  // تحليل الفايب (Vibe)
  let timeVibe = "";
  if (hour >= 5 && hour < 9) {
    timeVibe = "Early Morning Grind 🌅";
  } else if (hour >= 9 && hour < 12) {
    timeVibe = "Active Study Hours 📚";
  } else if (hour >= 12 && hour < 14) {
    timeVibe = "Lunch/Nap Time 🥪"; // وقت الجمعة = وقت الطعام والراحة
  } else if (hour >= 14 && hour < 18) {
    timeVibe = "Afternoon Push ☕";
  } else if (hour >= 18 && hour < 22) {
    timeVibe = "Evening Review 🌙";
  } else if (hour >= 22 && hour < 24) {
    timeVibe = "Late Night 🦉";
  } else if (hour >= 0 && hour < 5) {
    timeVibe = "Sleep Deprivation! 😴 Go to sleep.";
  }

  // التعامل مع الجمعة (يوم مقدس وعطلة)
  const isWeekend = (dayName === 'Friday' || dayName === 'Saturday');
  let dayContext = isWeekend ? "Weekend" : "Week day";
  
  if (dayName === 'Friday') {
      dayContext = "Friday (Holy day & Family time)";
  }

  return {
    fullTime: `${dayName}, ${timeString} (Algiers Time)`,
    hour: hour,
    vibe: timeVibe,
    isWeekend: isWeekend,
    contextSummary: `Current Time in Algeria: ${timeString}. Day: ${dayName} (${dayContext}).\nStatus: ${timeVibe}.`
  };
}

/**
 * تحويل التاريخ إلى صيغة بشرية جزائرية
 * @param {string|Date} targetDate 
 * @returns {string} مثال: "غدوة الصباح"، "اليوم في الليل"، "السيمانة الجاية"
 */
function getHumanTimeDiff(targetDate) {
  const now = new Date();
  const target = new Date(targetDate);
  const diffMs = target - now;
  const diffHours = diffMs / (1000 * 60 * 60);

  // 1. التعامل مع الماضي (إذا الامتحان فات)
  if (diffHours < 0) {
      // إذا فات بأقل من 5 سوايع نقولو "قبيل"
      if (diffHours > -5) return "قبيل برك (Tout à l'heure)"; 
      return "فات الحال (Passé)"; 
  }

  // 2. التحقق هل هو نفس اليوم في التقويم؟ (Is it the same Calendar Day?)
  const isSameDay = now.getDate() === target.getDate() && 
                    now.getMonth() === target.getMonth() && 
                    now.getFullYear() === target.getFullYear();

  // 3. المنطق الدقيق
  if (diffHours < 24) {
    if (diffHours < 1) return "درك (Maintenant)";
    
    if (isSameDay) {
        return "اليوم"; // نفس التاريخ (مثلاً 06/12)
    } else {
        return "غدوة"; // تاريخ مختلف (مثلاً 07/12) حتى لو الفرق سوايع قليلة
    }
  }

  const diffDays = Math.ceil(diffHours / 24);
  if (diffDays === 1) return "غدوة (Demain)";
  if (diffDays === 2) return "غير غدوة (Après-demain)";
  if (diffDays >= 3 && diffDays < 7) return `في هاد ${diffDays} أيام`;
  if (diffDays >= 7 && diffDays < 14) return "السمانة الجاية";
  
  return target.toLocaleDateString('ar-DZ');
}
module.exports = {
  sleep,
  iso,
  escapeForPrompt,
  safeSnippet,
  shuffled,
  withTimeout,
  extractTextFromResult,
  parseJSONFromText,
  ensureJsonOrRepair,
  setGenerateWithFailover, // Export the setter
  getAlgiersTimeContext,
  getHumanTimeDiff 
};
