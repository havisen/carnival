'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { init, sanitize, bodySnapshot, cleanUrl } = require('../track');
const ROOT = path.resolve(__dirname, '..');

test('trace snapshots redact credentials, signed URLs, and image data while retaining generation diagnostics', () => {
  const secrets = new Set();
  const snapshot = sanitize({ authorization: 'Bearer test-provider-key', cookie: 'sid=test-session-token',
    apiKey: 'test-provider-key', password: 'test-password',
    reply: 'Your test-provider-key was rejected. Bearer another-key',
    data: [{ b64_json: 'encoded-image-bytes' }],
    reference: 'data:image/png;base64,AAABBB==',
    url: 'https://images.example/output?x-amz-signature=private-signature&size=2K',
    usage: { input_tokens: 10, output_tokens: 4 },
  }, secrets);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-provider-key|test-session-token|test-password|private-signature|encoded-image-bytes|AAABBB|another-key/);
  assert.equal(snapshot.usage.input_tokens, 10);
  assert.equal(snapshot.usage.output_tokens, 4);
  assert.match(cleanUrl('/api/assets?api_key=hidden&projectId=p1'), /projectId=p1/);
  assert.doesNotMatch(cleanUrl('https://name:password@provider.example/path?token=hidden'), /password|hidden/);
  assert.equal(bodySnapshot('{bad JSON', secrets), '{bad JSON');
  assert.doesNotMatch(bodySnapshot('{"apiKey":"malformed-secret", "password":"malformed-password",', secrets), /malformed-secret|malformed-password/);
  assert.doesNotMatch(cleanUrl('https://images.example/file?X-Amz-Security-Token=private-token'), /private-token/);
  assert.equal(bodySnapshot({ content: 'x'.repeat(400000) }, secrets).truncated, true);
});

test('request history survives initialization and marks interrupted work without affecting completed traces', () => {
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('one'), ('two')");
  init(database);
  const insert = database.prepare('INSERT INTO request_traces (id, user_id, trace_id, direction, status, started_at, document) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [id, user, status] of [['waiting', 'one', 'pending'], ['done', 'one', 'success'], ['other', 'two', 'success']]) {
    insert.run(id, user, id, 'outgoing', status, new Date().toISOString(), JSON.stringify({ id, status, responseBody: { content: 'saved output' } }));
  }
  const store = init(database);
  assert.equal(store.get('one', 'waiting').status, 'interrupted');
  assert.equal(store.get('one', 'done').status, 'success');
  assert.equal(store.get('two', 'done'), null);
  assert.equal(store.list('one', new URLSearchParams()).total, 2);
  assert.equal(store.list('one', new URLSearchParams('q=saved&limit=1')).requests.length, 1);
  assert.equal(store.list('one', new URLSearchParams('q=%')).total, 0, 'search treats SQL wildcards literally');
  database.close();
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('Track correlates real app requests with local provider responses, pending work, failures, images, and isolated accounts', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnival-track-'));
  const key = 'sk-fake-track-provider-1234567890';
  const password = 'fake-track-password';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCdcAAAAASUVORK5CYII=', 'base64');
  let mode = 'success';
  let release;
  let reached;
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls += 1;
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'mock-request-id' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/download')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
    if (req.url === '/images') {
      return json({ data: [mode === 'image-url' ? { url: `http://127.0.0.1:${mock.address().port}/download?signature=private-signature` }
        : { b64_json: png.toString('base64'), size: '2K' }] });
    }
    if (mode === 'slow') {
      reached();
      await new Promise((resolve) => { release = resolve; });
    }
    if (mode === 'reset') return req.socket.destroy();
    if (mode === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('not a JSON provider reply'); }
    if (mode === 'http-error') return json({ error: { message: `Rejected ${key}`, code: 'rate_limited' } }, 429);
    json({ model: 'deepseek-v4-pro', choices: [{ message: { content: '[{"title":"A tracked idea","description":"A test generation."}]',
      reasoning_content: 'Synthetic reasoning' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  };
  t.after(async () => {
    if (release) release();
    await stop();
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    const resolvedDir = path.resolve(dataDir);
    assert.ok(resolvedDir.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolvedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, DB_PATH: path.join(dataDir, 'app.db'),
      APP_SECRET: 'track-test-secret-12345678901234567890',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mock.address().port}/chat`,
      BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mock.address().port}/images`,
    }, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch (_) { /* starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(ready, 'app started');
  }
  await start();
  let cookie = '';
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, traceId: response.headers.get('x-trace-id'), data: await response.json() };
  }
  const history = async (query = '') => (await request('/api/track' + query)).data;
  const detail = async (id) => (await request('/api/track/' + id)).data.request;
  const generate = () => request('/api/generate', 'POST', { context: 'Synthetic tracking context', numIdeas: 1 });
  assert.equal((await request('/api/track')).status, 401);
  for (const route of ['/track', '/track/', '/track/index.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await response.text(), /Request activity/);
  }
  assert.equal((await request('/api/auth/register', 'POST', { username: 'tracker-one', password })).status, 201);
  assert.equal((await request('/api/me/api-key', 'PUT', { apiKey: key })).status, 200);
  const firstCookie = cookie;
  let response = await generate();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const firstId = response.traceId;
  const related = await history('?traceId=' + firstId);
  assert.equal(related.total, 2);
  const outgoing = related.requests.find((entry) => entry.direction === 'outgoing');
  assert.equal(outgoing.parentId, firstId);
  assert.equal(outgoing.provider, 'deepseek');
  assert.equal(outgoing.statusCode, 200);
  assert.equal(outgoing.status, 'success');
  assert.equal(Object.hasOwn(outgoing, 'responseBody'), false, 'list excludes heavy payloads');
  const raw = await detail(outgoing.id);
  assert.match(raw.requestBody.messages[1].content, /Synthetic tracking context/);
  assert.equal(raw.responseBody.choices[0].finish_reason, 'stop');
  assert.equal(raw.responseBody.usage.total_tokens, 30);
  assert.equal(raw.responseHeaders['x-request-id'], 'mock-request-id');
  assert.ok(raw.network.headersMs >= 0);
  assert.ok(raw.durationMs >= raw.network.headersMs);
  assert.ok(raw.requestBytes > 0 && raw.responseBytes > 0);
  assert.equal((await detail(firstId)).responseBody.ideas[0].title, 'A tracked idea');
  assert.equal((await detail(firstId)).requestBytes, Buffer.byteLength(JSON.stringify({ context: 'Synthetic tracking context', numIdeas: 1 })));
  assert.equal((await history('?q=Synthetic%20tracking%20context&direction=outgoing')).total, 1);
  const beforePolling = (await history()).total;
  await detail(outgoing.id); await history();
  assert.equal((await history()).total, beforePolling, 'debugger reads do not record themselves');
  assert.equal((await history('?limit=1&offset=1')).requests.length, 1);

  for (const failure of ['bad-json', 'http-error', 'reset']) {
    mode = failure;
    const before = calls;
    response = await generate();
    assert.equal(response.status, 502);
    assert.equal(calls, before + 1, 'tracing never retries providers');
    const group = await history('?traceId=' + response.traceId);
    assert.equal(group.total, 2);
    const parent = await detail(response.traceId);
    assert.equal(parent.status, 'error');
    const provider = await detail(group.requests.find((entry) => entry.direction === 'outgoing').id);
    if (failure === 'bad-json') {
      assert.equal(provider.status, 'success', 'HTTP success and application parse failure stay distinguishable');
      assert.equal(provider.responseBody, 'not a JSON provider reply');
      assert.equal(parent.responseBody.code, 'UPSTREAM_BAD_JSON');
    } else {
      assert.equal(provider.status, 'error');
      if (failure === 'http-error') { assert.equal(provider.statusCode, 429); assert.doesNotMatch(JSON.stringify(provider), new RegExp(key)); }
      else assert.ok(provider.error.code || provider.error.message);
    }
  }

  mode = 'slow';
  const waiting = new Promise((resolve) => { reached = resolve; });
  const pending = generate();
  await waiting;
  const inFlight = await history('?status=pending');
  assert.equal(inFlight.total, 2);
  release(); release = null;
  assert.equal((await pending).status, 200);
  assert.equal((await history('?status=pending')).total, 0);

  assert.equal((await request('/api/me/byteplus-key', 'PUT', { apiKey: key })).status, 200);
  const created = await request('/api/projects', 'POST', { title: 'Track image test', stage: 'Generation Stage', referenceMaterial: 'Synthetic scene references.', scenes: [{ id: 'test-scene', title: 'A tracked scene' }] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const project = created.data.project;
  const upload = await fetch(`${base}/api/images/upload?projectId=${project.id}&sceneId=test-scene`, {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png,
  });
  assert.equal(upload.status, 200);
  await upload.json();
  const uploadTrace = await detail(upload.headers.get('x-trace-id'));
  assert.equal(uploadTrace.requestBytes, png.length);
  assert.equal(uploadTrace.requestBody, '[binary body omitted]');
  assert.equal(uploadTrace.projectId, project.id);
  for (const imageMode of ['image-base64', 'image-url']) {
    mode = imageMode;
    response = await request('/api/images/generate', 'POST', { projectId: project.id, sceneId: 'test-scene', prompt: 'Synthetic tracked image', size: '2K' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const group = await history('?traceId=' + response.traceId);
    assert.equal(group.total, imageMode === 'image-url' ? 3 : 2);
    for (const row of group.requests) {
      const entry = await detail(row.id);
      assert.equal(entry.projectId, project.id);
      assert.doesNotMatch(JSON.stringify(entry), /private-signature/);
      if (entry.provider === 'image-download') { assert.equal(entry.responseBytes, png.length); assert.equal(entry.responseBody, '[binary body omitted]'); }
      if (entry.provider === 'byteplus' && imageMode === 'image-base64') assert.equal(entry.responseBody.data[0].b64_json, '[image data omitted]');
    }
  }

  // Check persisted documents as well as API responses for secret leakage.
  const database = new DatabaseSync(path.join(dataDir, 'app.db'));
  const documents = database.prepare('SELECT document FROM request_traces').all().map((row) => row.document).join('\n');
  assert.doesNotMatch(documents, new RegExp(`${key}|${password}|${firstCookie.slice(4)}|private-signature|${png.toString('base64').slice(0, 35)}`));
  database.exec('ALTER TABLE request_traces RENAME TO request_traces_unavailable');
  try {
    mode = 'success';
    const before = calls;
    assert.equal((await generate()).status, 200, 'trace storage failures do not fail a generation');
    assert.equal(calls, before + 1, 'storage failures do not repeat provider calls');
  } finally { database.exec('ALTER TABLE request_traces_unavailable RENAME TO request_traces'); }
  database.close();
  const persistedTotal = (await history()).total;
  await stop(); await start();
  assert.equal((await history()).total, persistedTotal, 'history and sessions survive restart');
  assert.equal((await detail(firstId)).status, 'success');
  cookie = '';
  assert.equal((await request('/api/auth/register', 'POST', { username: 'tracker-two', password })).status, 201);
  assert.equal((await request('/api/track/' + firstId)).status, 404);
  assert.equal((await history('?traceId=' + firstId)).total, 0);
  assert.equal((await history()).total, 1, 'second account sees only its registration');
  const secondCookie = cookie;
  cookie = firstCookie;
  const switched = await request('/api/auth/login', 'POST', { username: 'tracker-two', password });
  assert.equal(switched.status, 200);
  assert.equal((await detail(switched.traceId)).responseBody.user.username, 'tracker-two');
  cookie = firstCookie;
  assert.equal((await request('/api/track/' + switched.traceId)).status, 404, 'login traces belong to the account that signed in');
  cookie = secondCookie;
  assert.equal((await request('/api/track', 'POST', {})).status, 405);
});
