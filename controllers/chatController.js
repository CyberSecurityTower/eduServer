// controllers/chatController.js
'use strict';

// ==========================================
// 1. Imports & Configuration
// ==========================================
const crypto = require('crypto');
const CONFIG = require('../config');
const supabase = require('../services/data/supabase');
const PROMPTS = require('../config/ai-prompts');
const { getAtomicContext, updateAtomicProgress  } = require('../services/atomic/atomicManager'); // استيراد
// Engines & Managers
const { markLessonComplete } = require('../services/engines/gatekeeper'); 
const { runPlannerManager } = require('../services/ai/managers/plannerManager');
const { initSessionAnalyzer, analyzeSessionForEvents } = require('../services/ai/managers/sessionAnalyzer');
const { runMemoryAgent, analyzeAndSaveMemory } = require('../services/ai/managers/memoryManager');
const { runCurriculumAgent } = require('../services/ai/managers/curriculumManager');
const { runSuggestionManager } = require('../services/ai/managers/suggestionManager');
const { explainLessonContent } = require('../services/engines/ghostTeacher');
const { getNexusMemory, updateNexusKnowledge } = require('../services/ai/eduNexus');
const { getSystemFeatureFlag } = require('../services/data/helpers'); 
const mediaManager = require('../services/media/mediaManager'); 
const scraper = require('../utils/scraper');
const { generateWithFailover } = require('../services/ai/failover'); 
const SYSTEM_INSTRUCTION = require('../config/system-instruction');
const { getCurriculumContext } = require('../services/ai/curriculumContext');
const logger = require('../utils/logger');
// Utilities
const { toCamelCase, nowISO } = require('../services/data/dbUtils');
const { getHumanTimeDiff } = require('../utils');
const {
  getAlgiersTimeContext,
  extractTextFromResult,
  ensureJsonOrRepair,
  safeSnippet
} = require('../utils');

// Data Helpers
const {
  getProfile,
  formatProgressForAI,
  saveChatSession,
  fetchUserWeaknesses,
  updateAiAgenda,
  getStudentScheduleStatus,
  refreshUserTasks,
  getLastActiveSessionContext,
  getProgress,         
  getRecentPastExams   
} = require('../services/data/helpers');

let generateWithFailoverRef;

// ==========================================
// 2. Initialization
// ==========================================
function initChatController(dependencies) {
  generateWithFailoverRef = dependencies.generateWithFailover;
  logger.info('Chat Controller initialized (Context Aware & Identity Mode 🚀).');
}

// ==========================================
// 3. Helper Handlers
// ==========================================


async function handleGeneralQuestion(req, res) {
  try {
    const { message, history } = req.body;
    
    // 1. جلب المنهج
    const curriculumMap = await getCurriculumContext();

    // 2. طباعة إجبارية في الـ Logs للتأكد (ستراها في Render)
    console.log("🔥 AI IS SEEING THIS DATA NOW:");
    console.log(curriculumMap);

    // 3. دمج التعليمات
    const finalInstruction = `
      ${SYSTEM_INSTRUCTION}
      [DATA_SOURCE_START]
      ${curriculumMap}
      [DATA_SOURCE_END]

      تعليمات إضافية:
      - استخدم القائمة بين [DATA_SOURCE] للإجابة على أسئلة العدد والمحتوى.
      - إذا سألك "كم مادة؟" احسب المواد من القائمة أعلاه وأجبه.
      - لا تقل "لا أعرف العدد"، القائمة أمامك!
    `;

    // 4. الإرسال للموديل
    const response = await generateWithFailover('chat', message, {
      systemInstruction: finalInstruction, // تأكد أن هذا المتغير يمرر فعلاً للموديل
      history: history || []
    });

    res.json({ reply: response.text });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
}

async function generateChatSuggestions(req, res) {
  // 🛑 إرجاع قائمة فارغة أو ثابتة فوراً دون أي معالجة
  return res.status(200).json({ suggestions: [] });
}

// ==========================================
// 4. Main Logic: Chat Interactive
// ==========================================
async function chatInteractive(req, res) {
  // ✅ 1. Receive data from frontend
  let { userId, message, history, sessionId, currentContext, files, file, webSearch } = req.body;
  if (!currentContext) {
      currentContext = {};
  }
 // Safety check
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!Array.isArray(history)) history = [];

  try {
    // =========================================================
    // 2. SMART HISTORY RESTORATION & BRIDGING
    // =========================================================
    // We do this EARLY because we need 'history' to define isFirstTimeUser later
    if (!history || history.length === 0) {
      const { data: sessionData } = await supabase
        .from('chat_sessions')
        .select('messages')
        .eq('id', sessionId)
        .single();

      if (sessionData && sessionData.messages && sessionData.messages.length > 0) {
        history = sessionData.messages.map(m => ({
          role: m.author === 'bot' ? 'model' : 'user',
          text: m.text,
          timestamp: m.timestamp
        }));
        history = history.slice(-10);
      } else {
        const bridgeContext = await getLastActiveSessionContext(userId, sessionId);
        if (bridgeContext) {
          history = bridgeContext.messages;
        }
      }
    }

// 1. طباعة ما وصل من الفرونت إند
console.log('🔵 [Chat Request] Body received.');
console.log('📂 Files count:', req.body.files ? req.body.files.length : 0);
if (req.body.files && req.body.files.length > 0) {
    // طباعة أول 50 حرف فقط من الداتا للتأكد أنها base64 سليمة وليست تالفة
    console.log('🔍 First file sample:', req.body.files[0].mime, req.body.files[0].data.substring(0, 50) + "...");
}
    /*
    // ✅ إضافة هذا الفحص: إذا انقطع الاتصال، توقف فوراً
    if (req.destroyed || res.writableEnded) {
        console.log('🛑 Client disconnected. Aborting AI request.');
        return; 
    }*/
    // =========================================================
    // 🧩 التجهيز (Services Layer) - نظيف جداً
    // =========================================================
     const inputFiles = files || (req.body.file ? [req.body.file] : []);
console.log('⚙️ Processing attachments via mediaManager...');

    // أ. معالجة المرفقات (صور/صوت/ملفات)
    const { payload: attachments, note: fileNote } = await mediaManager.processUserAttachments(userId, inputFiles);
// طباعة نتيجة المعالجة
console.log(`✅ Media processed. Attachments count for AI: ${attachments.length}`);
if (attachments.length > 0) {
    console.log('📦 AI Payload Structure (Sample):', JSON.stringify(attachments[0]).substring(0, 100));
}
    // ب. معالجة الروابط (URL Context)
    if ((!attachments || attachments.length === 0) && message) {
        message = await scraper.enrichMessageWithContext(message);
    }

    // ج. دمج الملاحظات في الرسالة
    const finalMessage = message + (fileNote || "");

    // =========================================================
    // 3. FETCH USER DATA (The Fix: Do this BEFORE logic checks)
    // =========================================================
    const { data: userRaw, error: userError } = await supabase
      .from('users')
      .select('*, group_id, role')
      .eq('id', userId)
      .single();

    if (userError || !userRaw) {
      return res.status(404).json({ reply: "عذراً، لم أتمكن من العثور على حسابك." });
    }

    let userData = toCamelCase(userRaw);
    const curriculumMap = await getCurriculumContext();
//ATOMIC LOGIC
       // 🔥 المحطة 2: حقن النظام الذري
    let atomicContext = "";
    let atomicData = null;
    let atomicContextString = ""; 

    // نفترض أن lessonId متاح في الطلب (أو نستخرجه من السياق)
    if (currentContext.lessonId) {
        const atomicResult = await getAtomicContext(userId, currentContext.lessonId);
        
        if (atomicResult) {
            atomicContext = atomicResult.prompt;
            atomicData = atomicResult.rawData; // سنحتاجها في المحطة 3
            console.log("✅ Atomic Context Injected Successfully");
        }
    }
    // =========================================================
    // 4. GROUP ENFORCEMENT LOGIC
    // =========================================================
    if (!userData.groupId) {
      const groupMatch = message.match(/(?:فوج|group|groupe|g)\s*(\d+)/i);

      if (groupMatch) {
        const groupNum = groupMatch[1];
        const pathId = userData.selectedPathId || 'UAlger3_L1_ITCF';
        const newGroupId = `${pathId}_G${groupNum}`;

        try {
          await supabase.from('study_groups').upsert({
            id: newGroupId,
            path_id: pathId,
            name: `Group ${groupNum}`
          }, { onConflict: 'id' });

          await supabase.from('users').update({ group_id: newGroupId }).eq('id', userId);

          return res.status(200).json({
            reply: `تم! ✅ راك مسجل ضروك في الفوج ${groupNum}.`,
            sessionId,
            mood: 'excited'
          });
        } catch (err) {
          console.error("Group Update Error:", err);
          return res.status(200).json({ reply: "حدث خطأ تقني أثناء تسجيل الفوج.", sessionId });
        }
      } else {
        return res.status(200).json({
          reply: "مرحبا! 👋 واش من فوج (Groupe) راك تقرا فيه؟ (اكتب: فوج 1)",
          sessionId
        });
      }
    }

    // ---------------------------------------------------------
    // 5. Context Injection & Ghost Teacher Logic
    // ---------------------------------------------------------
   
    let activeLessonContext = "";
    let lessonData = null;

    // 2. إذا أرسل الفرونت إند ID الدرس
    if (currentContext && currentContext.lessonId) {
      const { data: lData } = await supabase
          .from('lessons')
          .select('*, subjects(title)')
          .eq('id', currentContext.lessonId)
          .single();
      
      lessonData = lData;

      if (lessonData) {
          // جلب المحتوى النصي
          const { data: contentData } = await supabase
              .from('lessons_content')
              .select('content')
              .eq('id', lessonData.id)
              .single();
          
          const snippet = safeSnippet(contentData?.content || "", 1500);
          
          // 🔥 التعديل هنا: صياغة قوية جداً تجبر الـ AI على الالتزام بالسياق
          activeLessonContext = `
          🔴 **CRITICAL CONTEXT: USER IS HERE NOW**
          You are currently inside the lesson: "${lessonData.title}" (Subject: ${lessonData.subjects?.title}).
          
          **LESSON CONTENT SUMMARY:**
          """
          ${snippet}
          """
          
          👉 **MANDATORY INSTRUCTION:** 
          - The user is standing inside this lesson. 
          - All their questions (like "Explain this", "Give me a quiz") refer to "${lessonData.title}" unless stated otherwise.
          - Do NOT ask "What lesson do you mean?". You already know it.
          `;
      }
    }
  

    // =========================================================
    // 6. Data Aggregation (Parallel Fetching)
    // =========================================================
    const [
      rawProfile,
      memoryReport,
      curriculumReport,
      weaknessesRaw,
      formattedProgress,
      userTasksRes,
      progressData,
      isTableEnabled, 
      isChartEnabled  
    ] = await Promise.all([
      getProfile(userId).catch(() => ({})),
      runMemoryAgent(userId, message).catch(() => ''),
      runCurriculumAgent(userId, message).catch(() => ''),
      fetchUserWeaknesses(userId).catch(() => []),
      formatProgressForAI(userId).catch(() => ''),
      supabase.from('user_tasks').select('*').eq('user_id', userId).eq('status', 'pending'),
      getProgress(userId),
      getSystemFeatureFlag('feature_genui_table'),
      getSystemFeatureFlag('feature_genui_chart')
    ]);
     // تجميع الميزات في كائن واحد
    const enabledFeatures = {
        table: isTableEnabled,
        chart: isChartEnabled
    };
    // Schedule Status
    let scheduleStatus = null;
    let scheduleContextString = "";
    try {
      scheduleStatus = await getStudentScheduleStatus(userData.groupId);
      if (scheduleStatus) {
        scheduleContextString = scheduleStatus.context || "";
      }
    } catch (e) {
      logger.warn('getStudentScheduleStatus failed:', e);
      scheduleContextString = "";
    }

    const updatedContextForPrompt = {
      ...currentContext,
      schedule: scheduleStatus || { state: 'unknown' }
    };

    // 🔥 Gravity Intel (Task Prioritization)
    let gravityContext = null;
    let tasksList = "No active tasks.";

    if (userTasksRes && userTasksRes.data && userTasksRes.data.length > 0) {
      const sortedTasks = userTasksRes.data.sort((a, b) => (b.meta?.score || 0) - (a.meta?.score || 0));
      const topTask = sortedTasks[0];
      const topScore = topTask.meta?.score || 0;
      const isExamEmergency = topScore > 4000 && topTask.meta?.isExamPrep === true;
      const timingInfo = topTask.meta?.examTiming || "Unknown time";

      gravityContext = {
        title: topTask.title,
        score: topScore,
        isExam: isExamEmergency,
        subject: topTask.meta?.subjectId || 'General',
        timing: timingInfo
      };

      tasksList = sortedTasks.map(t => {
        const score = t.meta?.score || 0;
        const examBadge = score > 4000 ? "🚨 EXAM TOMORROW" :
          score > 1000 ? "⚠️ EXAM SOON" : "";
        
        // الصيغة الجديدة: [ID: xyz] Title (Priority)
        return `- [ID: ${t.id}] ${t.title} ${examBadge} (Priority: ${score})`;
      }).join('\n');
    }
    // ==========================================
    // 🌟 7. IMPROVEMENTS LOGIC (The Fix: Logic applied AFTER Data is ready)
    // ==========================================

    // A. Gender Awareness
    const userGender = userData.gender || 'male';

    // B. First Time User
    // Now we have both 'history' and 'userData' populated
     const isFirstTimeUser = (history.length === 0 && !userData.lastActiveAt);
    let welcomeContext = "";
    
    if (isFirstTimeUser) {
        // هنا السحر: نوجه الـ AI ليكون عاطفياً وفضولياً جداً
        welcomeContext = `
        🎉 **NEW USER ALERT: FIRST CONTACT**
        This is the VERY FIRST time this user opens the app.
        
        **YOUR MISSION:**
        1. Ignore academic lessons for now. Focus on **CONNECTION**.
        2. **Greeting:** Warm, enthusiastic Algerian welcome (e.g., "مرحبا بيك في العائلة!").
        3. **Data Extraction:** You need to fill their profile. Ask casually about:
           - Their **Name** (if not set).
           - Their **Ambition** (Dream job/Goal).
           - Their **Struggle** (Hardest subject).
        
        **Output Instruction:**
        - Ask ONE question at a time. Don't overwhelm them.
        - Example Opener: "أهلاً! أنا EduAI، رفيقك الجديد في القراية. واش، كاش قراية ولا والو؟ ... بالمناسبة، كيفاش نعيطلك؟"
        `;
    }

// 🧠 الذكاء المالي: هل أنهى الطالب هذا الدرس سابقاً؟
    let rewardContext = "";
    if (currentContext.lessonId) {
        // نبحث في بيانات التقدم هل الدرس مكتمل
        // ملاحظة: progressData تأتي من getProgress وتكون مخزنة في الكاش
        const isLessonDone = progressData.dailyTasks?.tasks?.some(t => t.relatedLessonId === currentContext.lessonId && t.status === 'completed') 
                             || (progressData.pathProgress && JSON.stringify(progressData.pathProgress).includes(currentContext.lessonId)); 
                             // (أو استخدم طريقة أدق للبحث في progressData)

        // الطريقة الأدق للبحث في progressData القادمة من helpers
        let isDone = false;
        // ... منطق البحث في progressData ...
        // للتبسيط، سنفترض أننا عرفنا الحالة (يمكنك استخدام دالة مساعدة)
        
        if (isDone) {
            rewardContext = `
            💰 **ECONOMY INTEL:**
            - User has ALREADY finished this lesson and claimed the 50 coins reward.
            - IF they ask "Why no coins?", explain: "You only earn the big reward once per lesson. But you can get small bonus coins if you get 100% score."
            `;
        } else {
            rewardContext = `
            💰 **ECONOMY INTEL:**
            - This is a NEW lesson. User will earn 50 coins if they finish it now. Use this to motivate them!
            `;
        }
    }

    // D. Streak Hype
    const streak = progressData?.streakCount || 0;
    const bestStreak = progressData?.bestStreak || 0;
    let streakContext = "";
    if (streak >= 3) {
        streakContext = `🔥 **STREAK ALERT:** User is on a ${streak}-day streak! Mention this proudly!`;
    } else if (streak === 0 && bestStreak > 5) {
        streakContext = `💔 **STREAK BROKEN:** User lost a long streak (${bestStreak} days). Be gentle and encourage them.`;
    }

    // E. Distraction Detector
    let distractionContext = "";
    if (history.length > 0) {
        const lastMsg = history[history.length - 1];
        const lastTime = new Date(lastMsg.timestamp).getTime();
        const now = Date.now();
        const diffMinutes = (now - lastTime) / (1000 * 60);
        if (diffMinutes > 10 && diffMinutes < 60) {
            distractionContext = `⏱️ **DISTRACTION DETECTED:** User went silent for ${Math.floor(diffMinutes)} mins. Tease them playfully!`;
        }
    }

    // F. Fatigue Switch
    const sessionLength = history.length;
    let fatigueContext = "";
    if (sessionLength > 20 && sessionLength % 10 === 0) {
        fatigueContext = `🧠 **FATIGUE CHECK:** Long session (${sessionLength} msgs). Suggest a break or switching subjects.`;
    }

    // G. Recent Past Exams
    const recentPastExams = await getRecentPastExams(userData.groupId);
    let pastExamsContext = "";
    if (recentPastExams.length > 0) {
        pastExamsContext = "🗓️ **RECENT PAST EXAMS (Ask user about results):**\n";
        recentPastExams.forEach(ex => {
            const dateStr = new Date(ex.exam_date).toLocaleDateString('en-US');
            const subject = ex.subjects?.title || ex.subject_id;
            pastExamsContext += `- Finished Exam: "${subject}" (${ex.type}) on ${dateStr}.\n`;
        });
        pastExamsContext += "👉 INSTRUCTION: If you haven't asked yet, ask casually: 'How did the [Subject] exam go?'\n";
    }

    // ==========================================
    // 8. Gravity Protocol & Context Assembly
    // ==========================================
    let gravitySection = "";
    let antiSamataProtocol = "";
      
    if (gravityContext) {
          const isExam = gravityContext.isExam || false;
          const timeStr = gravityContext.timing ? `(Timing: ${gravityContext.timing})` : "";

          gravitySection = `🚀 **GRAVITY ENGINE:** Top Task: "${gravityContext.title}", Score: ${gravityContext.score}. Emergency: ${isExam ? "YES" : "NO"} ${timeStr}`;
          
          if (isExam) {
              antiSamataProtocol = `🛡️ **PROTOCOL: EXAM EMERGENCY** - Exam is ${timeStr}. Be urgent!`;
          } else {
              antiSamataProtocol = `🛡️ **PROTOCOL: NO SAMATA** - No immediate exam. Chat naturally.`;
          }
      }
   // تأكد من جلب last_active_at مع بيانات المستخدم
const lastActive = userData.last_active_at ? new Date(userData.last_active_at) : null;
let absenceContext = "";

if (lastActive) {
    const daysSinceActive = (Date.now() - lastActive.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceActive > 3) {
        absenceContext = `
        👻 **GHOST ALERT:** User hasn't opened the app for ${Math.floor(daysSinceActive)} days.
        👉 **INSTRUCTION:** Start by guilt-tripping them playfully: "يا أهلا! وين كنت غاطس هاد الأيام؟ توحشناك (زعما)".
        `;
    }
}
    // Exam Context
    let examContext = {};
    if (userData.nextExamDate) {
      const humanTime = getHumanTimeDiff(userData.nextExamDate);
      examContext = { 
          subject: userData.nextExamSubject || 'General',
          timingHuman: humanTime,
          rawDate: userData.nextExamDate
      };
    }

    const aiProfileData = rawProfile || {};
    const groupId = userData.groupId;

    // Narrative Profile
    const facts = aiProfileData.facts || {};
    let userBio = "User Profile:\n";
    
    if (facts.identity) userBio += `- Name: ${facts.identity.name} (${facts.identity.role}, ${facts.identity.age}yo).\n`;
    if (facts.social) userBio += `- Circle: Friend ${facts.social.best_friend}, GF ${facts.social.girlfriend}.\n`;
    if (facts.interests) userBio += `- Loves: ${facts.interests.music?.join(', ')} and ${facts.interests.animal}.\n`;
    if (facts.education) userBio += `- Study: ${facts.education.study_style}. Weak in ${facts.education.weaknesses?.[0]}. Strong in ${facts.education.strengths?.[0]}.\n`;
    if (facts.behavior) userBio += `- Style: ${facts.behavior.tone}. Procrastinates by ${facts.behavior.procrastination}.\n`;

    // 🔥 Identity Injection
    const fullUserProfile = {
      userId: userId,
      firstName: userData.firstName || 'Student',
      lastName: userData.lastName || '',
      group: groupId,
      role: userData.role || 'student',
      gender: userGender, // ✅ Correctly populated now
      formattedBio: userBio, 

      ...aiProfileData
    };

    let currentEmotionalState = aiProfileData.emotional_state || { mood: 'happy', angerLevel: 0, reason: '' };
    const allAgenda = Array.isArray(aiProfileData.aiAgenda) ? aiProfileData.aiAgenda : [];
    const activeAgenda = allAgenda.filter(t => t.status === 'pending');

    // EduNexus Logic
    let sharedContext = "";
    if (CONFIG.ENABLE_EDUNEXUS && groupId) {
      const nexusMemory = await getNexusMemory(groupId);
      if (nexusMemory && nexusMemory.exams) {
        sharedContext = "🏫 **HIVE MIND (Group Info):**\n";
        Object.entries(nexusMemory.exams).forEach(([subject, data]) => {
          if (data.confirmed_value) {
            const status = data.is_verified ? "(Verified ✅)" : "(Rumor ⚠️)";
            sharedContext += `- Exam ${subject}: ${data.confirmed_value} ${status}\n`;
          }
        });
      }
    }

    const ageContext = rawProfile.facts?.age ? `User Age: ${rawProfile.facts.age} years old.` : "";
   
// 1. اجلب القيمة من Supabase في بداية الدالة مع باقي البيانات
const { data: settings } = await supabase
  .from('system_settings')
  .select('value')
  .eq('key', 'current_semester')
  .single();

const currentSemester = settings?.value || 'S1'; // القيمة الديناميكية
    const systemContextCombined = `
    User Identity: Name=${fullUserProfile.firstName}, Group=${groupId}, Role=${fullUserProfile.role}.
    ${ageContext}
    📅 **ACADEMIC SEASON:** We are currently in **${currentSemester}**.
    ${getAlgiersTimeContext().contextSummary}
    ${scheduleContextString}
    ${sharedContext}
    ${activeLessonContext}
    ${rewardContext}
    ${welcomeContext}
    ${streakContext}
    ${distractionContext}
    ${fatigueContext}
    ${pastExamsContext}

    📋 **CURRENT TODO LIST:**
    ${tasksList}
    
    ${gravitySection} 
    ${antiSamataProtocol}
    
    📚 **FULL CURRICULUM MAP:**
    ${curriculumMap}
    ${examContext.subject ? `🚨 **EXAM ALERT:** Subject: "${examContext.subject}" is happening **${examContext.timingHuman}**. Focus on this immediately!` : ""}
    `;

    // ---------------------------------------------------------
    // 9. AI Generation
    // ---------------------------------------------------------
    const safeMessage = message || '';

    const formatTimeShort = (isoString) => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
    };

    const safeHistoryStr = history.map(h => {
      const timeTag = h.timestamp ? `[${formatTimeShort(h.timestamp)}] ` : '';
      const speaker = (h.role === 'model' || h.author === 'bot') ? 'EduAI' : 'User';
      return `${timeTag}${speaker}: ${h.text}`;
    }).join('\n');

    const finalPrompt = PROMPTS.chat.interactiveChat(
      finalMessage,
      memoryReport || '',
      curriculumReport || '',
      safeHistoryStr,
      formattedProgress || '',
      Array.isArray(weaknessesRaw) ? weaknessesRaw : [],
      currentEmotionalState,
      fullUserProfile,
      systemContextCombined,
      examContext,
      activeAgenda,
      sharedContext,
      updatedContextForPrompt,
      gravityContext,
      absenceContext,
      enabledFeatures,
      atomicContext,
      atomicContextString 
    );
    console.log('🚀 Sending request to AI service...');

 // التعديل هنا لتتبع الخطأ بدقة
    let modelResp;
    let sources = []; // متغير لتخزين المصادر

    try {
    const resultObj = await generateWithFailoverRef('chat', finalPrompt, { 
            label: 'MasterChat', 
            timeoutMs: CONFIG.TIMEOUTS.chat, // أو قم بزيادته يدوياً إلى 60000 للتجربة
            attachments: attachments, 
            enableSearch: !!webSearch  
        });
       // نستخرج النص والمصادر
    if (typeof resultObj === 'object' && resultObj.text) {
        modelResp = resultObj.text;
        sources = resultObj.sources || [];
    } else {
        modelResp = resultObj; // حالة توافق مع النظام القديم
    }
        console.log('✅ AI Response received successfully.');
    } catch (aiError) {
        console.error('❌ [AI Generation FAILED]:');
        console.error('Type:', aiError.name);
        console.error('Message:', aiError.message);
        if (aiError.response) {
             // أخطاء جوجل غالباً تكون هنا
            console.error('Google API Details:', JSON.stringify(aiError.response, null, 2));
        }
        throw aiError; // إعادة رمي الخطأ ليتم التقاطه في الـ Catch السفلي
    }
    const rawText = await extractTextFromResult(modelResp);
    let parsedResponse = await ensureJsonOrRepair(rawText, 'analysis');

    if (!parsedResponse?.reply) parsedResponse = { reply: rawText || "Error.", widgets: [] };
   
// =========================================================
    // 🆕 المحطة 3: المراقب (The Monitor) - المنطق المصحح
    // =========================================================
    
    // 1. تعريف إشارة التحديث (نأخذها من الـ AI أولاً)
    // هذا هو التصحيح: نستخدم updateSignal مباشرة لتوحيد المتغيرات
     let updateSignal = parsedResponse.atomic_update || null; 
    
    // 2. استخراج ID الدرس (تصحيح شامل وقوي) 🔥
    // نحاول جلبه من السياق الحالي، وإذا لم نجد، نحاول جلبه من البيانات الذرية المحملة سابقاً
    let extractedLessonId = currentContext.lessonId 
                            || (atomicData && atomicData.rawData && atomicData.rawData.structure ? atomicData.rawData.structure.lesson_id : null)
                            || null;

    if (message) { 
        // A. محاولة استخراج ID الدرس من النص المخفي (الأولوية القصوى)
        // ✅ تحديث: أضفنا (\-) لدعم المعرفات التي تحتوي على شَرطة مثل "les-hist-1"
        const idMatch = message.match(/LessonID:\s*([a-zA-Z0-9_\-]+)/i);
        
        if (idMatch && idMatch[1] && idMatch[1] !== 'unknown') {
            extractedLessonId = idMatch[1]; 
            console.log(`🎯 ID FIX: Extracted LessonId from text -> ${extractedLessonId}`);
        }

        // B. تحليل النتيجة (للكويزات)
        const scoreMatch = message.match(/(\d+)\s*[\/|من]\s*(\d+)/);

        if (scoreMatch) {
            const score = parseInt(scoreMatch[1]);
            const total = parseInt(scoreMatch[2]);
            const percentage = total > 0 ? (score / total) * 100 : 0;

            if (percentage >= 70) { 
                let targetElement = null;
                let updateReason = 'quiz_passed';

                // تحديد نوع التحديث (جزئي أم كلي)
                if (total >= 4) {
                    console.log(`🧠 Smart Logic: Big Quiz (${total} Qs) -> Updating ALL Lesson`);
                    targetElement = 'ALL';
                    updateReason = 'quiz_comprehensive_passed';
                } else {
                     // كويز صغير...
                     if (atomicData && atomicData.nextTarget) {
                        targetElement = atomicData.nextTarget.id;
                    }
                }

                // تجهيز إشارة التحديث (Override للـ AI)
                if (targetElement) {
                    updateSignal = { 
                        element_id: targetElement, 
                        new_score: 100, 
                        reason: updateReason 
                    };
                    // إلغاء أي تحديث عشوائي من الـ AI لصالح الكويز الأدق
                    parsedResponse.atomic_update = null; 
                }

                // تفعيل إشارة النجاح للمكافآت (Money)
                if (percentage >= 80) {
                     parsedResponse.lesson_signal = {
                        type: 'complete',
                        id: extractedLessonId || 'chat_quiz', 
                        score: percentage
                    };
                }
            }
        }
    }
// Handle Lesson Completion

if (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete') {
  const signal = parsedResponse.lesson_signal;

  // 1. تسجيل إتمام الدرس في قاعدة البيانات
  const gatekeeperResult = await markLessonComplete(userId, signal.id, signal.score || 100);

  // 2. تحديث قائمة المهام للمستخدم (هنا يتم جلب المهام الجديدة من Planner)
  const newDbTasks = await refreshUserTasks(userId);

  // ============================================================
  // 🔥 التعديل الجذري: منطق اختيار الدرس القادم (Smart Next Step)
  // ============================================================

  // أ. معرفة مادة الدرس الذي أنهاه للتو
  let currentSubjectId = null;
  // نحاول جلبه من البيانات المحملة مسبقاً (Context) أو جلبه من قاعدة البيانات
  if (currentContext?.lessonId === signal.id && typeof lessonData !== 'undefined') {
      currentSubjectId = lessonData.subject_id;
  } else {
      // جلب سريع احتياطي في حال عدم توفر البيانات
      const { data: l } = await supabase.from('lessons').select('subject_id').eq('id', signal.id).single();
      currentSubjectId = l?.subject_id;
  }

  // ب. تصفية المهام القادمة (استبعاد الدرس الحالي نهائياً)
  // هذا يحل مشكلة اقتراح نفس الدرس
  const validNextTasks = (newDbTasks || []).filter(t => t.meta?.relatedLessonId !== signal.id);

  let nextTask = null;
  let transitionReason = "";

  // ج. البحث عن درس في "نفس المادة" أولاً (Priority 1: Sticky Subject)
  const sameSubjectTask = validNextTasks.find(t => t.meta?.relatedSubjectId === currentSubjectId);

  if (sameSubjectTask) {
      // ✅ وجدنا درساً في نفس المادة (نحافظ على التركيز)
      nextTask = sameSubjectTask;
      transitionReason = "same_subject"; 
  } else {
      // ❌ لا يوجد (المادة انتهت أو لا توجد دروس أخرى)، ننتقل لأهم مهمة عامة (Priority 2: Global Gravity)
      nextTask = validNextTasks.length > 0 ? validNextTasks[0] : null;
      transitionReason = "global_priority";
  }

  // د. إرفاق المهمة القادمة بالرد (ليستخدمها الفرونت إند في زر "المهمة التالية")
  if (nextTask) {
      parsedResponse.next_task = nextTask;
      parsedResponse.transition_reason = transitionReason;
  }

// ============================================================
// 💰 4. معالجة المكافآت والردود (Reward Logic)
// ============================================================

parsedResponse.widgets = parsedResponse.widgets || [];

if (gatekeeperResult.reward) {
    
    // حالة أ: كسب كوينز جديدة (إنجاز جديد)
    if (gatekeeperResult.reward.coins_added > 0) {
        // 1. إضافة ويدجت احتفال
        parsedResponse.widgets.push({ 
            type: 'celebration', 
            data: { 
                message: `مبروك! كسبت ${gatekeeperResult.reward.coins_added} كوين! 🪙`,
                coins: gatekeeperResult.reward.coins_added
            } 
        });
        
        // 2. تمرير البيانات لتحديث الهيدر في الفرونت إند
        res.locals.rewardData = {
            reward: gatekeeperResult.reward,
            new_total_coins: gatekeeperResult.new_total_coins
        };
    } 
    // حالة ب: لم يكسب لأنه أخذها سابقاً (Already Claimed)
    else if (gatekeeperResult.reward.already_claimed) {
        // 1. تعديل نص الرد لإضافة ملاحظة لطيفة
        const explanation = "\n\n(ملاحظة: راك ديت المكافأة تاع هاد الدرس من قبل، بصح معليش المراجعة فيها فايدة! 😉)";
        parsedResponse.reply += explanation;
        
        //2. (اختياري) إضافة ويدجت تنبيه صغير بدلاً من الاحتفال الكبير
        
        parsedResponse.widgets.push({
            type: 'toast',
            data: { message: "تم استلام المكافأة سابقاً", type: "info" }
        });
        
    }
} else {
    // حالة ج: إنجاز عادي (بدون نظام مكافآت أو درس لا يحتسب)
    parsedResponse.widgets.push({ 
        type: 'celebration', 
        data: { message: 'إنجاز عظيم! 🚀' } 
    });
}

  // 4. صياغة الرد بناءً على السياق
  const algiersTime = getAlgiersTimeContext(); 
  const currentHour = algiersTime.hour;
  const isLateNight = currentHour >= 22 || currentHour < 5; 
  const isExamEmergency = gravityContext?.isExam; 

 let recommendationText = ""; // تعريف المتغير
      
      if (nextTask) {
          if (transitionReason === "same_subject") {
              recommendationText = `\n\n🔗 **بما أننا سخنّا في هاد المادة، نكملو:** ${nextTask.title}`;
          } else {
              recommendationText = `\n\n💡 **كملنا هاد المادة! (أو ماكانش دروس)، الخطوة التالية:** ${nextTask.title}`;
          }

          parsedResponse.widgets = parsedResponse.widgets || [];
          parsedResponse.widgets.push({
            type: 'action_button',
            data: { label: `ابدأ: ${nextTask.title}`, action: 'navigate', targetId: nextTask.meta?.relatedLessonId }
          });
      } else {
          recommendationText = `\n\n🎉 كملت كلش لليوم! ارتاح يا بطل.`;
      }
      
    

      // ✅ إضافة تريجر تحديث المهام (داخل الشرط فقط)
      parsedResponse.widgets = parsedResponse.widgets || [];
      parsedResponse.widgets.push({ type: 'event_trigger', data: { event: 'tasks_updated' } });

    }


    // EduNexus Updates
    if (CONFIG.ENABLE_EDUNEXUS && parsedResponse.memory_update && groupId) {
      const action = parsedResponse.memory_update;
      if (action.action === 'UPDATE_EXAM' && action.subject && action.new_date) {
        await updateNexusKnowledge(groupId, userId, 'exams', action.subject, action.new_date);
      }
    }


// 1. معالجة أوامر الأجندة
let tasksChanged = false;
let ignoredLessonId = null; // 👈 متغير جديد

if (parsedResponse.agenda_actions && Array.isArray(parsedResponse.agenda_actions)) {
  for (const act of parsedResponse.agenda_actions) {
    
    if (act.action === 'delete' || act.action === 'remove') {
       // أ. نجلب تفاصيل المهمة قبل حذفها لنعرف الدرس المرتبط بها
       const { data: taskToDelete } = await supabase
           .from('user_tasks')
           .select('meta')
           .eq('id', act.id)
           .single();
       
       if (taskToDelete && taskToDelete.meta && taskToDelete.meta.relatedLessonId) {
           ignoredLessonId = taskToDelete.meta.relatedLessonId; // عرفنا الدرس المكروه!
       }

       // ب. نحذف المهمة
       await supabase.from('user_tasks').delete().eq('id', act.id).eq('user_id', userId);
       tasksChanged = true;
       logger.info(`🗑️ AI Deleted Task ${act.id} (Lesson: ${ignoredLessonId})`);
    } 
    
    else if (act.action === 'complete') {
       await supabase.from('user_tasks').update({ status: 'completed' }).eq('id', act.id);
       tasksChanged = true;
    }
  }
}

// 2. التحديث الفوري
if (tasksChanged || (parsedResponse.lesson_signal && parsedResponse.lesson_signal.type === 'complete')) {
    logger.info("🔄 Tasks changed. Triggering Gravity Engine with Force Refresh...");
    
    // نمرر force=true و ignoredLessonId
    const newTasks = await refreshUserTasks(userId, true, ignoredLessonId);
    
    parsedResponse.widgets = parsedResponse.widgets || [];
    parsedResponse.widgets.push({ 
        type: 'event_trigger', 
        data: { event: 'tasks_updated', tasks: newTasks } 
    });
}
    // Mood Update
    if (parsedResponse.newMood) {
      supabase.from('ai_memory_profiles').update({
        emotional_state: { mood: parsedResponse.newMood, reason: parsedResponse.moodReason || '' },
        last_updated_at: nowISO()
      }).eq('user_id', userId).then();
    }
// ---------------------------------------------------------
    // 11. Response & Background Saving
    // ---------------------------------------------------------
    res.status(200).json({
      reply: parsedResponse.reply,
      widgets: parsedResponse.widgets || [],
      sessionId: sessionId,
      mood: parsedResponse.newMood,
      sources: sources,
      ...(res.locals?.rewardData || {}) 
    });

    // Background processing (Fire and Forget)
    setImmediate(async () => {
      try {
        const updatedHistory = [
          ...history,
          { role: 'user', text: message, timestamp: nowISO() },
          { role: 'model', text: parsedResponse.reply, timestamp: nowISO() }
        ];

        // 2. حفظ الشات (كما هو)
        await saveChatSession(sessionId, userId, message.substring(0, 30), updatedHistory)
          .catch(e => logger.error('SaveChat Error:', e));

      } catch (bgError) {
        logger.error("Background Processing Fatal Error:", bgError);
      }
    });

  } catch (err) { // This now correctly closes the main 'try' block from line 115
    logger.error("ChatInteractive ERR:", err);
    if (!res.headersSent) {
      return res.status(500).json({ reply: "حدث خطأ في الخادم." });
    }
  }
}

module.exports = {
  initChatController,
  chatInteractive,
  generateChatSuggestions,
  handleGeneralQuestion
};
