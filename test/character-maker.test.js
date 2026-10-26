'use strict';

// Character maker end-to-end contract:
//
//   1. Characters are standalone: they belong to one user and to no project.
//   2. A generation appends a version and can produce either a single portrait
//      or the three-view character sheet.
//   3. Exactly one version can be final at a time.
//   4. Every read and write is scoped to the signed-in user.
//
// The test drives only a local mock image provider and a temporary data
// directory.

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

// Records every image request so the test can prove what was attached.
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
      APP_SECRET: 'character-maker-secret-long-enough-123456',
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
  return async function request(pathname, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
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

test('Character maker builds standalone characters with portraits and sheets', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-maker-'));
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
  const cookie = await register(request, 'character-owner');

  // 1. Nothing exists for a new account.
  let result = await request('/api/characters', { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.characters, []);

  // 2. A character needs a name.
  result = await request('/api/characters', { method: 'POST', cookie, body: { description: 'No name.' } });
  assert.equal(result.status, 400, JSON.stringify(result.data));

  // 3. Create, then describe.
  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Ava Reyes', description: '42, 5ft 7, shoulder-length auburn hair, freckles, faded denim overalls.' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const ava = result.data.character;
  assert.equal(ava.name, 'Ava Reyes');
  assert.equal(ava.versionCount, 0);
  assert.equal(ava.finalVersionId, '');
  assert.deepEqual(ava.versions, []);

  // 4. Generation needs a saved BytePlus key.
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie, body: { mode: 'portrait' } });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'NO_IMAGEGEN_KEY');

  result = await request('/api/me/byteplus-key', { method: 'PUT', cookie, body: { apiKey: 'bp-test-byteplus-1234567890' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  // 5. Invalid mode and a missing description are rejected.
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie, body: { mode: 'poster' } });
  assert.equal(result.status, 400, JSON.stringify(result.data));

  result = await request('/api/characters', { method: 'POST', cookie, body: { name: 'Ben' } });
  const ben = result.data.character;
  result = await request(`/api/characters/${ben.id}/generate`, { method: 'POST', cookie, body: { mode: 'portrait' } });
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'CHARACTER_DESCRIPTION_REQUIRED');

  // 6. A portrait attaches no layout reference.
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie, body: { mode: 'portrait' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const portrait = result.data.version;
  assert.equal(portrait.version, 1);
  assert.equal(portrait.mode, 'portrait');
  assert.equal(portrait.status, 'draft');
  assert.match(portrait.prompt, /single-subject character reference portrait of Ava Reyes/);
  assert.match(portrait.url, new RegExp(`^/api/characters/${ava.id}/image/[A-Za-z0-9-]+\\.png$`));
  assert.equal(portrait.imageSize, '2K');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].image, undefined);
  assert.equal(mock.calls[0].watermark, false);
  assert.equal(mock.calls[0].response_format, 'b64_json');

  // 7. A sheet attaches the three-view layout reference and keeps its template.
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie, body: { mode: 'sheet' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const sheet = result.data.version;
  assert.equal(sheet.version, 2);
  assert.equal(sheet.mode, 'sheet');
  assert.match(sheet.prompt, /three evenly spaced, equal-size, full-body standing poses/);
  assert.equal(mock.calls.length, 2);
  assert.ok(Array.isArray(mock.calls[1].image), 'the sheet must attach the layout reference');
  assert.equal(mock.calls[1].image.length, 1);
  assert.match(mock.calls[1].image[0], /^data:image\/png;base64,/);

  // 8. The stored image round-trips through an authenticated route.
  // Read the bytes raw: the route answers with image/png, not JSON.
  const imageResponse = await fetch(base + sheet.url, { headers: { cookie } });
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type') || '', /^image\/png/);
  assert.ok(Buffer.from(await imageResponse.arrayBuffer()).equals(PNG));

  // 9. The character now reports both versions, newest first.
  result = await request('/api/characters', { cookie });
  const listed = result.data.characters.find((item) => item.id === ava.id);
  assert.equal(listed.versionCount, 2);
  assert.deepEqual(listed.versions.map((item) => item.version), [2, 1]);

  // 10. Promoting is exclusive: only one final version at a time.
  result = await request(`/api/characters/${ava.id}/versions/${portrait.id}/promote`, { method: 'POST', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.character.finalVersionId, portrait.id);
  assert.equal(result.data.character.versions.filter((item) => item.status === 'final').length, 1);

  result = await request(`/api/characters/${ava.id}/versions/${sheet.id}/promote`, { method: 'POST', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const promoted = result.data.character;
  assert.equal(promoted.finalVersionId, sheet.id);
  assert.equal(promoted.versions.filter((item) => item.status === 'final').length, 1);
  assert.equal(promoted.versions.find((item) => item.id === portrait.id).status, 'draft');

  result = await request(`/api/characters/${ava.id}/versions/not-a-version/promote`, { method: 'POST', cookie });
  assert.equal(result.status, 404, JSON.stringify(result.data));

  // 11. Renaming and re-describing persists.
  result = await request(`/api/characters/${ava.id}`, {
    method: 'PUT',
    cookie,
    body: { name: 'Ava R.', description: 'Auburn hair in a low bun; grey wool peacoat.' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.character.name, 'Ava R.');
  assert.match(result.data.character.description, /grey wool peacoat/);
  assert.equal(result.data.character.versionCount, 2, 'editing must not drop versions');

  // 12. Another user sees nothing and cannot touch this character.
  const other = await register(request, 'character-stranger');
  result = await request('/api/characters', { cookie: other });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.characters, []);

  result = await request(`/api/characters/${ava.id}`, { method: 'PUT', cookie: other, body: { name: 'Stolen' } });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie: other, body: { mode: 'portrait' } });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  const strangerImage = await fetch(base + sheet.url, { headers: { cookie: other } });
  assert.equal(strangerImage.status, 404);
  result = await request(`/api/characters/${ava.id}/versions/${sheet.id}/promote`, { method: 'POST', cookie: other });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/characters/${ava.id}`, { method: 'DELETE', cookie: other });
  assert.equal(result.status, 404, JSON.stringify(result.data));

  // 13. Deleting removes the character, its versions, and its image directory.
  const imageDirectory = path.join(workDir, 'images', 'characters', ava.id);
  assert.ok(fs.existsSync(imageDirectory), 'generated images should exist before deletion');
  result = await request(`/api/characters/${ava.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.removed, ava.id);
  assert.deepEqual(result.data.characters.map((item) => item.id), [ben.id]);
  assert.ok(!fs.existsSync(imageDirectory), 'the image directory should be removed');

  // 14. Deleting again is a 404, and the surviving character is untouched.
  result = await request(`/api/characters/${ava.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/characters/${ben.id}`, { cookie });
  assert.equal(result.status, 405, 'there is no single-character GET route');
});

test('Character maker screen is reachable in the Generate Images module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

  // The flat tab bar is replaced by module navigation, so the screen is reached
  // through the Generate Images module rather than a tab button.
  assert.match(app, /id: 'character-maker', label: 'Character Maker', icon: '[^']*', tab: 'characters'/);
  assert.match(html, /id="panel-characters" role="tabpanel"/);
  assert.match(html, /id="character-list"/);
  assert.match(html, /id="character-new"/);
  assert.match(html, /id="character-name"/);
  assert.match(html, /id="character-description"/);
  assert.match(html, /id="character-mode"[\s\S]*value="portrait"[\s\S]*value="sheet"/);
  assert.match(html, /id="character-size"/);
  assert.match(html, /id="character-generate"/);
  assert.match(html, /id="character-versions"/);
  assert.match(html, /id="characters-retry"/);
  assert.match(html, /id="docs-characters"/);

  assert.match(app, /characters: 'panel-characters'/);
  assert.match(app, /if \(name === 'characters'\) loadCharacters\(\)/);
  assert.match(app, /async function loadCharacters/);
  assert.match(app, /async function generateCharacterImage/);
  assert.match(app, /startProcess\(mode === 'sheet' \? 'Generating character sheet' : 'Generating character portrait'\)/);
  assert.match(app, /function resetCharacters/);
  assert.match(app, /#character-generate'\)\.addEventListener\('click', generateCharacterImage\)/);
  assert.match(app, /resetCharacters\(\);[\s\S]*authMode = 'login'/);
  assert.match(app, /resetCharacters\(\);[\s\S]*state\.reference\.projectId = null/);

  assert.match(css, /\.maker-layout/);
  assert.match(css, /\.maker-character\.active/);

  // Story Studio no longer exposes the legacy project-character view.
  assert.doesNotMatch(app, /id: 'studio-cast-images'/);
  assert.match(html, /id="panel-project-characters" role="tabpanel"/);
  assert.match(html, /id="project-characters-project"/);
  assert.match(html, /id="project-character-list"/);
  assert.match(html, /id="project-character-new"/);
  assert.match(html, /id="project-character-name"/);
  assert.match(html, /id="project-character-description"/);
  assert.match(html, /id="project-character-mode"[\s\S]*value="portrait"[\s\S]*value="sheet"/);
  assert.match(html, /id="project-character-size"/);
  assert.match(html, /id="project-character-generate"/);
  assert.match(html, /id="project-character-reuse"/);
  assert.match(html, /id="project-character-import"/);
  assert.match(html, /id="project-character-versions"/);
  assert.match(html, /id="project-characters-retry"/);
  assert.doesNotMatch(html, /Story Studio ▸ Characters &amp; Locations ▸ Character images/);

  assert.match(app, /'project-characters': 'panel-project-characters'/);
  assert.match(app, /if \(name === 'project-characters'\) loadProjectCharacters\(\)/);
  assert.match(app, /async function loadProjectCharacters/);
  assert.match(app, /projectCharacters: \{/);
  assert.match(app, /\/api\/characters\?projectId=\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(app, /versions\/import/);
  assert.match(app, /function characterVersionCard/);
  assert.match(app, /resetProjectCharacters\(\);/);
});

test('Project characters stay scoped to their project and can reuse a maker image', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-characters-'));
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
  const cookie = await register(request, 'project-character-owner');
  let result = await request('/api/me/byteplus-key', {
    method: 'PUT',
    cookie,
    body: { apiKey: 'bp-test-byteplus-1234567890' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  result = await request('/api/projects', { method: 'POST', cookie, body: { title: 'Harvest Moon' } });
  const projectA = result.data.project;
  result = await request('/api/projects', { method: 'POST', cookie, body: { title: 'Winter Light' } });
  const projectB = result.data.project;

  // 1. A project character needs a project this user owns.
  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Orphan', description: 'x', projectId: 'does-not-exist' },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));

  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Ava', description: 'Auburn hair, denim overalls, silver pendant.', projectId: projectA.id },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const ava = result.data.character;
  assert.equal(ava.projectId, projectA.id);

  // 2. The two scopes never see each other.
  result = await request(`/api/characters?projectId=${projectA.id}`, { cookie });
  assert.deepEqual(result.data.characters.map((item) => item.name), ['Ava']);
  result = await request(`/api/characters?projectId=${projectB.id}`, { cookie });
  assert.deepEqual(result.data.characters, []);
  result = await request('/api/characters', { cookie });
  assert.deepEqual(result.data.characters, [], 'the Character maker tab must not list project characters');

  // 3. A standalone maker character with a final portrait.
  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Ava (maker)', description: 'Auburn hair, denim overalls, silver pendant.' },
  });
  const maker = result.data.character;
  assert.equal(maker.projectId, '');
  result = await request(`/api/characters/${maker.id}/generate`, { method: 'POST', cookie, body: { mode: 'portrait' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const makerPortrait = result.data.version;
  result = await request(`/api/characters/${maker.id}/versions/${makerPortrait.id}/promote`, { method: 'POST', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));

  // 4. Generating for the project character keeps it in that project's scope.
  result = await request(`/api/characters/${ava.id}/generate`, { method: 'POST', cookie, body: { mode: 'sheet' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.version.mode, 'sheet');
  assert.equal(result.data.character.projectId, projectA.id);

  // 5. Copy the maker's final image into the project character.
  result = await request(`/api/characters/${ava.id}/versions/import`, {
    method: 'POST',
    cookie,
    body: { fromVersionId: makerPortrait.id },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const imported = result.data.character;
  assert.equal(imported.versionCount, 2);
  const copied = imported.versions.find((version) => version.version === 2);
  assert.ok(copied, 'the import must append a version');
  assert.equal(copied.status, 'final');
  assert.equal(copied.mode, 'portrait');
  assert.equal(imported.finalVersionId, copied.id);
  assert.notEqual(copied.url, makerPortrait.url, 'the copy must be its own file');

  const copiedImage = await fetch(base + copied.url, { headers: { cookie } });
  assert.equal(copiedImage.status, 200);
  assert.ok(Buffer.from(await copiedImage.arrayBuffer()).equals(PNG));

  // The source character is untouched: still one version, still final.
  result = await request('/api/characters', { cookie });
  const makerAfter = result.data.characters.find((item) => item.id === maker.id);
  assert.equal(makerAfter.versionCount, 1);
  assert.equal(makerAfter.finalVersionId, makerPortrait.id);

  // 6. Importing a missing or foreign version is refused.
  result = await request(`/api/characters/${ava.id}/versions/import`, {
    method: 'POST',
    cookie,
    body: { fromVersionId: 'not-a-version' },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/characters/${ava.id}/versions/import`, { method: 'POST', cookie, body: {} });
  assert.equal(result.status, 400, JSON.stringify(result.data));

  // 7. Another user cannot see or use either project.
  const other = await register(request, 'project-character-stranger');
  result = await request(`/api/characters?projectId=${projectA.id}`, { cookie: other });
  assert.equal(result.status, 404, JSON.stringify(result.data), 'a foreign project must not be readable');
  result = await request('/api/characters', {
    method: 'POST',
    cookie: other,
    body: { name: 'Intruder', description: 'x', projectId: projectA.id },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));
  result = await request(`/api/characters/${ava.id}/versions/import`, {
    method: 'POST',
    cookie: other,
    body: { fromVersionId: makerPortrait.id },
  });
  assert.equal(result.status, 404, JSON.stringify(result.data));

  // 8. Deleting answers with the deleted character's own scope.
  result = await request(`/api/characters/${ava.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.characters, [], 'the list must stay in the project scope');

  // 9. Deleting the project cascades to its characters, and never touches the
  //    standalone maker character.
  result = await request('/api/characters', {
    method: 'POST',
    cookie,
    body: { name: 'Ben', description: 'Tall, grey wool coat.', projectId: projectA.id },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  result = await request(`/api/projects/${projectA.id}`, { method: 'DELETE', cookie });
  assert.ok(result.status === 200 || result.status === 204, JSON.stringify(result.data));
  result = await request('/api/characters', { cookie });
  assert.deepEqual(result.data.characters.map((item) => item.id), [maker.id]);
});

test('Character maker requires a signed-in user', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-maker-auth-'));
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

  let result = await request('/api/characters');
  assert.equal(result.status, 401, JSON.stringify(result.data));
  result = await request('/api/characters', { method: 'POST', body: { name: 'Nobody' } });
  assert.equal(result.status, 401, JSON.stringify(result.data));
  result = await request('/api/characters/anything/generate', { method: 'POST', body: { mode: 'portrait' } });
  assert.equal(result.status, 401, JSON.stringify(result.data));
  result = await request('/api/characters/anything/image/whatever.png');
  assert.equal(result.status, 401, JSON.stringify(result.data));
  assert.equal(mock.calls.length, 0);
});
