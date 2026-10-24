'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error('server did not become ready');
}

test('Reviewer bot UI contract', () => {
  assert.match(html, /id="reviewer-pane"/);
  assert.match(html, /id="reviewer-project"/);
  assert.match(html, /id="reviewer-box"/);
  assert.match(html, /id="reviewer-fields"/);
  assert.match(html, /id="reviewer-details-btn"[^>]*>Details</);
  assert.match(html, /id="reviewer-run"[^>]*>Review</);
  assert.match(html, /id="reviewer-rerun"[^>]*>Review again</);
  assert.match(html, /id="reviewer-modal"/);
  assert.match(html, /id="reviewer-detail-list"/);
  assert.match(html, /class="reviewer-legend"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="reviewer-modal-title"/);

  assert.match(app, /REVIEWER_BOX_OPTIONS/);
  assert.match(app, /function renderReviewer\(/);
  assert.match(app, /async function loadReviewerFields\(/);
  assert.match(app, /async function runReviewer\(/);
  assert.match(app, /function openReviewerDetails\(/);
  assert.match(app, /status === 'reviewed'/);
  assert.match(app, /field\.status = 'failed'/);
  assert.match(app, /reviewer-status-icon/);
  assert.match(app, /reviewer-mode/);
  assert.match(app, /api\/reviewer\/review/);
  assert.match(app, /data\.reviews/);
  assert.match(app, /contentHash/);
  assert.doesNotMatch(app, /REVIEWER_CONCURRENCY/);

  assert.match(css, /\.reviewer-pane/);
  assert.match(css, /\.reviewer-status-icon\.reviewed/);
  assert.match(css, /\.reviewer-status-icon\.failed/);
  assert.match(css, /\.reviewer-status-icon\.processing/);
  assert.match(css, /\.reviewer-spinner/);
  assert.match(css, /\.sidebar\.reviewer-mode \.sidebar-checklist/);
  assert.match(css, /\.reviewer-modal/);
});

test('reviewer batches fields and persists results by content', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-bot-'));
  let mockCalls = 0;
  let lastFieldIds = [];
  let responseMode = 'normal';
  let lastUserText = '';
  let responseDelay = 0;
  const batchSizes = [];

  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      mockCalls += 1;
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* ignore */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userText = messages
        .filter((message) => message && message.role === 'user')
        .map((message) => String(message.content || ''))
        .join('\n');

      const parts = userText.split('Field id: ').slice(1);
      lastUserText = userText;
      lastFieldIds = parts.map((part) => part.split('\n')[0].trim());
      batchSizes.push(parts.length);
      const reviews = parts.map((part) => {
        const id = part.split('\n')[0].trim();
        if (part.includes('NEGATIVE REVIEW TARGET')) {
          return {
            id,
            verdict: 'fail',
            summary: 'The wardrobe is missing from this prompt.',
            findings: [{ severity: 'error', message: 'No wardrobe description is present.' }],
            suggestions: ['Name the character clothing explicitly.'],
          };
        }
        return {
          id,
          verdict: 'pass',
          summary: 'The prompt is complete and consistent.',
          findings: [],
          suggestions: [],
        };
      });

      if (responseMode === 'missing') reviews.pop();
      if (responseMode === 'duplicate' && reviews.length > 1) reviews[1].id = reviews[0].id;
      if (responseMode === 'bad-verdict' && reviews.length) reviews[0].verdict = 'maybe';
      const payload = {
        choices: [{ message: { content: responseMode === 'bad-json' ? 'not JSON' : JSON.stringify({ reviews }) }, finish_reason: 'stop' }],
        model: body.model,
        usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 40, total_tokens: 1040 },
      };
      const isError = responseMode === 'http-error';
      setTimeout(() => {
        res.writeHead(isError ? 429 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(isError ? { error: { message: 'Try later' } } : payload));
      }, responseDelay);
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const startApp = () => spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'reviewer-bot-secret-long-enough-123456',
      NODE_ENV: 'test',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
    },
    stdio: 'ignore',
  });
  let child = startApp();

  t.after(async () => {
    if (child && !child.killed) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await new Promise((resolve) => mock.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });
  await waitForHealth(base);

  async function request(pathname, { method = 'GET', body, cookie = '', origin } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: response.status, data, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  }

  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'reviewbot', password: 'password123' },
  });
  assert.equal(registration.status, 201);
  const cookie = registration.cookie;

  const created = await request('/api/projects', {
    method: 'POST',
    cookie,
    body: {
      title: 'The Full-Length Mirror',
      stage: 'Generation Stage',
      referenceMaterial: 'A grounded story about a mirror workshop.',
      scenes: [
        {
          id: 'scene-one',
          title: 'Split Seam Discovery',
          action: 'Mara discovers a split seam in the mirror frame.',
          location: 'Mirror workshop',
          characters: ['Mara'],
        },
        {
          id: 'scene-two',
          title: 'Removing the Split Shirt',
          action: 'Mara removes the split shirt from the mannequin.',
          location: 'Mirror workshop',
          characters: ['Mara'],
        },
        {
          id: 'scene-three',
          title: 'Unwritten Scene',
          action: 'The workshop closes for the night.',
          location: 'Mirror workshop',
          characters: ['Mara'],
        },
      ],
      generationPrompts: [
        { sceneId: 'scene-one', prompt: 'Photorealistic Mara in a cream cardigan inspecting a mirror seam in a warm workshop.' },
        { sceneId: 'scene-two', prompt: 'Photorealistic NEGATIVE REVIEW TARGET at a workbench under soft window light.' },
      ],
    },
  });
  assert.equal(created.status, 201, created.data && created.data.error);
  const project = created.data.project;

  let result = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
  assert.equal(result.status, 200, result.data && result.data.error);
  assert.equal(result.data.box.label, 'Scene Prompts');
  assert.equal(result.data.fields.length, 3);
  assert.deepEqual(result.data.fields.map((field) => field.label), [
    'Scene 1 · Split Seam Discovery',
    'Scene 2 · Removing the Split Shirt',
    'Scene 3 · Unwritten Scene',
  ]);
  assert.equal(result.data.fields[0].hasContent, true);
  assert.equal(result.data.fields[2].hasContent, false);
  assert.ok(result.data.fields.every((field) => typeof field.contentHash === 'string' && field.contentHash));
  assert.ok(result.data.fields.every((field) => field.review === null));

  // A missing API key is reported before the AI call is attempted.
  result = await request('/api/reviewer/review', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'NO_API_KEY');
  assert.equal(mockCalls, 0);

  result = await request('/api/me/api-key', {
    method: 'PUT',
    cookie,
    body: { apiKey: 'sk-reviewer-key-1234567890' },
  });
  assert.equal(result.status, 200);

  // First review: two AI fields (the empty one fails without AI) in ONE call.
  result = await request('/api/reviewer/review', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 200, result.data && result.data.error);
  assert.equal(result.data.reviews.length, 3);
  assert.deepEqual(lastFieldIds, ['scene-prompt:scene-one', 'scene-prompt:scene-two']);
  assert.equal(mockCalls, 1);

  const first = result.data.reviews[0];
  assert.equal(first.id, 'scene-prompt:scene-one');
  assert.equal(first.status, 'reviewed');
  assert.equal(first.summary, 'The prompt is complete and consistent.');
  assert.equal(first.findings.length, 0);
  assert.equal(first.model, 'deepseek-v4-pro');
  assert.ok(first.reviewedAt);

  const second = result.data.reviews[1];
  assert.equal(second.status, 'failed');
  assert.equal(second.findings[0].severity, 'error');
  assert.match(second.suggestions[0], /clothing/i);

  const third = result.data.reviews[2];
  assert.equal(third.status, 'failed');
  assert.match(third.summary, /empty/i);

  // Unchanged content is served from the cache without another AI call.
  result = await request('/api/reviewer/review', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.reviews.length, 3);
  assert.equal(mockCalls, 1);

  // Fields now return their persisted results on GET.
  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
  assert.equal(result.data.fields[0].review.status, 'reviewed');
  assert.equal(result.data.fields[1].review.status, 'failed');
  assert.equal(result.data.fields[2].review, null);

  // Only a changed field is re-reviewed.
  const changed = await request(`/api/projects/${project.id}`, {
    method: 'PUT',
    cookie,
    body: {
      generationPrompts: [
        { sceneId: 'scene-one', prompt: 'Photorealistic Mara in a dark wool coat inspecting a mirror seam at night.' },
        { sceneId: 'scene-two', prompt: 'Photorealistic NEGATIVE REVIEW TARGET at a workbench under soft window light.' },
      ],
    },
  });
  assert.equal(changed.status, 200);

  result = await request('/api/reviewer/review', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(lastFieldIds, ['scene-prompt:scene-one']);
  assert.equal(mockCalls, 2);
  assert.doesNotMatch(lastUserText, /Other scene prompts|NEGATIVE REVIEW TARGET/);
  assert.equal(result.data.reviews[0].status, 'reviewed');
  assert.equal(result.data.reviews[1].status, 'failed');

  // A restart retains cached results without another upstream call.
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = startApp();
  await waitForHealth(base);
  result = await request('/api/reviewer/review', {
    method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 200);
  assert.equal(mockCalls, 2);

  // Relevant context invalidates both reviews even when field text is unchanged.
  await request(`/api/projects/${project.id}`, {
    method: 'PUT', cookie, body: { referenceMaterial: 'The workshop is now a cold glass studio.' },
  });
  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
  assert.ok(result.data.fields.every((field) => field.review === null));
  await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(mockCalls, 3);
  assert.equal(lastFieldIds.length, 2);

  // Model and reviewer instruction changes invalidate prior results.
  await request('/api/me/chat-settings', { method: 'PUT', cookie,
    body: { reviewerProvider: 'deepseek', reviewerModel: 'deepseek-flash', reviewerContext: 'Check lighting carefully.' } });
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.equal(mockCalls, 4);
  assert.equal(result.data.reviews[0].model, 'deepseek-flash');

  // Simultaneous refreshes of the same snapshot share one paid call.
  responseDelay = 50;
  const concurrent = await Promise.all([1, 2].map(() => request('/api/reviewer/review', {
    method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts', force: true },
  })));
  assert.ok(concurrent.every((response) => response.status === 200));
  assert.equal(mockCalls, 5);
  responseDelay = 0;

  // An invalid first response for a changed field is not cached and can retry normally.
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: {
    generationPrompts: [
      { sceneId: 'scene-one', prompt: 'Mara checks a freshly repaired frame under a new desk lamp.' },
      { sceneId: 'scene-two', prompt: 'Photorealistic NEGATIVE REVIEW TARGET at a workbench under soft window light.' },
    ],
  } });
  responseMode = 'missing';
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 502);
  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
  assert.equal(result.data.fields[0].review, null);
  responseMode = 'normal';
  const callsBeforeNormalRetry = mockCalls;
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.deepEqual(lastFieldIds, ['scene-prompt:scene-one']);
  assert.equal(mockCalls, callsBeforeNormalRetry + 1);

  // Invalid, missing, and duplicate results never overwrite a valid cached review.
  for (const mode of ['missing', 'duplicate', 'bad-verdict', 'bad-json']) {
    responseMode = mode;
    result = await request('/api/reviewer/review', {
      method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts', force: true },
    });
    assert.equal(result.status, 502, mode);
    assert.equal(result.data.code, 'INVALID_REVIEW_RESPONSE', mode);
    const cached = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
    assert.equal(cached.data.fields[0].review.status, 'reviewed');
  }
  responseMode = 'http-error';
  result = await request('/api/reviewer/review', {
    method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts', force: true },
  });
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'RATE_LIMITED');
  responseMode = 'normal';
  const callsBeforeRetry = mockCalls;
  result = await request('/api/reviewer/review', {
    method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts', force: true },
  });
  assert.equal(result.status, 200);
  assert.equal(mockCalls, callsBeforeRetry + 1);

  // Token metadata is durable and cache hits create no upstream usage records.
  const usageDb = new DatabaseSync(path.join(workDir, 'app.db'), { readOnly: true });
  const usageRows = usageDb.prepare('SELECT * FROM api_usage ORDER BY rowid').all();
  assert.equal(usageRows.length, mockCalls);
  assert.equal(usageRows[0].input_tokens, 1000);
  assert.equal(usageRows[0].cached_input_tokens, 900);
  assert.equal(usageRows[0].total_tokens, 1040);
  assert.equal(usageRows[0].operation, 'field-review');
  assert.equal(usageRows.find((row) => row.error_code === 'RATE_LIMITED').total_tokens, null);
  assert.doesNotMatch(JSON.stringify(usageRows), /sk-reviewer|NEGATIVE REVIEW TARGET|private prompt/);
  usageDb.close();

  // Small fields are limited to eight per call; larger fields split by size too.
  const manyScenes = Array.from({ length: 10 }, (_, index) => ({ id: `batch-${index}`, title: `Scene ${index}`, action: 'A person enters.' }));
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: {
    scenes: manyScenes, generationPrompts: manyScenes.map((scene) => ({ sceneId: scene.id, prompt: 'A person enters the workshop.' })),
  } });
  const batchesBefore = batchSizes.length;
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.deepEqual(batchSizes.slice(batchesBefore), [8, 2]);
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: {
    generationPrompts: manyScenes.map((scene) => ({ sceneId: scene.id, prompt: 'A'.repeat(6000) })),
  } });
  const largeBatchesBefore = batchSizes.length;
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.deepEqual(batchSizes.slice(largeBatchesBefore), [6, 4]);

  // Oversized fields are rejected locally rather than silently reviewed as excerpts.
  const callsBeforeOversized = mockCalls;
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: {
    generationPrompts: manyScenes.map((scene, index) => ({ sceneId: scene.id, prompt: 'A'.repeat(index === 0 ? 16001 : 6000) })),
  } });
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.match(result.data.reviews[0].summary, /exceeds.*review limit/);
  assert.equal(mockCalls, callsBeforeOversized);

  // Changes beyond the transmitted reference excerpt also invalidate cached reviews.
  const referencePrefix = 'Reference context. '.repeat(300);
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: { referenceMaterial: `${referencePrefix}Ending A` } });
  result = await request('/api/reviewer/review', { method: 'POST', cookie, body: { projectId: project.id, box: 'scene-prompts' } });
  assert.equal(result.status, 200);
  assert.doesNotMatch(lastUserText, /Ending A/);
  await request(`/api/projects/${project.id}`, { method: 'PUT', cookie, body: { referenceMaterial: `${referencePrefix}Ending B` } });
  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=scene-prompts`, { cookie });
  assert.ok(result.data.fields.every((field) => field.review === null));

  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=story-brief`, { cookie });
  assert.equal(result.status, 200);
  assert.equal(result.data.fields.length, 7);
  assert.equal(result.data.fields[0].label, 'Story title');
  assert.ok(result.data.fields.some((field) => field.hasContent === false));

  result = await request(`/api/reviewer/fields?projectId=${project.id}&box=not-a-box`, { cookie });
  assert.equal(result.status, 400);

  result = await request('/api/reviewer/fields?projectId=missing&box=scene-prompts', { cookie });
  assert.equal(result.status, 404);

  result = await request('/api/reviewer/review', {
    method: 'POST',
    cookie,
    origin: 'https://evil.example',
    body: { projectId: project.id, box: 'scene-prompts' },
  });
  assert.equal(result.status, 403);
});
