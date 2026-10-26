'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const security = require(path.join(ROOT, 'security.js'));

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
      if (response.ok) return response;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error('server did not become ready');
}

function envFor(port, dataDir, extra = {}) {
  return {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    APP_SECRET: 'phase1-test-secret-long-enough-123456',
    ...extra,
  };
}

async function startServer(port, dataDir, extra = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: envFor(port, dataDir, extra),
    stdio: 'ignore',
  });
  await waitForHealth(`http://127.0.0.1:${port}`);
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function request(base, pathname, { method = 'GET', body, cookie = '', origin } = {}) {
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
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return {
    status: response.status,
    data,
    cookie: (response.headers.get('set-cookie') || '').split(';')[0],
    setCookie: response.headers.get('set-cookie') || '',
    headers: response.headers,
  };
}

test('Phase 1 password hashing', async () => {
  const first = await security.hashPassword('correct horse battery staple');
  const second = await security.hashPassword('correct horse battery staple');
  assert.notEqual(first.salt, second.salt);
  assert.equal(await security.verifyPassword('correct horse battery staple', first.salt, first.hash), true);
  assert.equal(await security.verifyPassword('wrong password', first.salt, first.hash), false);
});

test('Phase 1 auth, sessions, CSRF, rate limiting, and headers', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-test-'));
  const base = `http://127.0.0.1:${port}`;
  const child = await startServer(port, dataDir, { LOGIN_WINDOW_MS: '12000' });

  t.after(async () => {
    await stopServer(child);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (_) { /* WAL cleanup can lag on Windows */ }
  });

  let cookie = '';
  let token = '';

  await t.test('register, me, logout, login, me', async () => {
    let result = await request(base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'phaseone', password: 'password123' },
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.user.username, 'phaseone');
    assert.equal(result.data.user.hasApiKey, false);
    assert.match(result.setCookie, /HttpOnly/);
    assert.match(result.setCookie, /SameSite=Lax/);
    assert.match(result.setCookie, /Path=\//);
    cookie = result.cookie;
    token = cookie.slice(cookie.indexOf('=') + 1);

    result = await request(base, '/api/auth/me', { cookie });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.username, 'phaseone');

    const raw = new DatabaseSync(path.join(dataDir, 'app.db'));
    const sessions = raw.prepare('SELECT token_hash FROM sessions').all();
    raw.close();
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].token_hash, token);
    assert.equal(sessions[0].token_hash, security.sha256(token));

    result = await request(base, '/api/auth/logout', {
      method: 'POST',
      cookie,
      origin: base,
    });
    assert.equal(result.status, 200);
    result = await request(base, '/api/auth/me', { cookie });
    assert.equal(result.status, 401);

    result = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'phaseone', password: 'password123' },
    });
    assert.equal(result.status, 200);
    cookie = result.cookie;
    result = await request(base, '/api/auth/me', { cookie });
    assert.equal(result.status, 200);
  });

  await t.test('wrong password and unknown user have the same safe response', async () => {
    const wrong = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'phaseone', password: 'definitely-wrong' },
    });
    const missing = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'no-such-account', password: 'definitely-wrong' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.data.error, missing.data.error);
  });

  await t.test('foreign-origin mutation is rejected and same-origin accepted', async () => {
    let result = await request(base, '/api/auth/logout', {
      method: 'POST',
      cookie,
      origin: 'https://evil.example',
    });
    assert.equal(result.status, 403);

    result = await request(base, '/api/auth/logout', {
      method: 'POST',
      cookie,
      origin: base,
    });
    assert.equal(result.status, 200);
  });

  await t.test('expired session is rejected', async () => {
    let result = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'phaseone', password: 'password123' },
    });
    assert.equal(result.status, 200);
    cookie = result.cookie;

    const raw = new DatabaseSync(path.join(dataDir, 'app.db'));
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.prepare('UPDATE sessions SET expires_at = 1').run();
    raw.close();

    result = await request(base, '/api/auth/me', { cookie });
    assert.equal(result.status, 401);
  });

  await t.test('login throttling triggers and recovers after the window', async () => {
    let result = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      result = await request(base, '/api/auth/login', {
        method: 'POST',
        body: { username: 'phaseone', password: `wrong-${attempt}` },
      });
      assert.equal(result.status, 401);
    }
    result = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'phaseone', password: 'wrong-10' },
    });
    assert.equal(result.status, 429);

    await new Promise((resolve) => setTimeout(resolve, 12200));

    result = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'phaseone', password: 'password123' },
    });
    assert.equal(result.status, 200);
    cookie = result.cookie;
  });

  await t.test('security headers are present on the app shell', async () => {
    const result = await request(base, '/', { cookie });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('referrer-policy'), 'same-origin');
    assert.match(result.headers.get('content-security-policy') || '', /script-src 'self'/);
  });

  await t.test('static traversal is rejected', async () => {
    const result = await request(base, '/..%2Fpackage.json');
    assert.ok(result.status === 403 || result.status === 404, `status ${result.status}`);
  });

  await t.test('health includes the version', async () => {
    const result = await request(base, '/api/health');
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.version, require(path.join(ROOT, 'package.json')).version);
  });
});

test('Phase 1 persists a generated APP_SECRET across restarts', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-secret-'));
  const secretFile = path.join(dataDir, 'secret.key');
  let child = null;

  t.after(async () => {
    await stopServer(child);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (_) { /* WAL cleanup can lag on Windows */ }
  });

  child = await startServer(port, dataDir, { APP_SECRET: '' });
  assert.equal(fs.existsSync(secretFile), true);
  const firstSecret = fs.readFileSync(secretFile, 'utf8').trim();
  assert.ok(firstSecret.length >= 16);
  await stopServer(child);

  child = await startServer(port, dataDir, { APP_SECRET: '' });
  const secondSecret = fs.readFileSync(secretFile, 'utf8').trim();
  assert.equal(secondSecret, firstSecret);
});
