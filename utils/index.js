
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
 * دالة الوعي الزمني الخاصة بالجزائر
 * تعيد الوقت + السياق النفسي للطالب
 */
function getAlgiersTimeContext() {
  // 1. تحديد الوقت بدقة حسب توقيت الجزائر
  const now = new Date();
  const options = { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long' };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  
  // استخراج الوقت كأجزاء
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parts.find(p => p.type === 'minute').value;
  const day = parts.find(p => p.type === 'weekday').value;
  
  const timeString = `${hour}:${minute}`;

  // 2. تحليل "الفايب" (Vibe Analysis)
  let timeVibe = "";
  let energyLevel = "";

  if (hour >= 5 && hour < 9) {
    timeVibe = "Early Morning Grind 🌅 (Best for deep work/memorization)";
    energyLevel = "High";
  } else if (hour >= 9 && hour < 12) {
    timeVibe = "Active Study Hours 📚 (Classes/Focus)";
    energyLevel = "Medium-High";
  } else if (hour >= 12 && hour < 14) {
    timeVibe = "Lunch Break / Nap 🥪 (Recharge time)";
    energyLevel = "Low (Rest)";
  } else if (hour >= 14 && hour < 18) {
    timeVibe = "Afternoon Push ☕ (Fight the laziness)";
    energyLevel = "Medium";
  } else if (hour >= 18 && hour < 22) {
    timeVibe = "Evening Review 🌙 (Homework/Summaries)";
    energyLevel = "Medium";
  } else if (hour >= 22 && hour < 24) {
    timeVibe = "Late Night 🦉 (Winding down)";
    energyLevel = "Low";
  } else {
    timeVibe = "Deep Night / Sleep Deprivation 😴 (User should be sleeping!)";
    energyLevel = "Critical (Burnout Risk)";
  }

  // التعامل مع الويكند في الجزائر (الجمعة والسبت)
  const isWeekend = (day === 'Friday' || day === 'Saturday');
  const dayContext = isWeekend ? "Weekend (Catch up or Rest)" : "Week day (Work mode)";

  return {
    fullTime: `${day}, ${timeString} (Algiers Time)`,
    hour: hour,
    vibe: timeVibe,
    isWeekend: isWeekend,
    contextSummary: `Current Time: ${timeString} (${dayContext}).\nStatus: ${timeVibe}.`
  };
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
  getAlgiersTimeContext 
};
