'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { init } = require('../generationreviews');
const ROOT = path.resolve(__dirname, '..');

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('one'), ('two'); INSERT INTO projects VALUES ('p1'), ('p2');");
  return db;
}

test('generation decisions persist, isolate scopes, and unlock only after an explicit decision or failure', () => {
  const db = database();
  const store = init(db);
  const first = store.begin('one', 'p1', 'sheet', 'character-a');
  assert.throws(() => store.begin('one', 'p1', 'sheet', 'character-a'), { code: 'GENERATION_REVIEW_REQUIRED' });
  assert.throws(() => store.decide('one', first.id, 'approved'), { status: 409 });
  store.complete('one', first.id, { sheet: { id: 'sheet-a' } });
  const reloaded = init(db);
  assert.equal(reloaded.get('one', first.id).status, 'pending');
  assert.equal(reloaded.get('two', first.id), null);
  assert.throws(() => reloaded.decide('two', first.id, 'approved'), { status: 404 });
  assert.throws(() => reloaded.decide('one', first.id, 'maybe'), { status: 400 });
  assert.throws(() => reloaded.begin('one', 'p1', 'sheet', 'character-a'), { status: 409 });
  for (const args of [['two', 'p1', 'sheet', 'character-a'], ['one', 'p2', 'sheet', 'character-a'], ['one', 'p1', 'sheet', 'character-b']]) {
    const other = reloaded.begin(...args);
    reloaded.fail(args[0], other.id);
  }
  reloaded.decide('one', first.id, 'disapproved');
  const second = reloaded.begin('one', 'p1', 'sheet', 'character-a');
  reloaded.complete('one', second.id, {});
  reloaded.decide('one', second.id, 'approved');
  assert.throws(() => reloaded.decide('one', second.id, 'disapproved'), { status: 409 });
  const interrupted = reloaded.begin('one', 'p1', 'sheet', 'character-a');
  const restarted = init(db);
  assert.equal(restarted.get('one', interrupted.id).status, 'failed');
  assert.equal(restarted.list('one').length, 0);
  restarted.begin('one', 'p1', 'sheet', 'character-a');
  db.close();
});

test('existing sheet history locks only the latest undecided draft and is migrated once', () => {
  const db = database();
  db.exec("CREATE TABLE character_sheets (id TEXT, user_id TEXT, project_id TEXT, character_id TEXT, version INTEGER, status TEXT, created_at TEXT)");
  const insert = db.prepare('INSERT INTO character_sheets VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('old', 'one', 'p1', 'a', 1, 'draft', '2026-10-23');
  insert.run('new', 'one', 'p1', 'a', 2, 'draft', '2026-10-24');
  insert.run('old-b', 'one', 'p1', 'b', 1, 'draft', '2026-10-23');
  insert.run('final-b', 'one', 'p1', 'b', 2, 'final', '2026-10-24');
  const store = init(db);
  assert.equal(store.list('one').length, 1);
  assert.equal(store.list('one')[0].result.sheet.id, 'new');
  store.decide('one', store.list('one')[0].id, 'disapproved');
  assert.equal(init(db).list('one').length, 0, 'a rejected old draft must not be locked again');
  db.close();
});

class Element {
  constructor(tag = 'button') { this.tag = tag; this.dataset = {}; this.children = []; this.disabled = false; this.value = ''; this.listeners = {}; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)])
      .filter((child) => selector === 'button' ? child.tag === 'button' : selector === '.generation-review' && child.className === 'generation-review');
  }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(event, handler) { this.listeners[event] = handler; }
}

function browser() {
  const nodes = new Map();
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const context = vm.createContext({
    state: { user: { id: 'one' }, ideas: [], selected: new Set(), reference: { projectId: 'p1' }, generation: { projectId: 'p1' },
      story: { projectId: 'p1', sheetCharacterId: 'a', data: { characters: [{ id: 'a' }, { id: 'b' }], worksheet: { actions: [] } } } },
    $: get, $$: () => [...nodes.values()].filter((node) => node.dataset.generationScope),
    document: { createElement: (tag) => new Element(tag) }, window: { addEventListener() {} },
    setTimeout, clearTimeout, ApiError: class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } },
    updateGenerateNextImageButton() {}, renderIdeas() {}, renderWorksheet() {}, loadProjects: async () => {}, loadStory: async () => {},
    refreshSidebarStory() {}, toast() {},
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/generation-review.js'), 'utf8'), context);
  vm.runInContext('generationReviewsReady = true', context);
  get('#worksheet-character').value = 'a';
  return { context, get, evaluate: (source) => vm.runInContext(source, context) };
}

test('Generate buttons and aliases remain disabled until a successful human decision, including batch re-renders', async () => {
  const { context, get, evaluate } = browser();
  let release;
  let calls = 0;
  context.apiRequest = async (route) => {
    calls += 1;
    if (route === '/api/reference') return new Promise((resolve) => { release = resolve; });
    return { generationReview: { id: 'review', status: 'approved' } };
  };
  const pending = evaluate("api('/api/reference', { method: 'POST', body: { projectId: 'p1' } })");
  assert.equal(get('#ref-generate').disabled, true);
  assert.equal(get('#ref-regenerate').disabled, true);
  await assert.rejects(evaluate("api('/api/reference', { method: 'POST', body: { projectId: 'p1' } })"), { code: 'GENERATION_REVIEW_REQUIRED' });
  assert.equal(calls, 1);
  release({ generationReview: { id: 'review', kind: 'reference', projectId: 'p1', target: '', status: 'pending', result: {} } });
  await pending;
  evaluate('refreshGenerationLocks()');
  assert.equal(get('#ref-generate').disabled, true);
  context.apiRequest = async () => { throw new Error('Decision could not be saved'); };
  await assert.rejects(evaluate("decideGenerationReview(generationReviewRows[0], 'approved')"));
  assert.equal(get('#ref-generate').disabled, true);
  context.apiRequest = async () => ({ generationReview: { id: 'review', status: 'disapproved' } });
  await evaluate("decideGenerationReview(generationReviewRows[0], 'disapproved')");
  assert.equal(get('#ref-generate').disabled, false);
  assert.equal(get('#ref-regenerate').disabled, false);
  evaluate("generationReviewRows = [{ id: 'sheet', kind: 'sheet', projectId: 'p1', target: 'a', status: 'pending', result: {} }]; refreshGenerationLocks()");
  assert.equal(get('#worksheet-generate-one').disabled, true);
  assert.equal(get('#worksheet-generate-all').disabled, true);
  get('#worksheet-character').value = 'b';
  evaluate('refreshGenerationLocks()');
  assert.equal(get('#worksheet-generate-one').disabled, false, 'an independent character can still be generated');
  get('#worksheet-generate-all').dataset.generating = 'true';
  evaluate('generationReviewRows = []; refreshGenerationLocks()');
  assert.equal(get('#worksheet-generate-all').disabled, true, 'batch stays locked between requests');
});

test('provider errors unlock controls and a refresh restores pending previews without leaking between accounts', async () => {
  const { context, get, evaluate } = browser();
  context.apiRequest = async () => { throw new context.ApiError('Provider unavailable', 502); };
  await assert.rejects(evaluate("api('/api/generate', { method: 'POST', body: {} })"));
  assert.equal(get('#generate-btn').disabled, false);
  context.apiRequest = async () => ({ reviews: [{ id: 'ideas', kind: 'ideas', projectId: '', target: '', status: 'pending', result: { ideas: [{ title: 'Restored draft' }] } }] });
  await evaluate('loadGenerationReviews()');
  assert.equal(context.state.ideas[0].title, 'Restored draft');
  assert.equal(get('#generate-btn').disabled, true);
  evaluate('resetGenerationReviews()');
  context.state.user = { id: 'two' };
  context.apiRequest = async () => ({ reviews: [] });
  await evaluate('loadGenerationReviews()');
  assert.equal(get('#generate-btn').disabled, false);
});

test('a slow refresh cannot restore a decision that was already saved', async () => {
  const { context, get, evaluate } = browser();
  evaluate("generationReviewRows = [{ id: 'review', kind: 'reference', projectId: 'p1', target: '', status: 'pending', result: {} }]");
  let release;
  context.apiRequest = async (route) => route === '/api/generation/reviews'
    ? new Promise((resolve) => { release = resolve; }) : { generationReview: { id: 'review', status: 'approved' } };
  const refreshing = evaluate('loadGenerationReviews()');
  await evaluate("decideGenerationReview(generationReviewRows[0], 'approved')");
  release({ reviews: [{ id: 'review', kind: 'reference', projectId: 'p1', target: '', status: 'pending', result: {} }] });
  await refreshing;
  assert.equal(get('#ref-generate').disabled, false);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('HTTP generation blocks concurrent and undecided repeats, survives restart, and releases after decisions or provider errors', { timeout: 20000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-review-'));
  let release;
  let reached;
  let slow = true;
  let failure = false;
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume the synthetic prompt */ }
    calls += 1;
    if (slow) { reached(); await new Promise((resolve) => { release = resolve; }); }
    res.writeHead(failure ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure ? { error: { message: 'Synthetic provider outage' } } : {
      choices: [{ message: { content: JSON.stringify([{ title: 'Preview', description: 'A synthetic result.' }]) }, finish_reason: 'stop' }],
    }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let child;
  async function stop() { if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); } }
  t.after(async () => {
    if (release) release();
    await stop();
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'app.db'), APP_SECRET: 'generation-review-test-secret-1234567890',
      DEEPSEEK_ENDPOINT: 'http://127.0.0.1:' + mock.address().port + '/text' }, stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(base + '/api/health')).ok) return; } catch (_) { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('App did not start');
  }
  await start();
  let cookie = '';
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data };
  }
  assert.equal((await request('/api/generation/reviews')).status, 401);
  await request('/api/auth/register', 'POST', { username: 'review-one', password: 'password123' });
  await request('/api/me/api-key', 'PUT', { apiKey: 'synthetic-review-key-1234567890' });
  const firstCookie = cookie;
  const generate = () => request('/api/generate', 'POST', { context: 'Synthetic prompt', numIdeas: 1 });
  const waiting = new Promise((resolve) => { reached = resolve; });
  const first = generate();
  await waiting;
  assert.equal((await generate()).status, 409);
  assert.equal(calls, 1);
  const running = (await request('/api/generation/reviews')).data.reviews[0];
  assert.equal(running.status, 'running');
  assert.equal((await request('/api/generation/reviews/' + running.id, 'POST', { decision: 'approved' })).status, 409);
  slow = false; release(); release = null;
  const result = await first;
  assert.equal(result.status, 200);
  const reviewId = result.data.generationReview.id;
  assert.equal((await generate()).status, 409);
  assert.equal(calls, 1);
  await stop(); await start();
  const restored = (await request('/api/generation/reviews')).data.reviews[0];
  assert.equal(restored.id, reviewId);
  assert.equal(restored.result.ideas[0].title, 'Preview');
  assert.equal((await generate()).status, 409);
  cookie = '';
  await request('/api/auth/register', 'POST', { username: 'review-two', password: 'password123' });
  assert.deepEqual((await request('/api/generation/reviews')).data.reviews, []);
  assert.equal((await request('/api/generation/reviews/' + reviewId, 'POST', { decision: 'approved' })).status, 404);
  cookie = firstCookie;
  assert.equal((await request('/api/generation/reviews/' + reviewId, 'POST', { decision: 'disapproved' })).status, 200);
  failure = true;
  assert.equal((await generate()).status, 502);
  assert.deepEqual((await request('/api/generation/reviews')).data.reviews, []);
  failure = false;
  const retry = await generate();
  assert.equal(retry.status, 200);
  assert.equal((await request('/api/generation/reviews/' + retry.data.generationReview.id, 'POST', { decision: 'approved' })).status, 200);
  assert.equal((await generate()).status, 200);
});
