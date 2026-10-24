'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('scene regeneration accepts the system array format and preserves saved prompts on failures', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-prompts-'));
  let answer = { prompts: ['A photorealistic wide shot of the second scene.'] };
  let finishReason = 'stop';
  let reasoning = '';
  const requests = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-v4-pro', choices: [{
        message: { content: typeof answer === 'string' || answer === null ? answer : JSON.stringify(answer), reasoning_content: reasoning },
        finish_reason: finishReason,
      }] }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: {
    ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_SECRET: 'generation-test-secret-1234567890',
    DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mock.address().port}/chat/completions`,
  }, stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => mock.close(resolve));
    const resolvedDir = path.resolve(dataDir);
    assert.ok(resolvedDir.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch (_) { /* app is starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.ok(ready, 'server started');
  let cookie = '';
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data };
  }
  assert.equal((await request('/api/auth/register', 'POST', { username: 'generator', password: 'password123' })).status, 201);
  assert.equal((await request('/api/me/api-key', 'PUT', { apiKey: 'sk-fake-local-test-1234567890' })).status, 200);
  const scenes = [
    { id: 'scene-a', title: 'First', action: 'A woman enters a kitchen.' },
    { id: 'scene-b', title: 'Second', action: 'She serves a bowl of pasta.' },
  ];
  const created = await request('/api/projects', 'POST', { title: 'Generator test', stage: 'Generation Stage',
    referenceMaterial: 'Two everyday scenes in a warm kitchen.', scenes,
    generationPrompts: [{ sceneId: 'scene-a', prompt: 'Original first prompt.' }, { sceneId: 'scene-b', prompt: 'Original second prompt.' }],
  });
  assert.equal(created.status, 201);
  const projectId = created.data.project.id;
  const regenerate = () => request('/api/generation/prompt', 'POST', { projectId, scene: scenes[1], model: 'deepseek-v4-pro' });

  // The original system prompt requested this exact array form, which used to fail.
  let response = await regenerate();
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.prompt, answer.prompts[0]);
  assert.equal(response.data.project.generationPrompts[0].prompt, 'Original first prompt.');
  assert.equal(response.data.project.scenes[1].order, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.match(requests[0].messages[0].content, /\{"prompt":"/);
  assert.doesNotMatch(requests[0].messages[0].content, /\{"prompts":/);

  const blockedBatch = await request('/api/generation/prompts', 'POST', { projectId, model: 'deepseek-v4-pro' });
  assert.equal(blockedBatch.status, 409, 'batch cannot replace an undecided single-scene result');
  assert.equal(requests.length, 1, 'blocked alias does not call the provider');

  const approve = async () => assert.equal((await request('/api/generation/reviews/' + response.data.generationReview.id, 'POST', { decision: 'approved' })).status, 200);
  await approve();

  for (const value of [{ prompt: 'One direct prompt.' }, { prompts: [{ prompt: 'One wrapped prompt.' }] }]) {
    answer = value;
    response = await regenerate();
    assert.equal(response.status, 200, JSON.stringify(response.data));
    await approve();
  }
  const getProject = async () => {
    const response = await request('/api/projects');
    assert.equal(response.status, 200);
    return response.data.projects.find((project) => project.id === projectId);
  };
  const saved = await getProject();
  const storyBefore = (await request(`/api/story/${projectId}`)).data.story;
  const failures = [
    { answer: { prompts: ['One', 'Two'] }, finish: 'stop', code: 'NO_PROMPTS' },
    { answer: { unrelated: 'No prompt here.' }, finish: 'stop', code: 'NO_PROMPTS' },
    { answer: 'not JSON', finish: 'stop', code: 'NO_PROMPTS' },
    { answer: null, finish: 'stop', code: 'EMPTY_PROMPT_RESPONSE' },
    { answer: '  ', finish: 'stop', code: 'EMPTY_PROMPT_RESPONSE' },
    { answer: { prompt: 'Cut short but parseable.' }, finish: 'length', code: 'PROMPT_OUTPUT_LIMIT' },
  ];
  for (const failure of failures) {
    answer = failure.answer;
    finishReason = failure.finish;
    reasoning = 'Processing information is not a final prompt.';
    const callsBefore = requests.length;
    response = await regenerate();
    assert.equal(response.status, 502);
    assert.equal(response.data.code, failure.code, JSON.stringify(response.data));
    assert.equal(requests.length, callsBefore + 1, 'no automatic paid retry');
    const current = await getProject();
    assert.deepEqual(current.generationPrompts, saved.generationPrompts);
    assert.deepEqual(current.scenes, saved.scenes);
    const currentStory = (await request(`/api/story/${projectId}`)).data.story;
    assert.deepEqual(currentStory.prompts, storyBefore.prompts);
  }

  answer = { prompts: ['First new prompt.', 'Second new prompt.'] };
  finishReason = 'stop';
  response = await request('/api/generation/prompts', 'POST', { projectId, model: 'deepseek-v4-pro' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.prompts.length, 2);
  assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });
  assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
  assert.match(requests.at(-1).messages[0].content, /\{"prompts":/);
});
