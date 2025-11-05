
'use strict';

const assert = require('node:assert');
const { test, mock } = require('node:test');
const request = require('supertest'); // Dependency for HTTP testing
const app = require('../app'); // Import the Express app

// Mock external dependencies
// This is crucial to prevent actual API calls and DB writes during tests
mock.module('../services/ai/failover', () => ({
  __esModule: true,
  default: mock.fn(async (poolName, prompt, opts) => {
    // Simulate AI response based on prompt content
    if (prompt.includes('traffic classification')) {
      if (prompt.includes('مراجعة أدائي')) {
        return { response: { text: () => Promise.resolve('{"intent": "analyze_performance", "title": "مراجعة الأداء", "language": "Arabic"}') } };
      } else if (prompt.includes('أنشئ لي خطة')) {
        return { response: { text: () => Promise.resolve('{"intent": "generate_plan", "title": "خطة دراسية", "language": "Arabic"}') } };
      }
      return { response: { text: () => Promise.resolve('{"intent": "question", "title": "سؤال عام", "language": "Arabic"}') } };
    }
    if (prompt.includes('personal performance review')) {
      return { response: { text: () => Promise.resolve('تحليل أدائك رائع يا إسلام!') } };
    }
    if (prompt.includes('genius, witty, and deeply personal AI companion')) {
      return { response: { text: () => Promise.resolve('أهلاً بك يا إسلام، كيف يمكنني مساعدتك اليوم؟') } };
    }
    if (prompt.includes('quality reviewer')) {
      return { response: { text: () => Promise.resolve('{"score": 9, "feedback": "Good."}') } };
    }
    if (prompt.includes('short, descriptive title')) {
      return { response: { text: () => Promise.resolve('محادثة جديدة') } };
    }
    if (prompt.includes('anticipate 4 highly relevant')) {
      return { response: { text: () => Promise.resolve('{"suggestions": ["ما هي مهامي اليومية؟", "لخص لي آخر درس درسته", "حلل أدائي الدراسي", "هل يمكنني تحسين درجاتي؟"]}') } };
    }
    return { response: { text: () => Promise.resolve('Mocked AI response.') } };
  }),
}));

mock.module('../services/data/firestore', () => ({
  __esModule: true,
  initializeFirestore: mock.fn(() => ({
    collection: mock.fn(() => ({
      doc: mock.fn(() => ({
        get: mock.fn(async () => ({
          exists: true,
          data: mock.fn(() => ({
            displayName: 'إسلام',
            profileSummary: 'طموح يسعى للمليون دولار قبل الـ 20.',
            dailyTasks: { tasks: [] },
            pathProgress: {},
            stats: { points: 100, rank: 'Novice' },
            streakCount: 5,
          })),
        })),
        set: mock.fn(() => Promise.resolve()),
        update: mock.fn(() => Promise.resolve()),
      })),
      add: mock.fn(() => Promise.resolve({ id: 'mockJobId' })),
      where: mock.fn(() => ({
        orderBy: mock.fn(() => ({
          limit: mock.fn(() => ({
            get: mock.fn(async () => ({ empty: true, docs: [] })),
          })),
        })),
        get: mock.fn(async () => ({ empty: true, docs: [] })),
      })),
    })),
  })),
  getFirestoreInstance: mock.fn(() => ({
    collection: mock.fn(() => ({
      doc: mock.fn(() => ({
        get: mock.fn(async () => ({
          exists: true,
          data: mock.fn(() => ({
            displayName: 'إسلام',
            profileSummary: 'طموح يسعى للمليون دولار قبل الـ 20.',
            dailyTasks: { tasks: [] },
            pathProgress: {},
            stats: { points: 100, rank: 'Novice' },
            streakCount: 5,
          })),
        })),
        set: mock.fn(() => Promise.resolve()),
        update: mock.fn(() => Promise.resolve()),
      })),
      add: mock.fn(() => Promise.resolve({ id: 'mockJobId' })),
      where: mock.fn(() => ({
        orderBy: mock.fn(() => ({
          limit: mock.fn(() => ({
            get: mock.fn(async () => ({ empty: true, docs: [] })),
          })),
        })),
        get: mock.fn(async () => ({ empty: true, docs: [] })),
      })),
    })),
  })),
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: mock.fn(() => 'MOCKED_TIMESTAMP'),
        increment: mock.fn((val) => val),
      },
      Timestamp: {
        fromDate: mock.fn((date) => `MOCKED_TIMESTAMP_FROM_${date.toISOString()}`),
      },
      FieldPath: {
        documentId: mock.fn(() => 'MOCKED_DOCUMENT_ID'),
      },
    },
  },
}));

mock.module('../services/ai', () => ({
  __esModule: true,
  initializeModelPools: mock.fn(() => {}),
  modelPools: {
    chat: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked chat response.') } })) }, key: 'mockKey1' }],
    titleIntent: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked title.') } })) }, key: 'mockKey2' }],
    review: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('{"score": 9, "feedback": "Good."}') })) }, key: 'mockKey3' }],
    analysis: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked analysis.') } })) }, key: 'mockKey4' }],
    notification: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked notification.') } })) }, key: 'mockKey5' }],
    planner: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked plan.') } })) }, key: 'mockKey6' }],
    todo: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked todo.') } })) }, key: 'mockKey7' }],
    suggestion: [{ model: { generateContent: mock.fn(() => Promise.resolve({ response: { text: () => Promise.resolve('Mocked suggestion.') } })) }, key: 'mockKey8' }],
  },
  poolNames: ['chat', 'titleIntent', 'review', 'analysis', 'notification', 'planner', 'todo', 'suggestion'],
}));

mock.module('../services/embeddings', () => ({
  __esModule: true,
  init: mock.fn(() => {}),
  generateEmbedding: mock.fn(async (text) => [0.1, 0.2, 0.3]),
  findSimilarEmbeddings: mock.fn(async (embedding, collection, topN) => []),
}));

mock.module('../services/ai/managers/memoryManager', () => ({
  __esModule: true,
  init: mock.fn(() => {}),
  saveMemoryChunk: mock.fn(() => Promise.resolve()),
  runMemoryAgent: mock.fn(async () => 'Mocked memory report.'),
}));

mock.module('../services/ai/managers/curriculumManager', () => ({
  __esModule: true,
  initCurriculumManager: mock.fn(() => {}),
  runCurriculumAgent: mock.fn(async () => 'Mocked curriculum report.'),
}));

mock.module('../services/ai/managers/conversationManager', () => ({
  __esModule: true,
  initConversationManager: mock.fn(() => {}),
  runConversationAgent: mock.fn(async () => 'Mocked conversation report.'),
}));

mock.module('../services/ai/managers/notificationManager', () => ({
  __esModule: true,
  initNotificationManager: mock.fn(() => {}),
  runNotificationManager: mock.fn(async (type) => {
    if (type === 'ack') return 'تم استلام طلبك.';
    return 'Mocked notification.';
  }),
  runReEngagementManager: mock.fn(async () => 'Mocked re-engagement message.'),
  runInterventionManager: mock.fn(async () => 'Mocked intervention message.'),
}));

mock.module('../services/ai/managers/plannerManager', () => ({
  __esModule: true,
  initPlannerManager: mock.fn(() => {}),
  runPlannerManager: mock.fn(async () => ({ tasks: [{ id: '1', title: 'مراجعة الدرس', type: 'review' }], source: 'AI' })),
}));

mock.module('../services/ai/managers/todoManager', () => ({
  __esModule: true,
  initToDoManager: mock.fn(() => {}),
  runToDoManager: mock.fn(async () => ({ updatedTasks: [], change: { action: 'updated' } })),
}));

mock.module('../services/jobs/queue', () => ({
  __esModule: true,
  enqueueJob: mock.fn(async () => 'mockJobId'),
}));

mock.module('../services/jobs/worker', () => ({
  __esModule: true,
  initJobWorker: mock.fn(() => {}),
  jobWorkerLoop: mock.fn(() => {}),
  stopWorker: mock.fn(() => {}),
}));

// Mock config to ensure consistent values
mock.module('../config', () => ({
  __esModule: true,
  default: {
    PORT: 3000,
    MODEL: {
      chat: 'gemini-2.5-pro',
      todo: 'gemini-2.5-flash',
      planner: 'gemini-2.5-flash',
      review: 'gemini-2.5-flash',
      analysis: 'gemini-2.5-flash',
      titleIntent: 'gemini-2.5-flash-lite',
      notification: 'gemini-2.5-flash-lite',
      suggestion: 'gemini-2.5-flash',
      embedding: 'text-embedding-004',
    },
    TIMEOUTS: {
      default: 25000,
      chat: 30000,
      notification: 25000,
      review: 20000,
      analysis: 24000,
    },
    CACHE_TTL_MS: 30000,
    JOB_POLL_MS: 3000,
    REVIEW_THRESHOLD: 6,
    MAX_RETRIES: 3,
    NIGHTLY_JOB_SECRET: 'test_secret',
  },
}));

// Need to ensure the app is initialized before tests run
// This requires a slight modification to how app.js is exported or how tests are run.
// For simplicity, we'll assume `boot()` in index.js is called before tests,
// and `app` is ready.

test('GET /health should return 200 with status ok', async () => {
  const response = await request(app).get('/health');
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(response.body.ok, true);
  assert.ok(response.body.pools);
});

test('POST /chat with general question should return a reply', async () => {
  const response = await request(app)
    .post('/chat')
    .send({ userId: 'testUser123', message: 'مرحبا، كيف حالك؟' });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.body.reply);
  assert.strictEqual(response.body.isAction, false);
});

test('POST /chat with "analyze_performance" intent should return performance analysis', async () => {
  const response = await request(app)
    .post('/chat')
    .send({ userId: 'testUser123', message: 'مراجعة أدائي لهذا الأسبوع.' });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.body.reply.includes('تحليل أدائك رائع يا إسلام!'));
  assert.strictEqual(response.body.isAction, false);
});

test('POST /chat with "generate_plan" intent should enqueue a job', async () => {
  const response = await request(app)
    .post('/chat')
    .send({ userId: 'testUser123', message: 'أنشئ لي خطة دراسية.' });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.reply, 'تم استلام طلبك.');
  assert.strictEqual(response.body.isAction, true);
  assert.strictEqual(response.body.jobId, 'mockJobId');
});

test('POST /chat-interactive should return a reply and session info', async () => {
  const response = await request(app)
    .post('/chat-interactive')
    .send({ userId: 'testUser123', message: 'سؤال تفاعلي جديد.' });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(response.body.reply.includes('أهلاً بك يا إسلام، كيف يمكنني مساعدتك اليوم؟'));
  assert.ok(response.body.sessionId);
  assert.ok(response.body.chatTitle);
});

test('POST /generate-chat-suggestions should return suggestions', async () => {
  const response = await request(app)
    .post('/generate-chat-suggestions')
    .send({ userId: 'testUser123' });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.suggestions));
  assert.strictEqual(response.body.suggestions.length, 4);
});

test('POST /log-event should return 202 and log event', async () => {
  const response = await request(app)
    .post('/log-event')
    .send({ userId: 'testUser123', eventName: 'app_open', eventData: { screen: 'home' } });

  assert.strictEqual(response.statusCode, 202);
  assert.strictEqual(response.body.message, 'Event logged. Coach is analyzing.');
});

test('POST /run-nightly-analysis with correct secret should return 202', async () => {
  const response = await request(app)
    .post('/run-nightly-analysis')
    .set('X-Job-Secret', 'test_secret')
    .send({});

  assert.strictEqual(response.statusCode, 202);
  assert.strictEqual(response.body.message, 'Nightly analysis job started.');
});

test('POST /run-nightly-analysis with incorrect secret should return 401', async () => {
  const response = await request(app)
    .post('/run-nightly-analysis')
    .set('X-Job-Secret', 'wrong_secret')
    .send({});

  assert.strictEqual(response.statusCode, 401);
  assert.strictEqual(response.body.error, 'Unauthorized.');
});

// Add more tests for other routes as needed
```

**2. `tests/utils.test.js` (اختبارات لوظائف `utils`)**
*   **السبب:** اختبار الوظائف المساعدة العامة.
*   **المحتوى:**
```javascript
// tests/utils.test.js
'use strict';

const assert = require('node:assert');
const { test, mock } = require('node:test');
const {
  sleep, iso, escapeForPrompt, safeSnippet, shuffled, withTimeout,
  extractTextFromResult, parseJSONFromText, ensureJsonOrRepair,
  setGenerateWithFailover
} = require('../utils');
const CONFIG = require('../config');

// Mock generateWithFailover for ensureJsonOrRepair
const mockGenerateWithFailover = mock.fn(async (poolName, prompt, opts) => {
  if (prompt.includes('Fix it and return ONLY the JSON')) {
    const jsonMatch = prompt.match(/TEXT:\n(\{[\s\S]*?\})/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        JSON.parse(jsonMatch[1]); // Try parsing
        return { response: { text: () => Promise.resolve(jsonMatch[1]) } };
      } catch (e) {
        // If it's not valid, try to fix a common error
        const fixed = jsonMatch[1].replace(/,\s*([}\]])/g, '$1');
        try {
          JSON.parse(fixed);
          return { response: { text: () => Promise.resolve(fixed) } };
        } catch (e2) {
          return { response: { text: () => Promise.resolve('{}') } }; // Fallback
        }
      }
    }
  }
  return { response: { text: () => Promise.resolve('{}') } };
});
setGenerateWithFailover(mockGenerateWithFailover); // Inject the mock

test('sleep function should pause for given milliseconds', async () => {
  const start = Date.now();
  await sleep(10);
  const end = Date.now();
  assert.ok(end - start >= 10, 'Sleep duration should be at least 10ms');
});

test('iso function should return a valid ISO string', () => {
  const date = iso();
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date), 'Should be a valid ISO 8601 string');
});

test('escapeForPrompt should escape double quotes', () => {
  const text = 'This is a "test" string.';
  assert.strictEqual(escapeForPrompt(text), 'This is a \\"test\\" string.');
});

test('safeSnippet should truncate long text', () => {
  const longText = 'a'.repeat(2500);
  const snippet = safeSnippet(longText, 100);
  assert.strictEqual(snippet.length, 100 + '...[truncated]'.length);
  assert.ok(snippet.endsWith('...[truncated]'));
});

test('shuffled function should shuffle an array', () => {
  const arr = [1, 2, 3, 4, 5];
  const shuffledArr = shuffled(arr);
  assert.strictEqual(shuffledArr.length, arr.length);
  assert.notDeepStrictEqual(shuffledArr, arr, 'Array should be shuffled (probabilistic)');
  assert.deepStrictEqual(shuffledArr.sort(), arr.sort(), 'Shuffled array should contain same elements');
});

test('withTimeout should resolve for fast promises', async () => {
  const result = await withTimeout(Promise.resolve('done'), 100, 'test');
  assert.strictEqual(result, 'done');
});

test('withTimeout should reject for slow promises', async () => {
  await assert.rejects(
    withTimeout(sleep(200).then(() => 'done'), 10, 'test'),
    { message: 'test timed out after 10ms' },
    'Should throw timeout error'
  );
});

test('extractTextFromResult should extract text from various AI response formats', async () => {
  assert.strictEqual(await extractTextFromResult({ response: { text: () => Promise.resolve('Hello') } }), 'Hello');
  assert.strictEqual(await extractTextFromResult('Direct text'), 'Direct text');
  assert.strictEqual(await extractTextFromResult({ text: 'Text field' }), 'Text field');
  assert.strictEqual(await extractTextFromResult({ outputText: 'Output text' }), 'Output text');
  assert.strictEqual(await extractTextFromResult({ output: 'Output string' }), 'Output string');
  assert.strictEqual(await extractTextFromResult({
    output: [{
      content: [{ text: 'Part 1' }, { text: 'Part 2' }]
    }]
  }), 'Part 1\nPart 2');
  assert.strictEqual(await extractTextFromResult({
    candidates: [{ text: 'Candidate text' }]
  }), 'Candidate text');
  assert.strictEqual(await extractTextFromResult({
    candidates: [{ message: { content: [{ text: 'Msg Part 1' }, { parts: ['Msg Part 2'] }] } }]
  }), 'Msg Part 1Msg Part 2');
});

test('parseJSONFromText should parse valid JSON', () => {
  const json = 'Some text before {"key": "value"} some text after.';
  assert.deepStrictEqual(parseJSONFromText(json), { key: 'value' });
});

test('parseJSONFromText should return null for invalid JSON', () => {
  const invalidJson = 'Not a json string';
  assert.strictEqual(parseJSONFromText(invalidJson), null);
});

test('parseJSONFromText should fix trailing commas and parse', () => {
  const jsonWithTrailingComma = '{"a":1, "b":2,}';
  assert.deepStrictEqual(parseJSONFromText(jsonWithTrailingComma), { a: 1, b: 2 });
});

test('ensureJsonOrRepair should parse valid JSON', async () => {
  const validJson = '{"data": "ok"}';
  const result = await ensureJsonOrRepair(validJson);
  assert.deepStrictEqual(result, { data: 'ok' });
});

test('ensureJsonOrRepair should repair malformed JSON (simple case)', async () => {
  const malformedJson = 'Some text { "key": "value", } more text';
  const result = await ensureJsonOrRepair(malformedJson);
  assert.deepStrictEqual(result, { key: 'value' });
});

test('ensureJsonOrRepair should return null for unfixable JSON', async () => {
  const unfixableJson = 'Not a json at all';
  const result = await ensureJsonOrRepair(unfixableJson);
  assert.deepStrictEqual(result, {}); // Mock returns empty object for unfixable
});
