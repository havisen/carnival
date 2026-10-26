'use strict';

// Carnival modules and the Story Studio progress overview:
//
//   1. GET /api/studio/:projectId/progress reports one status per workflow
//      step, derived from the data each step edits, and never from a stored
//      flag that could drift from the work.
//   2. A status of 'attention' always means a human decision is waiting;
//      'todo' means work that has not been done.
//   3. The overview is scoped to its owner, and the story cannot be read,
//      written, or advanced through another account.
//   4. The navigation contract: every module screen points at a panel that
//      switchTab() can activate, and Story Studio's steps map onto its screens.
//
// Only a temporary database and a temporary data directory are used.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

const STEP_ORDER = ['idea', 'references', 'cast', 'scenes', 'generate', 'review'];

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

function startServer(workDir, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: workDir,
      APP_SECRET: 'studio-modules-secret-long-enough-1234',
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

function stepOf(progress, id) {
  const step = progress.steps.find((item) => item.id === id);
  assert.ok(step, `step ${id} is missing from the overview`);
  return step;
}

test('Story Studio progress reports each step from the work itself, owner only', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-modules-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(workDir, { PORT: String(port) });
  const request = makeRequest(base);

  t.after(async () => {
    await stopServer(child);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  await waitForHealth(base);
  const cookie = await register(request, 'studio_owner');
  const otherCookie = await register(request, 'studio_other');

  let result = await request('/api/projects', {
    method: 'POST',
    cookie,
    body: { title: 'Lantern street', idea: '', stage: 'Idea Stage' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const project = result.data.project;

  // An empty story: every step is still to do, and the first step is the next action.
  result = await request(`/api/studio/${project.id}/progress`, { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const progress = result.data;
  assert.equal(progress.project.id, project.id);
  assert.equal(progress.project.title, 'Lantern street');
  assert.deepEqual(progress.steps.map((step) => step.id), STEP_ORDER);
  progress.steps.forEach((step, index) => {
    assert.ok(step.label, `step ${step.id} needs a label`);
    assert.ok(step.screen, `step ${step.id} needs a screen to open`);
    assert.ok(['done', 'attention', 'todo'].includes(step.status), `unexpected status ${step.status}`);
    assert.ok(step.detail, `step ${step.id} needs a detail line`);
    assert.ok(step.action, `step ${step.id} needs an action line`);
    assert.equal(step.screen, `studio-${step.id}`, `step ${step.id} should open its own screen`);
  });
  assert.equal(new Set(progress.steps.map((step) => step.label)).size, 6, 'step labels must be distinct');
  assert.equal(progress.counts.total, 6);
  assert.equal(progress.counts.done, 0);
  assert.equal(progress.counts.todo, 6);
  assert.equal(progress.counts.attention, 0);
  assert.equal(progress.next.stepId, 'idea');
  assert.equal(progress.next.screen, 'studio-idea');

  // Writing the idea finishes step 1 and moves the next action on.
  result = await request(`/api/projects/${project.id}`, {
    method: 'PUT',
    cookie,
    body: { idea: 'A lamplighter finds a street that only exists at night.' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request(`/api/studio/${project.id}/progress`, { cookie });
  assert.equal(result.status, 200);
  assert.equal(stepOf(result.data, 'idea').status, 'done');
  assert.equal(result.data.counts.done, 1);
  assert.equal(result.data.next.stepId, 'references');
  assert.equal(result.data.next.screen, 'studio-references');

  // Reference material plus character references finish step 2.
  result = await request(`/api/projects/${project.id}`, {
    method: 'PUT',
    cookie,
    body: {
      referenceMaterial: 'Gaslit cobbles, wet air, amber light, 1930s coats.',
      characterReferences: [{
        name: 'Ava',
        gender: 'Female',
        referenceMaterial: 'short red hair and freckles, blue jacket, silver pendant',
      }],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  result = await request(`/api/studio/${project.id}/progress`, { cookie });
  assert.equal(result.status, 200);
  assert.equal(stepOf(result.data, 'references').status, 'done');
  assert.equal(result.data.next.stepId, 'cast');

  // An unapproved character is a decision waiting, not work in progress.
  result = await request(`/api/story/${project.id}/characters`, {
    method: 'POST',
    cookie,
    body: { name: 'Ava', gender: 'Female' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const character = result.data.character;
  // The overview lives under /api/studio/; the story path does not serve it.
  result = await request(`/api/story/${project.id}/progress`, { cookie });
  assert.notEqual(result.status, 200, 'the overview must not be served under /api/story/');

  result = await request(`/api/studio/${project.id}/progress`, { cookie });
  assert.equal(result.status, 200);
  const castWaiting = stepOf(result.data, 'cast');
  assert.equal(castWaiting.status, 'attention');
  // Every bible materialised from the project's character references is
  // unapproved until a human approves it, so the count is not fixed here.
  assert.match(castWaiting.detail, /[1-9]\d* waiting for approval/);
  assert.match(castWaiting.action, /^Approve \d+ character/);
  assert.equal(result.data.counts.attention, 1);
  // The next action stays on the step that needs the decision.
  assert.equal(result.data.next.stepId, 'cast');

  result = await request(`/api/story/${project.id}/locations`, {
    method: 'POST',
    cookie,
    body: { name: 'Farmhouse kitchen', description: 'A low beamed room.', lighting: 'Amber lamplight.' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const location = result.data.location;

  // Approving the cast by hand finishes the step.
  result = await request(`/api/story/${project.id}`, { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const beforeApproval = result.data.story;
  assert.ok(beforeApproval.characters.length >= 1, 'the cast should exist by now');
  assert.ok(beforeApproval.locations.length >= 1, 'the location should exist by now');
  assert.ok(beforeApproval.characters.every((item) => item.approved === false));
  for (const item of beforeApproval.characters) {
    result = await request(`/api/story/characters/${item.id}`, {
      method: 'PUT',
      cookie,
      body: { approved: true },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  for (const item of beforeApproval.locations) {
    result = await request(`/api/story/locations/${item.id}`, {
      method: 'PUT',
      cookie,
      body: { approved: true },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  assert.ok(character.id, 'the created character should have an id');

  result = await request(`/api/studio/${project.id}/progress`, { cookie });
  assert.equal(result.status, 200);
  assert.equal(stepOf(result.data, 'cast').status, 'done');
  assert.equal(result.data.counts.attention, 0);
  assert.equal(result.data.next.stepId, 'scenes');

  // Later steps report honestly while they are untouched.
  assert.equal(stepOf(result.data, 'scenes').status, 'todo');
  assert.equal(stepOf(result.data, 'generate').status, 'todo');
  assert.match(stepOf(result.data, 'generate').detail, /No image prompts built yet/);
  assert.equal(stepOf(result.data, 'review').status, 'todo');
  assert.equal(
    result.data.counts.done + result.data.counts.attention + result.data.counts.todo,
    result.data.counts.total
  );

  // Isolation: another account cannot read this story's overview.
  result = await request(`/api/studio/${project.id}/progress`, { cookie: otherCookie });
  assert.equal(result.status, 404);
  result = await request('/api/studio/does-not-exist/progress', { cookie });
  assert.equal(result.status, 404);
  result = await request(`/api/studio/${project.id}/progress`);
  assert.equal(result.status, 401);
  result = await request(`/api/studio/${project.id}/progress`, { method: 'POST', cookie });
  assert.equal(result.status, 405);
});

test('Carnival module navigation contract holds', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

  // The flat tab bar is gone; the umbrella has modules and shared services.
  assert.doesNotMatch(html, /data-tab="/, 'the old flat tab bar should be replaced');
  ['module-bar', 'module-list', 'header-shared', 'module-nav', 'module-subnav', 'module-context',
    'studio-story', 'studio-progress', 'studio-next-action', 'studio-progress-detail']
    .forEach((id) => assert.ok(html.includes(`id="${id}"`), `missing #${id}`));

  // Story Studio's steps and the Review panel exist, and the prompt review
  // card moved out of Generate and into Review.
  assert.ok(html.includes('id="panel-studio-review"'));
  ['idea', 'cast', 'scenes'].forEach((step) => {
    assert.ok(html.includes(`data-story-step="${step}"`), `no card is marked for the ${step} step`);
  });
  const reviewPanelStart = html.indexOf('id="panel-studio-review"');
  const libraryPanelStart = html.indexOf('id="panel-library"');
  const generationPanelStart = html.indexOf('id="panel-generation"');
  const reviewCardAt = html.indexOf('id="gen-review-card"');
  assert.ok(reviewPanelStart > -1 && libraryPanelStart > -1 && generationPanelStart > -1 && reviewCardAt > -1);
  assert.equal((html.match(/id="gen-review-card"/g) || []).length, 1);
  // The review card sits inside the Review step: after Review starts, before the
  // Library panel begins.
  assert.ok(reviewCardAt > reviewPanelStart && reviewCardAt < libraryPanelStart,
    'the prompt review card should live inside the Review step');

  // Generate keeps three numbered steps once review has its own step.
  assert.ok(html.includes('1 · References'));
  assert.ok(html.includes('2 · Image prompts'));
  assert.ok(html.includes('3 · Image generation'));
  assert.doesNotMatch(html, /4 · Image generation/);

  // Every screen in the registry must point at a panel switchTab can activate,
  // and every Story Studio step must point at a screen that exists.
  const panelsBlock = app.match(/const panels = \{([\s\S]*?)\};/);
  assert.ok(panelsBlock, 'switchTab() must still define its panel map');
  const panelKeys = new Set(
    [...panelsBlock[1].matchAll(/'?([a-z-]+)'?:\s*'[^']+'/g)].map((match) => match[1])
  );
  const screenTabs = [...app.matchAll(/\{\s*id: '([a-z-]+)',[^}]*?tab: '([a-z-]+)'/g)]
    .map((match) => ({ id: match[1], tab: match[2] }));
  assert.ok(screenTabs.length >= 9, 'the module registry should declare every screen');
  screenTabs.forEach(({ id, tab }) => {
    assert.ok(panelKeys.has(tab), `screen ${id} points at panel key ${tab}, which switchTab does not activate`);
  });

  const stepMap = app.match(/const STUDIO_STEP_SCREENS = \{([\s\S]*?)\};/);
  assert.ok(stepMap, 'the step-to-screen map is missing');
  const mapped = [...stepMap[1].matchAll(/([a-z]+):\s*'([a-z-]+)'/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(mapped.map(([step]) => step), STEP_ORDER);
  mapped.forEach(([, screenId]) => {
    assert.ok(screenTabs.some((screen) => screen.id === screenId), `step screen ${screenId} is not in the registry`);
  });

  // Live panels are named for their module screen. The Projects stage tabs and
// the long-form Docs keep the project lifecycle stage names, which are a
// different thing from the Story Studio steps.
  const liveHtml = html.slice(0, html.indexOf('id="panel-docs"'));
  assert.doesNotMatch(liveHtml, /card-title">Generation Stage</, 'the Generate panel should use the step wording');
  assert.doesNotMatch(liveHtml, /card-title">Story Workspace</, 'the story panel heading follows the active step');
  assert.doesNotMatch(liveHtml, /card-title">Character maker</, 'the Character Maker panel should use the module wording');
  assert.doesNotMatch(liveHtml, /card-title">Project characters</, 'the cast panel should use the module wording');
  assert.ok(html.includes('id="story-head-title"'), 'the story heading must be settable per step');
  assert.ok(app.includes('function renderStoryStepHead('), 'the story heading must follow the active step');
  assert.ok(app.includes('renderStoryStepHead();'), 'the step change must refresh the heading');
  assert.ok(html.includes('>Character Maker<'), 'the Character Maker panel should use the module wording');
  assert.ok(html.includes('>Character images<'), 'the project cast panel should use the module wording');
  assert.doesNotMatch(html, /Open Project Management/, 'buttons should use the module wording');
  assert.doesNotMatch(html, /Open Story workspace/, 'buttons should use the module wording');

  // CarniChat is the sidebar assistant, and its opening line belongs to the
  // module that is open.
  assert.ok(html.includes('<h2 class="sidebar-title">CarniChat</h2>'), 'the sidebar chat is named CarniChat');
  assert.ok(html.includes('CarniChat is typing…'), 'the typing indicator should say CarniChat');
  assert.ok(html.includes('placeholder="Ask CarniChat…"'), 'the chat input should say CarniChat');
  assert.doesNotMatch(html, /DeepSeek Chat/, 'the old chat heading should be gone');
  assert.doesNotMatch(html, /Ask DeepSeek/, 'the old placeholder should be gone');
  assert.ok(app.includes('function carniChatEmptyHint('), 'the chat needs its module-aware opening line');
  const chatHints = [...app.matchAll(/chatHint: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(chatHints.length, 2, 'every module needs its own CarniChat opening line');
  chatHints.forEach((hint) => assert.match(hint, /CarniChat/));
  assert.ok(app.includes("'Could not reach CarniChat.'"), 'chat failures should name CarniChat');

  // The modules, their guidance, and the wiring are all present.
  ['story-studio', 'generate-images'].forEach((id) => {
    assert.ok(app.includes(`id: '${id}'`), `module ${id} is missing from the registry`);
  });
  assert.doesNotMatch(app, /character-images/, 'the old module id should be gone');
  const moduleEntries = [...app.matchAll(/id: '(story-studio|generate-images)',[\s\S]*?tagline: '[^']*',\s*guide: '([^']+)'/g)];
  assert.equal(moduleEntries.length, 2, 'every module needs its own assistant guidance');
  moduleEntries.forEach(([, id, guide]) => {
    assert.ok(guide.length > 40, `module ${id} needs meaningful assistant guidance`);
  });
  ['switchScreen', 'initModuleNavigation', 'renderModuleBar', 'renderModuleNav', 'renderStudioProgress',
    'loadStudioProgress', 'applyStoryStep', 'applyLibraryModuleDefault', 'setStudioStory', 'resetStudio']
    .forEach((name) => assert.ok(app.includes(`function ${name}(`), `missing ${name}()`));
  assert.ok(app.includes('/api/studio/'), 'the overview must load from the progress endpoint');
  assert.ok(app.includes('initModuleNavigation();'), 'the navigation must be initialised on boot');
  assert.ok(app.includes('resetStudio();'), 'the navigation must reset when the session ends');
  assert.doesNotMatch(app, /\$\$\('\.tab'\)/, 'the removed tab bar must not still be wired');
  assert.ok(app.includes('module: mode === \'reviewer\' ? \'\' : state.ui.module'),
    'the assistant must be told which module the user is in');

  // The server scopes the Guide per module, without replacing the user's context.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const guidance = server.match(/const MODULE_GUIDANCE = \{([\s\S]*?)\};/);
  assert.ok(guidance, 'the server needs module guidance for the assistant');
  ['story-studio', 'generate-images'].forEach((id) => {
    assert.ok(guidance[1].includes(`'${id}':`), `the server has no guidance for ${id}`);
  });
  assert.ok(server.includes("moduleId ? MODULE_GUIDANCE[moduleId] : ''"),
    'module guidance must be added to the chat system prompt');
  assert.ok(server.includes("body.module === 'string' && MODULE_GUIDANCE[body.module]"),
    'only known modules may add guidance');

  // Generate belongs to the header and opens the module navigation.
  assert.ok(html.includes('id="header-shared"'), 'the header needs the shared tools container');
  assert.ok(!html.includes('id="module-actions"'), 'the old image shortcut should be removed');
  assert.ok(!html.includes('id="module-shared"'), 'the shared tools should no longer sit in the module bar');
  const headerAt = html.indexOf('id="header-shared"');
  const moduleBarAt = html.indexOf('id="module-bar"');
  assert.ok(headerAt > -1 && headerAt < moduleBarAt, 'shared tools render in the header above the module bar');
  assert.ok(!app.includes('const MODULE_ACTION ='), 'the old image shortcut should be removed');
  assert.ok(app.includes("generate.id = 'header-generate'"), 'Generate belongs in the header');
  assert.ok(app.includes("generate.setAttribute('aria-controls', 'module-bar module-nav-wrap')"),
    'Generate identifies the navigation it opens');
  assert.ok(app.includes("const shared = $('#header-shared');"), 'shared tools render into the header');
  assert.ok(app.includes("$('#header-shared').addEventListener('click'"), 'the header needs its own shared-tool handler');

  // Styles for the new navigation, and none left for the removed tab bar.
  ['.module-bar', '.module-button', '.module-nav-button', '.module-tool', '.module-progress',
    '.progress-step-list', '.module-view-button', '.review-needs-list', '.header-shared']
    .forEach((selector) => assert.ok(css.includes(selector), `missing ${selector} styles`));
  assert.doesNotMatch(css, /^\.module-shared \{/m, 'the removed shared-bar styles should be gone');
  assert.doesNotMatch(css, /^\.tab \{/m, 'the removed tab styles should be gone');
  assert.doesNotMatch(css, /^\.tabs \{/m, 'the removed tab styles should be gone');
});
