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
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j8sAAAAASUVORK5CYII=',
  'base64'
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const WEBP = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==',
  'base64'
);

let server;
let workDir;
let imagesDir;
let baseUrl;
let cookieA = '';
let cookieB = '';
let projectA;
let projectB;

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

function writeImage(relativePath, buffer) {
  const fullPath = path.join(imagesDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
}

function setMtime(relativePath, isoDate) {
  const date = new Date(isoDate);
  fs.utimesSync(path.join(imagesDir, relativePath), date, date);
}

async function waitForServer(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('server did not become ready');
}

async function request(pathname, { method = 'GET', body, cookie = cookieA } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const value = setCookie.split(';')[0];
    if (cookie === cookieA || !cookieA) cookieA = value;
    else if (cookie === cookieB) cookieB = value;
  }
  return response;
}

async function json(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { status: response.status, data };
}

async function upload(projectId, cookie) {
  const response = await fetch(`${baseUrl}/api/images/upload?projectId=${projectId}&sceneId=s1`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
    body: PNG,
  });
  assert.equal(response.status, 200, await response.text());
}

test('Library API', async (t) => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
  imagesDir = path.join(workDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'library-test-secret-long-enough-123456',
    },
    stdio: 'ignore',
  });
  await waitForServer(baseUrl);

  t.after(async () => {
    if (server && !server.killed) {
      server.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) { /* Windows may briefly retain the SQLite files */ }
  });

  await t.test('prepares fixtures', async () => {
    writeImage('root Alpha.PNG', PNG);
    writeImage('nested/Café image.gif', GIF);
    writeImage('folder-a/duplicate.webp', WEBP);
    writeImage('folder-b/duplicate.webp', WEBP);
    writeImage('broken/malformed.png', Buffer.from('not a png'));
    writeImage('broken/notes.txt', Buffer.from('not an image'));
    writeImage('.hidden.png', PNG);
    writeImage('__MACOSX/ignored.png', PNG);
    writeImage('folder-a/Thumbs.db', Buffer.from('system'));

    setMtime('root Alpha.PNG', '2026-01-01T00:00:00.000Z');
    setMtime('nested/Café image.gif', '2026-02-01T00:00:00.000Z');
    setMtime('folder-a/duplicate.webp', '2026-03-01T00:00:00.000Z');
    setMtime('folder-b/duplicate.webp', '2026-04-01T00:00:00.000Z');

    let result = await json('/api/auth/register', {
      method: 'POST',
      body: { username: 'library-a', password: 'password123' },
    });
    assert.equal(result.status, 201);

    result = await json('/api/auth/register', {
      method: 'POST',
      body: { username: 'library-b', password: 'password123' },
      cookie: '',
    });
    assert.equal(result.status, 201);
    cookieB = result.cookie || cookieB;
    // The register response also carries a Set-Cookie; capture it explicitly.
    if (!cookieB) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'library-b', password: 'password123' }),
      });
      cookieB = (response.headers.get('set-cookie') || '').split(';')[0];
    }

    result = await json('/api/projects', {
      method: 'POST',
      body: {
        title: 'A project',
        stage: 'Generation Stage',
        referenceMaterial: 'REF',
        scenes: [{ id: 's1', title: 'A scene', action: '', location: '', characters: [] }],
      },
    });
    assert.equal(result.status, 201);
    projectA = result.data.project;
    await upload(projectA.id, cookieA);
    setMtime(`${projectA.id}/${fs.readdirSync(path.join(imagesDir, projectA.id))[0]}`, '2025-01-01T00:00:00.000Z');

    const bProjectResult = await json('/api/projects', {
      method: 'POST',
      body: {
        title: 'B project',
        stage: 'Generation Stage',
        referenceMaterial: 'REF',
        scenes: [{ id: 's1', title: 'B scene', action: '', location: '', characters: [] }],
      },
      cookie: cookieB,
    });
    assert.equal(bProjectResult.status, 201);
    projectB = bProjectResult.data.project;
    await upload(projectB.id, cookieB);
    writeImage(`shared/${projectB.id}/nested-leak.png`, PNG);
  });

  await t.test('recursive discovery, filtering, sorting, and metadata', async () => {
    const result = await json('/api/library');
    assert.equal(result.status, 200);
    const images = result.data.images;
    const ids = images.map((image) => image.id);

    assert.ok(ids.includes('root Alpha.PNG'));
    assert.ok(ids.includes('nested/Café image.gif'));
    assert.ok(ids.includes('folder-a/duplicate.webp'));
    assert.ok(ids.includes('folder-b/duplicate.webp'));
    assert.ok(!ids.some((id) => id.includes('malformed')));
    assert.ok(!ids.some((id) => id.includes('notes.txt')));
    assert.ok(!ids.some((id) => id.includes('.hidden')));
    assert.ok(!ids.some((id) => id.includes('__MACOSX')));
    assert.ok(!ids.some((id) => id.includes('Thumbs.db')));
    assert.ok(!ids.some((id) => id.startsWith(projectB.id)));
    assert.ok(!ids.some((id) => id.startsWith('shared/')));
    assert.ok(ids.some((id) => id.startsWith(`${projectA.id}/`)));

    const shared = images.filter((image) => !image.metadata);
    assert.deepEqual(
      shared.map((image) => image.id),
      [
        'folder-b/duplicate.webp',
        'folder-a/duplicate.webp',
        'nested/Café image.gif',
        'root Alpha.PNG',
      ]
    );

    const png = images.find((image) => image.id === 'root Alpha.PNG');
    assert.equal(png.width, 1);
    assert.equal(png.height, 1);
    assert.ok(png.sizeBytes > 0);
    assert.equal(png.metadata, null);
    assert.ok(!JSON.stringify(result.data).includes(workDir));

    const projectImage = images.find((image) => image.metadata && image.metadata.projectId === projectA.id);
    assert.ok(projectImage);
    assert.equal(projectImage.metadata.sceneId, 's1');
    assert.equal(projectImage.metadata.source, 'upload');
  });

  await t.test('serves encoded paths and enforces ownership', async () => {
    const result = await json('/api/library');
    const images = result.data.images;
    const unicode = images.find((image) => image.id === 'nested/Café image.gif');
    const response = await request(unicode.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);

    const projectImage = images.find((image) => image.metadata && image.metadata.projectId === projectA.id);
    const own = await request(projectImage.url);
    assert.equal(own.status, 200);

    const other = await request(projectImage.url, { cookie: cookieB });
    assert.equal(other.status, 404);

    const nestedLeak = await json(
      `/api/library/file?path=${encodeURIComponent(`shared/${projectB.id}/nested-leak.png`)}`
    );
    assert.equal(nestedLeak.status, 404);

    const anon = await request('/api/library', { cookie: '' });
    assert.equal(anon.status, 401);
  });

  await t.test('rejects traversal and missing files', async () => {
    const attempts = [
      '../package.json',
      '/etc/passwd',
      '..%2Fpackage.json',
      'C:\\Windows\\win.ini',
      'nested/../../package.json',
    ];
    for (const attempt of attempts) {
      const result = await json(`/api/library/file?path=${encodeURIComponent(attempt)}`);
      assert.ok(result.status === 400 || result.status === 404, `${attempt}: ${result.status}`);
    }
    const missing = await json('/api/library/file?path=missing%2Fnope.png');
    assert.equal(missing.status, 404);
    const hidden = await json('/api/library/file?path=.hidden.png');
    assert.equal(hidden.status, 404);
    const system = await json('/api/library/file?path=__MACOSX%2Fignored.png');
    assert.equal(system.status, 404);
  });

  await t.test('records missing image roots as missing assets without recreating the root', async () => {
    const moved = `${imagesDir}-moved`;
    fs.renameSync(imagesDir, moved);
    let result = await json('/api/library');
    assert.equal(result.status, 200);
    assert.ok(result.data.images.length > 0);
    assert.ok(result.data.images.every((image) => image.missing === true));
    assert.equal(fs.existsSync(imagesDir), false);

    fs.mkdirSync(imagesDir);
    result = await json('/api/library');
    assert.equal(result.status, 200);
    assert.ok(result.data.images.length > 0);
    assert.ok(result.data.images.every((image) => image.missing === true));
    fs.rmSync(imagesDir, { recursive: true, force: true });
    fs.renameSync(moved, imagesDir);
  });
});
