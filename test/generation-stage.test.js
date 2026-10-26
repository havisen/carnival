'use strict';

// Generation Stage end-to-end contract:
//
//   1. Build Image Prompts from the shared references (character references,
//      character reference sheets, action references, location references).
//   2. Save the prompts, then approve every prompt individually.
//   3. Review the prompts; every flag is edited away or dismissed.
//   4. Run image generation one by one, with the character reference sheet
//      attached to every request, filing each result into the project and the
//      Library.
//
// The test drives only local mock providers and a temporary data directory.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j8sAAAAASUVORK5CYII=',
  'base64'
);
const CHARACTER_REFERENCE = 'Ava: shoulder-length auburn hair, freckles, faded denim overalls, silver pendant.';
const BEN_REFERENCE = 'Ben: tall, grey wool coat, short beard.';

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

/**
 * One mock provider that answers both DeepSeek chat completions and BytePlus
 * image generations, branching on the request so every workflow step gets a
 * deterministic, offline answer.
 */
function createProviderMock({ flags = [], actionCharacters = ['Ava'] } = {}) {
  const calls = { chat: [], images: [] };
  const state = { buildAnswer: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = null; }
      res.writeHead(200, { 'content-type': 'application/json' });

      if (String(req.url).includes('/images')) {
        calls.images.push(body);
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), output_format: 'png', size: '2K' }] }));
        return;
      }

      calls.chat.push(body);
      const messages = (body && body.messages) || [];
      const system = messages[0] ? String(messages[0].content) : '';
      const last = messages.length ? String(messages[messages.length - 1].content) : '';
      let content = '{}';
      const exactly = (text) => Number((text.match(/Exactly (\d+)/) || [])[1] || 1);
      const writeExactly = (text) => Number((text.match(/Write exactly (\d+) image prompts/) || [])[1] || 1);

      if (/numbered-in-order actions/.test(system)) {
        const count = exactly(system);
        content = JSON.stringify({
          actions: Array.from({ length: count }, (_, index) => ({
            action: `Ava crosses the wheat field in beat ${index + 1} and lifts the lantern.`,
            locationSentence: `The wheat field at dusk, beat ${index + 1}.`,
            characters: actionCharacters,
          })),
        });
      } else if (/same order as the location sentences/.test(system)) {
        const count = exactly(system);
        content = JSON.stringify({
          locations: Array.from({ length: count }, (_, index) => ({
            name: `Wheat field ${index + 1}`,
            description: `An open golden wheat field stretching to a treeline, variant ${index + 1}.`,
          })),
        });
      } else if (/one production-ready image prompt per action reference/.test(system)) {
        if (state.buildAnswer !== null) {
          content = typeof state.buildAnswer === 'string' ? state.buildAnswer : JSON.stringify(state.buildAnswer);
        } else {
          const count = writeExactly(last);
          content = JSON.stringify({
            prompts: Array.from({ length: count }, (_, index) => (
              `Photorealistic wide shot ${index + 1}: Ava, shoulder-length auburn hair and faded denim overalls, `
              + 'lifts a lantern in the golden wheat field at dusk, natural light, 35mm lens.'
            )),
          });
        }
      } else if (/visual-continuity reviewer/.test(system)) {
        content = JSON.stringify({ flags });
      }

      res.end(JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        model: 'deepseek-v4-pro',
      }));
    });
  });
  return {
    calls,
    state,
    server,
    setBuildAnswer: (value) => { state.buildAnswer = value; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  };
}

function startServer(workDir, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: workDir,
      APP_SECRET: 'generation-stage-secret-long-enough-123456',
      NODE_ENV: 'test',
      ...env,
    },
    stdio: 'ignore',
  });
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function makeRequest(base) {
  return async function request(pathname, { method = 'GET', body, cookie = '', origin } = {}) {
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
  };
}

async function register(request, username) {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'password123' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.ok(result.cookie);
  return result.cookie;
}

async function prepareProject(request, cookie, project) {
  let result = await request('/api/projects', { method: 'POST', cookie, body: project });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.project;
}

test('Generation Stage builds, approves, reviews, and renders every image', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-stage-'));
  const mock = createProviderMock({
    actionCharacters: ['Ava'],
    flags: [
      {
        promptId: 'draft-1',
        severity: 'error',
        message: 'Ava is described with different hair than her character reference.',
      },
      {
        promptId: 'draft-2',
        severity: 'warning',
        message: 'The location description does not match the location reference.',
      },
    ],
  });
  await mock.listen();
  const mockPort = mock.server.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(workDir, {
    PORT: String(port),
    DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
    BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mockPort}/images/generations`,
  });

  t.after(async () => {
    await stopServer(child);
    await new Promise((resolve) => mock.server.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  await waitForHealth(base);
  const request = makeRequest(base);
  const cookie = await register(request, 'generation-owner');

  let result = await request('/api/me/api-key', { method: 'PUT', cookie, body: { apiKey: 'sk-test-deepseek-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request('/api/me/byteplus-key', { method: 'PUT', cookie, body: { apiKey: 'bp-test-byteplus-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const project = await prepareProject(request, cookie, {
    title: 'Harvest Moon',
    stage: 'Generation Stage',
    referenceMaterial: 'A widowed farmer and her estranged brother rebuild their bond over one autumn harvest.',
    characterReferences: [{ name: 'Ava', gender: 'Female', referenceMaterial: CHARACTER_REFERENCE }],
  });

  // Story Workspace: the character, the action references, the location
  // references, and a final character reference sheet.
  result = await request(`/api/story/${project.id}/characters`, {
    method: 'POST',
    cookie,
    body: {
      name: 'Ava',
      gender: 'Female',
      age: '42',
      appearance: 'Shoulder-length auburn hair and freckles across her nose.',
      wardrobe: 'Faded denim overalls over a cream wool cardigan.',
      continuityNotes: 'A small scar above her right eyebrow; wears a silver pendant.',
      approved: true,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const ava = result.data.character;

  result = await request(`/api/story/${project.id}/worksheet/actions/generate`, {
    method: 'POST',
    cookie,
    body: { count: 2 },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.actions.length, 2);

  result = await request(`/api/story/${project.id}/worksheet/actions/save`, {
    method: 'POST',
    cookie,
    body: { actions: result.data.actions },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request(`/api/story/${project.id}/worksheet/locations/generate`, { method: 'POST', cookie, body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.locations.length, 2);
  const locations = result.data.locations;

  result = await request(`/api/story/${project.id}/worksheet/locations/save`, {
    method: 'POST',
    cookie,
    body: { locations },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request(`/api/story/${project.id}/characters/${ava.id}/sheets/generate`, {
    method: 'POST',
    cookie,
    body: { size: '2K' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const draftSheet = result.data.sheet;
  assert.equal(draftSheet.status, 'draft');
  assert.ok(mock.calls.images.some((body) => Array.isArray(body.image) && body.image.length === 1));

  result = await request(`/api/story/sheets/${draftSheet.id}/promote`, { method: 'POST', cookie, body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.sheet.status, 'final');

  // Step 1: the shared reference bundle is complete and ready to build from.
  result = await request(`/api/generation/${project.id}`, { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const references = result.data.references;
  assert.equal(references.ready.build, true, JSON.stringify(references.blockers));
  assert.equal(references.ready.images, true, JSON.stringify(references.blockers));
  assert.deepEqual(references.blockers, []);
  assert.equal(references.actions.length, 2);
  assert.equal(references.locations.length, 2);
  assert.equal(references.characters.length, 1);
  assert.equal(references.characters[0].name, 'Ava');
  assert.equal(references.characters[0].referenceMaterial, CHARACTER_REFERENCE);
  assert.equal(references.characters[0].sheet.version, 1);
  assert.deepEqual(references.characters[0].sheet.mime, 'image/png');
  assert.equal(result.data.task.prompts.length, 0);
  assert.equal(result.data.task.state.prompts, false);
  assert.deepEqual(result.data.task.state.openFlagCount, 0);
  assert.ok(result.data.imageSizes.includes('2K'));

  // A build request carries the shared references and asks for JSON.
  const buildCallIndex = mock.calls.chat.length;
  result = await request('/api/generation/build', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.prompts.length, 2);
  const buildCall = mock.calls.chat[buildCallIndex];
  assert.equal(buildCall.response_format.type, 'json_object');
  assert.equal(buildCall.thinking.type, 'disabled');
  const buildUserText = buildCall.messages[buildCall.messages.length - 1].content;
  assert.ok(buildUserText.includes(CHARACTER_REFERENCE));
  assert.ok(buildUserText.includes('Character reference sheets'));
  assert.ok(buildUserText.includes('Action references'));
  assert.ok(buildUserText.includes('Location references'));

  // Saving is rejected for a project that is not in the Generation Stage.
  const ideaProject = await prepareProject(request, cookie, { title: 'Not ready', stage: 'Idea Stage' });
  result = await request(`/api/generation/${ideaProject.id}/prompts`, {
    method: 'PUT',
    cookie,
    body: { prompts: [{ id: 'x1', prompt: 'An image.' }] },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'WRONG_STAGE');

  // Step 2: save the draft, then approve every prompt individually.
  result = await request(`/api/generation/${project.id}/prompts`, {
    method: 'PUT',
    cookie,
    body: {
      prompts: [
        { id: 'draft-1', index: 0, action: 'First action', locationSentence: 'The wheat field at dusk.', characters: ['Ava'], prompt: 'Photorealistic image one with Ava.' },
        { id: 'draft-2', index: 1, action: 'Second action', locationSentence: 'The wheat field at night.', characters: ['Ava'], prompt: 'Photorealistic image two with Ava.' },
      ],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  let task = result.data.task;
  assert.ok(task.savedAt);
  assert.equal(task.state.prompts, true);
  assert.equal(task.state.approvals, false);
  assert.equal(task.state.promptCount, 2);
  assert.equal(task.prompts[0].sceneId, result.data.project.scenes[0].id);
  assert.equal(task.prompts[1].sceneId, result.data.project.scenes[1].id);

  // Review and image generation are both gated on the earlier steps.
  result = await request('/api/generation/review', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'APPROVALS_REQUIRED');

  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'draft-1', size: '2K' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'REVIEW_REQUIRED');

  result = await request(`/api/generation/${project.id}/prompts/draft-1/approval`, {
    method: 'POST',
    cookie,
    body: { approved: true },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.task.state.approvedCount, 1);
  assert.equal(result.data.task.state.approvals, false);

  result = await request(`/api/generation/${project.id}/prompts/draft-2/approval`, {
    method: 'POST',
    cookie,
    body: { approved: true },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.task.state.approvals, true);

  // Step 3: the reviewer compares every prompt with the references.
  const reviewCallIndex = mock.calls.chat.length;
  result = await request('/api/generation/review', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  task = result.data.task;
  assert.ok(task.reviewedAt);
  assert.equal(task.reviewedBy, 'deepseek-v4-pro');
  assert.equal(result.data.review.flagCount, 2);
  assert.equal(task.state.openFlagCount, 2);
  assert.equal(task.state.review, false);
  assert.equal(task.prompts[0].flags.length, 1);
  assert.equal(task.prompts[0].flags[0].status, 'open');
  assert.equal(task.prompts[0].flags[0].severity, 'error');
  const reviewUserText = mock.calls.chat[reviewCallIndex].messages.slice(-1)[0].content;
  assert.ok(reviewUserText.includes('Image prompts to review'));
  assert.ok(reviewUserText.includes('Photorealistic image one with Ava.'));

  // An open flag keeps the project unreviewed, so images stay blocked.
  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'draft-1', size: '2K' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'REVIEW_REQUIRED');

  // Dismiss one flag; it stays as history and the other one stays open.
  const dismissedFlagId = task.prompts[1].flags[0].id;
  result = await request(`/api/generation/${project.id}/prompts/draft-2/flags/${dismissedFlagId}`, {
    method: 'POST',
    cookie,
    body: { status: 'dismissed' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.task.state.openFlagCount, 1);
  assert.equal(result.data.task.prompts[1].flags[0].status, 'dismissed');
  assert.ok(result.data.task.prompts[1].flags[0].resolvedAt);

  // A flag can only be dismissed, never closed by hand.
  result = await request(`/api/generation/${project.id}/prompts/draft-2/flags/${dismissedFlagId}`, {
    method: 'POST',
    cookie,
    body: { status: 'open' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'INVALID_FLAG_ACTION');

  // Editing the prompt answers its flag, but the human approval is cleared.
  result = await request(`/api/generation/${project.id}/prompts/draft-1`, {
    method: 'PUT',
    cookie,
    body: { prompt: 'Photorealistic image one with Ava: auburn hair, denim overalls, lantern raised.' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  task = result.data.task;
  assert.equal(task.prompts[0].prompt, 'Photorealistic image one with Ava: auburn hair, denim overalls, lantern raised.');
  assert.equal(task.prompts[0].approved, false);
  assert.equal(task.prompts[0].flags[0].status, 'edited');
  assert.equal(task.state.openFlagCount, 0);
  assert.equal(task.state.approvals, false);
  assert.equal(task.state.review, false);

  // Re-approving completes the review step.
  result = await request(`/api/generation/${project.id}/prompts/draft-1/approval`, {
    method: 'POST',
    cookie,
    body: { approved: true },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.task.state.approvals, true);
  assert.equal(result.data.task.state.review, true);

  // Step 4: render one image at a time with the reference sheet attached.
  const imageCallIndex = mock.calls.images.length;
  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'draft-1', size: '2K' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  task = result.data.task;
  assert.equal(task.state.imageCount, 1);
  assert.equal(task.state.images, false);
  assert.equal(task.prompts[0].image.prompt, task.prompts[0].prompt);
  assert.equal(task.prompts[0].image.model, 'dola-seedream-5-0-pro-260628');
  assert.match(task.prompts[0].image.file, /^[0-9a-f-]+\.png$/);
  assert.equal(result.data.project.sceneImages.length, 1);
  const imageBody = mock.calls.images[imageCallIndex];
  assert.equal(imageBody.model, 'dola-seedream-5-0-pro-260628');
  assert.equal(imageBody.size, '2K');
  assert.equal(imageBody.response_format, 'b64_json');
  assert.equal(imageBody.image.length, 1);
  assert.match(imageBody.image[0], /^data:image\/png;base64,/);
  assert.ok(imageBody.prompt.includes('lantern raised'));

  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'draft-2', size: '2K' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  task = result.data.task;
  assert.equal(task.state.imageCount, 2);
  assert.equal(task.state.images, true);
  assert.equal(task.state.done, true);

  // Every finished image is filed into the Library with project provenance.
  result = await request('/api/library', { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const libraryIds = result.data.images.map((image) => image.id);
  for (const prompt of task.prompts) {
    const id = `${project.id}/${prompt.image.file}`;
    assert.ok(libraryIds.includes(id), `missing ${id}`);
    assert.equal(prompt.image.prompt, prompt.prompt);
  }
  const generated = result.data.images.find((image) => image.id === `${project.id}/${task.prompts[1].image.file}`);
  assert.equal(generated.metadata.projectId, project.id);
  assert.equal(generated.metadata.source, 'generated');
  assert.equal(generated.metadata.model, 'dola-seedream-5-0-pro-260628');
  assert.ok(generated.metadata.prompt.includes('Ava'));
  assert.equal(generated.metadata.sceneId, task.prompts[1].sceneId);

  // A failed build never disturbs the saved, approved prompts or their images.
  mock.setBuildAnswer({ prompts: ['Only one prompt for two action references.'] });
  result = await request('/api/generation/build', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'PROMPT_COUNT_MISMATCH');
  mock.setBuildAnswer(null);
  result = await request(`/api/generation/${project.id}`, { cookie });
  assert.equal(result.data.task.prompts.length, 2);
  assert.equal(result.data.task.state.approvals, true);
  assert.equal(result.data.task.state.images, true);
  assert.equal(result.data.task.prompts[0].image.file, task.prompts[0].image.file);

  // Editing a prompt again makes its existing image stale, never silently current.
  result = await request(`/api/generation/${project.id}/prompts/draft-1`, {
    method: 'PUT',
    cookie,
    body: { prompt: 'A completely different photorealistic frame.' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  task = result.data.task;
  assert.equal(task.state.imageCount, 2);
  assert.equal(task.state.staleImageCount, 1);
  assert.equal(task.state.images, false);
  assert.equal(task.state.done, false);

  // User isolation: another account cannot read or drive this project.
  const otherCookie = await register(request, 'generation-other');
  result = await request('/api/me/byteplus-key', { method: 'PUT', cookie: otherCookie, body: { apiKey: 'bp-test-other-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request(`/api/generation/${project.id}`, { cookie: otherCookie });
  assert.equal(result.status, 404);
  result = await request(`/api/generation/${project.id}/prompts`, {
    method: 'PUT',
    cookie: otherCookie,
    body: { prompts: [{ id: 'y1', prompt: 'Someone else.' }] },
  });
  assert.equal(result.status, 404);
  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie: otherCookie,
    body: { projectId: project.id, promptId: 'draft-1', size: '2K' },
  });
  assert.equal(result.status, 404);

  // Cross-origin writes are refused.
  result = await request('/api/generation/build', {
    method: 'POST',
    cookie,
    origin: 'https://evil.example',
    body: { projectId: project.id },
  });
  assert.equal(result.status, 403);
});

test('Generation Stage requires a final reference sheet per character before images', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-stage-gate-'));
  const mock = createProviderMock({ actionCharacters: ['Ben'], flags: [] });
  await mock.listen();
  const mockPort = mock.server.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(workDir, {
    PORT: String(port),
    DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
    BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mockPort}/images/generations`,
  });

  t.after(async () => {
    await stopServer(child);
    await new Promise((resolve) => mock.server.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  await waitForHealth(base);
  const request = makeRequest(base);
  const cookie = await register(request, 'generation-gate');

  let result = await request('/api/me/api-key', { method: 'PUT', cookie, body: { apiKey: 'sk-test-deepseek-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request('/api/me/byteplus-key', { method: 'PUT', cookie, body: { apiKey: 'bp-test-byteplus-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const project = await prepareProject(request, cookie, {
    title: 'Night Watch',
    stage: 'Generation Stage',
    referenceMaterial: 'A watchman walks a rain-soaked alley.',
    characterReferences: [{ name: 'Ben', gender: 'Male', referenceMaterial: BEN_REFERENCE }],
  });

  result = await request(`/api/story/${project.id}/characters`, {
    method: 'POST',
    cookie,
    body: { name: 'Ben', gender: 'Male', appearance: 'Tall with a short beard.', wardrobe: 'Grey wool coat.', approved: true },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));

  // Action and location references can be saved directly; only prompt building
  // needs the text provider.
  result = await request(`/api/story/${project.id}/worksheet/actions/save`, {
    method: 'POST',
    cookie,
    body: {
      actions: [{
        action: 'Ben walks a rain-soaked alley and checks a locked door.',
        locationSentence: 'A wet alley behind a shuttered market at night.',
        characters: ['Ben'],
      }],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request(`/api/story/${project.id}/worksheet/locations/save`, {
    method: 'POST',
    cookie,
    body: {
      locations: [{
        name: 'Wet alley',
        description: 'A narrow alley of wet cobbles behind a shuttered market.',
      }],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  // The missing character reference sheet is a build-clear, images-blocked state.
  result = await request(`/api/generation/${project.id}`, { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.references.ready.build, true);
  assert.equal(result.data.references.ready.images, false);
  assert.equal(result.data.references.characters[0].sheet, null);
  const sheetBlocker = result.data.references.blockers.find((blocker) => blocker.code === 'characterSheet:ben');
  assert.ok(sheetBlocker);
  assert.equal(sheetBlocker.step, 'images');

  result = await request('/api/generation/build', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.prompts.length, 1);

  result = await request(`/api/generation/${project.id}/prompts`, {
    method: 'PUT',
    cookie,
    body: { prompts: [{ id: 'ben-1', index: 0, action: 'Ben checks the door.', characters: ['Ben'], prompt: 'Photorealistic Ben in the wet alley.' }] },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request(`/api/generation/${project.id}/prompts/ben-1/approval`, {
    method: 'POST',
    cookie,
    body: { approved: true },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request('/api/generation/review', { method: 'POST', cookie, body: { projectId: project.id } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.review.flagCount, 0);
  assert.equal(result.data.task.state.review, true);

  // The image run refuses to invent a reference: without a final sheet it stops.
  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'ben-1', size: '2K' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'REFERENCE_IMAGES_REQUIRED');
  assert.equal(mock.calls.images.length, 0);

  // Re-saving the identical prompts keeps the approval and the review.
  result = await request(`/api/generation/${project.id}/prompts`, {
    method: 'PUT',
    cookie,
    body: { prompts: [{ id: 'ben-1', index: 0, action: 'Ben checks the door.', characters: ['Ben'], prompt: 'Photorealistic Ben in the wet alley.' }] },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.task.prompts[0].approved, true);
  assert.equal(result.data.task.state.prompts, true);
  assert.equal(result.data.task.state.approvals, true);

  // A prompt that does not exist cannot be approved or rendered.
  result = await request(`/api/generation/${project.id}/prompts/missing/approval`, {
    method: 'POST',
    cookie,
    body: { approved: true },
  });
  assert.equal(result.status, 404);
  result = await request('/api/generation/images/one', {
    method: 'POST',
    cookie,
    body: { projectId: project.id, promptId: 'missing', size: '2K' },
  });
  assert.equal(result.status, 404);

  // An empty prompt body is refused.
  result = await request(`/api/generation/${project.id}/prompts/ben-1`, { method: 'PUT', cookie, body: { prompt: '   ' } });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'EMPTY_PROMPT');
});