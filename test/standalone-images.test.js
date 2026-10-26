'use strict';

// Standalone image generator end-to-end contract:
//
//   1. Images belong to no project, but every generated image is registered in
//      the Library as a project-less asset so it can be reviewed.
//   2. Reference images (Library assets, Character maker versions, uploads) are
//      attached as data URLs, and ownership is re-checked server-side.
//   3. Prompt presets are per user.
//   4. Deleting a generation never destroys review work or a project's asset.
//
// Only a local mock image provider and a temporary data directory are used.

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

function createImageMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = null; }
      calls.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), output_format: 'png', size: '2K' }] }));
    });
  });
  return {
    calls,
    server,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  };
}

function startServer(workDir, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: workDir,
      APP_SECRET: 'standalone-image-secret-long-enough-1234',
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
  return async function request(pathname, { method = 'GET', body, cookie, raw, contentType } = {}) {
    const headers = {};
    if (raw !== undefined) headers['content-type'] = contentType || 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
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

async function rawBytes(base, pathname, cookie) {
  const response = await fetch(base + pathname, { headers: { cookie } });
  return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
}

test('Standalone image generator saves images, registers them in the Library, and stays private', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-images-'));
  const mock = createImageMock();
  await mock.listen();
  const mockPort = mock.server.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(workDir, {
    PORT: String(port),
    BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mockPort}/images/generations`,
  });

  t.after(async () => {
    await stopServer(child);
    await new Promise((resolve) => mock.server.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  await waitForHealth(base);
  const request = makeRequest(base);
  const cookie = await register(request, 'image-owner');

  // 1. The key gate comes before any provider call.
  let result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'A lighthouse at dusk.' } });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'NO_IMAGEGEN_KEY');
  assert.equal(mock.calls.length, 0);

  result = await request('/api/me/byteplus-key', {
    method: 'PUT',
    cookie,
    body: { apiKey: 'bp-test-byteplus-1234567890' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  // 2. Input validation.
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: '   ' } });
  assert.equal(result.status, 400, JSON.stringify(result.data));
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: { prompt: 'ok', size: '99K' },
  });
  assert.equal(result.status, 400, JSON.stringify(result.data));
  assert.equal(mock.calls.length, 0, 'invalid input must not reach the provider');

  // 3. Generate one image.
  const prompt = 'A weathered lighthouse on a basalt cliff at dusk, cold blue light, 35mm film grain.';
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt, size: '2K' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const first = result.data.generation;
  assert.equal(result.data.libraryWarning, '');
  assert.equal(first.prompt, prompt);
  assert.equal(first.imageSize, '2K');
  assert.ok(first.assetId, 'the image must be registered in the Library');
  assert.match(first.url, /^\/api\/generations\/[0-9a-f-]{36}\/image\//);
  assert.deepEqual(first.references, []);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].prompt, prompt);
  assert.equal(mock.calls[0].size, '2K');
  assert.equal(mock.calls[0].image, undefined, 'no reference images were attached');

  const bytes = await rawBytes(base, first.url, cookie);
  assert.equal(bytes.status, 200);
  assert.ok(bytes.buffer.equals(PNG));

  // 4. It appears in the Library as a project-less (unassigned) asset.
  result = await request('/api/library', { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 200));
  const libraryEntry = result.data.images.find((image) => image.assetId === first.assetId || image.id === first.assetId);
  assert.ok(libraryEntry, 'the generated image must be listed in the Library');
  assert.match(libraryEntry.relativePath, /^generations\/[0-9a-f-]{36}\//);
  assert.equal(libraryEntry.metadata, null, 'a standalone image has no project metadata');

  const unassigned = await request('/api/assets?unassigned=1', { cookie });
  assert.equal(unassigned.status, 200);
  assert.ok(
    unassigned.data.assets.some((asset) => asset.id === first.assetId),
    'the asset must show up under the unassigned filter'
  );

  // 5. Presets are per user and survive edits.
  result = await request('/api/generation-presets', {
    method: 'POST',
    cookie,
    body: { name: 'Cinematic dusk', text: 'golden hour, 35mm, shallow depth of field' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const preset = result.data.preset;
  assert.equal(preset.name, 'Cinematic dusk');

  result = await request('/api/generation-presets', { cookie });
  assert.deepEqual(result.data.presets.map((item) => item.id), [preset.id]);

  result = await request(`/api/generation-presets/${preset.id}`, {
    method: 'PUT',
    cookie,
    body: { name: 'Cinematic dawn', text: 'blue hour, 35mm' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.preset.name, 'Cinematic dawn');
  assert.equal(result.data.preset.text, 'blue hour, 35mm');

  // 6. Uploaded reference images are stored and served to their owner only.
  result = await request('/api/generation-references?name=Mood%20board', {
    method: 'POST',
    cookie,
    raw: PNG,
    contentType: 'image/png',
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const uploaded = result.data.reference;
  assert.equal(uploaded.name, 'Mood board');
  assert.equal(uploaded.mime, 'image/png');
  assert.match(uploaded.url, /^\/api\/generation-references\/[0-9a-f-]{36}\/image$/);
  const uploadedBytes = await rawBytes(base, uploaded.url, cookie);
  assert.equal(uploadedBytes.status, 200);
  assert.ok(uploadedBytes.buffer.equals(PNG));

  // 7. A generation with references sends them as data URLs.
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: {
      prompt: 'Match this mood.',
      size: '1K',
      references: [{ kind: 'upload', id: uploaded.id }],
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].image.length, 1);
  assert.match(mock.calls[1].image[0], /^data:image\/png;base64,/);
  assert.equal(result.data.generation.references.length, 1);
  assert.equal(result.data.generation.references[0].kind, 'upload');

  // A Library image can be reused as a reference through its own asset path.
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: {
      prompt: 'Same place, different weather.',
      references: [{ kind: 'library', path: libraryEntry.relativePath }],
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(mock.calls[2].image.length, 1);
  assert.match(mock.calls[2].image[0], /^data:image\/png;base64,/);

  // A Character maker final can be reused too.
  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Ava', description: 'Auburn hair, denim overalls.' },
  });
  const character = result.data.character;
  result = await request(`/api/characters/${character.id}/generate`, {
    method: 'POST',
    cookie,
    body: { mode: 'portrait' },
  });
  const characterVersion = result.data.version;
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: {
      prompt: 'Ava in the lighthouse.',
      references: [{ kind: 'character', characterId: character.id, file: characterVersion.file }],
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(mock.calls[mock.calls.length - 1].image.length, 1);
  assert.equal(result.data.generation.references[0].kind, 'character');

  // 8. Unknown or foreign references are refused before any provider call.
  const callsBefore = mock.calls.length;
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: { prompt: 'x', references: [{ kind: 'upload', id: 'nope' }] },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request('/api/generations', {
    method: 'POST',
    cookie,
    body: { prompt: 'x', references: [{ kind: 'library', path: '../../etc/passwd' }] },
  });
  assert.ok(result.status === 400 || result.status === 404, JSON.stringify(result.data));
  assert.equal(mock.calls.length, callsBefore, 'a bad reference must not reach the provider');

  // 9. Deleting removes the record, the file, and its Library asset.
  result = await request(`/api/generations/${first.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.removed, first.id);
  const removedBytes = await rawBytes(base, first.url, cookie);
  assert.equal(removedBytes.status, 404, 'the image file must be gone');
  result = await request('/api/library', { cookie });
  assert.ok(
    !result.data.images.some((image) => image.assetId === first.assetId || image.id === first.assetId),
    'the Library asset must be gone'
  );
  const imageDir = path.join(workDir, 'images', 'generations', first.id);
  assert.equal(fs.existsSync(imageDir), false, 'the image directory must be removed');

  // 10. Reviewed images are protected from deletion here.
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Reviewed image.' } });
  const reviewed = result.data.generation;
  result = await request(`/api/assets/${reviewed.assetId}/reviews`, {
    method: 'POST',
    cookie,
    body: { decision: 'REVISE', notes: 'Needs another pass.' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  result = await request(`/api/generations/${reviewed.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'REVIEWED_ASSET');
  result = await request('/api/library', { cookie });
  assert.ok(
    result.data.images.some((image) => image.assetId === reviewed.assetId || image.id === reviewed.assetId),
    'a reviewed asset must survive a gallery delete'
  );

  // 11. Images already filed into a project are protected as well.
  result = await request('/api/projects', { method: 'POST', cookie, body: { title: 'Harvest Moon' } });
  const project = result.data.project;
  result = await request(`/api/assets/${reviewed.assetId}`, {
    method: 'PUT',
    cookie,
    body: { projectId: project.id },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request(`/api/generations/${reviewed.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'ASSET_IN_PROJECT');

  // 12. Another user sees nothing and can touch nothing.
  const stranger = await register(request, 'image-stranger');
  result = await request('/api/generations', { cookie: stranger });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.generations, []);
  assert.deepEqual(result.data.presets, []);
  assert.deepEqual(result.data.references, []);

  result = await request(`/api/generations/${reviewed.id}`, { method: 'DELETE', cookie: stranger });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  const strangerBytes = await rawBytes(base, reviewed.url, stranger);
  assert.equal(strangerBytes.status, 404);
  const strangerReference = await rawBytes(base, uploaded.url, stranger);
  assert.equal(strangerReference.status, 404);
  result = await request(`/api/generation-presets/${preset.id}`, {
    method: 'PUT',
    cookie: stranger,
    body: { name: 'Stolen' },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/generation-references/${uploaded.id}`, { method: 'DELETE', cookie: stranger });
  assert.equal(result.status, 404, JSON.stringify(result.data));

  // 13. The owner can still delete a preset and a reference explicitly.
  result = await request(`/api/generation-presets/${preset.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.presets, []);
  result = await request(`/api/generation-references/${uploaded.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.references, []);
});

test('Standalone image generator screen is reachable in the Generate Images module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

  // The flat tab bar is replaced by module navigation, so the screen is reached
  // through the Generate Images module (and the Generate button) rather than a tab button.
  assert.match(app, /id: 'standalone-images', label: 'Standalone Images', icon: '[^']*', tab: 'standalone-images'/);
  assert.match(html, /id="panel-standalone-images" role="tabpanel"/);
  assert.match(html, /id="generator-prompt"/);
  assert.match(html, /id="generator-size"/);
  assert.match(html, /id="generator-count"/);
  assert.match(html, /id="generator-generate"/);
  assert.match(html, /id="generator-hint"/);
  assert.match(html, /id="generator-preset"[\s\S]*id="generator-preset-insert"[\s\S]*id="generator-preset-save"[\s\S]*id="generator-preset-delete"/);
  assert.match(html, /id="generator-reference-library"[\s\S]*id="generator-reference-add-library"/);
  assert.match(html, /id="generator-reference-character"[\s\S]*id="generator-reference-add-character"/);
  assert.match(html, /id="generator-reference-file"[\s\S]*id="generator-reference-upload"/);
  assert.match(html, /id="generator-reference-chips"/);
  assert.match(html, /id="generator-gallery"/);
  assert.match(html, /id="generator-retry"/);
  assert.match(html, /id="docs-generator"/);

  assert.match(app, /'standalone-images': 'panel-standalone-images'/);
  assert.match(app, /if \(name === 'standalone-images'\) loadGenerator\(\)/);
  assert.match(app, /async function loadGenerator/);
  assert.match(app, /async function generateImages/);
  assert.match(app, /function generatorReferencePayload/);
  assert.match(app, /async function uploadGeneratorReference/);
  assert.match(app, /async function openGenerationInLibrary/);
  assert.match(app, /async function deleteGeneration/);
  assert.match(app, /function resetGenerator/);
  assert.match(app, /resetGenerator\(\);[\s\S]*state\.reference\.projectId = null/);
  assert.match(app, /#generator-generate'\)\.addEventListener\('click', generateImages\)/);
  assert.match(app, /generator: \{/);
  // The gallery must reuse the process tracker for multi-image batches.
  assert.match(app, /startProcess\(count > 1 \? `Generating image 1 of \$\{count\}` : 'Generating image'\)/);
  assert.match(app, /updateProcess\(processId, `Generating image \$\{index \+ 1\} of \$\{count\}`\)/);

  assert.match(css, /\.generator-card/);
  assert.match(css, /\.generator-chip/);
});

test('Standalone image generator requires a signed-in user', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-images-auth-'));
  const mock = createImageMock();
  await mock.listen();
  const mockPort = mock.server.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(workDir, {
    PORT: String(port),
    BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mockPort}/images/generations`,
  });

  t.after(async () => {
    await stopServer(child);
    await new Promise((resolve) => mock.server.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  await waitForHealth(base);
  const request = makeRequest(base);

  const attempts = [
    ['GET', '/api/generations'],
    ['POST', '/api/generations'],
    ['DELETE', '/api/generations/00000000-0000-0000-0000-000000000000'],
    ['GET', '/api/generations/00000000-0000-0000-0000-000000000000/image/x.png'],
    ['GET', '/api/generation-presets'],
    ['POST', '/api/generation-presets'],
    ['PUT', '/api/generation-presets/abc'],
    ['DELETE', '/api/generation-presets/abc'],
    ['POST', '/api/generation-references'],
    ['GET', '/api/generation-references/abc/image'],
    ['DELETE', '/api/generation-references/abc'],
  ];
  for (const [method, pathname] of attempts) {
    const result = await request(pathname, { method, body: method === 'POST' || method === 'PUT' ? { prompt: 'x' } : undefined });
    assert.equal(result.status, 401, `${method} ${pathname} → ${result.status}`);
  }
  assert.equal(mock.calls.length, 0);
});