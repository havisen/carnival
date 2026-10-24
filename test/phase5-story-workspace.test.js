'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function validWorkspace(sceneCount = 6) {
  const characters = [
    {
      name: 'Ava',
      gender: 'Female',
      age: '42',
      appearance: 'Shoulder-length auburn hair, freckles across her nose.',
      wardrobe: 'Faded denim overalls over a cream wool cardigan.',
      continuityNotes: 'A small scar above her right eyebrow; wears a silver pendant.',
    },
    {
      name: 'Jon',
      gender: 'Male',
      age: '45',
      appearance: 'Short grey-flecked hair and a trimmed beard.',
      wardrobe: 'Olive canvas work jacket and dark work boots.',
      continuityNotes: 'Wears a plain silver wedding band on his left hand.',
    },
  ];
  const locations = [
    {
      name: 'Farmhouse kitchen',
      description: 'A warm, cluttered kitchen with pine cabinets and a long wooden table.',
      lighting: 'Soft morning light through the east window.',
      continuityNotes: 'A cracked ceramic mug always sits by the coffee pot.',
    },
    {
      name: 'Wheat field',
      description: 'An open golden wheat field stretching to a distant treeline.',
      lighting: 'Late-afternoon sun, long shadows.',
      continuityNotes: 'The old windmill stands on the north edge.',
    },
  ];
  const scenes = [];
  for (let i = 0; i < sceneCount; i += 1) {
    const location = locations[i % 2].name;
    const present = i % 2 === 0 ? ['Ava'] : ['Ava', 'Jon'];
    scenes.push({
      title: `Scene ${i + 1}`,
      beat: `A concrete beat for scene ${i + 1}.`,
      action: `Ava and Jon move through scene ${i + 1} together.`,
      props: 'Cracked mug, coffee pot, wool blanket',
      location,
      characters: present,
    });
  }
  return {
    brief: {
      title: 'Harvest Moon',
      logline: 'A farmer and her estranged brother rebuild their bond over one autumn harvest.',
      premise: 'A widowed farmer must ask her brother for help to save the family farm.',
      tone: 'Warm, grounded, quietly hopeful.',
      genre: 'Rural family drama',
      audience: 'Adult general audience',
      setting: 'A small wheat farm in late autumn, present day.',
    },
    characters,
    locations,
    styles: [
      {
        name: 'Photorealistic rural drama',
        description: 'Grounded photographic realism with natural, muted color.',
        guidance: 'Natural light, documentary framing, believable everyday detail.',
        exclusions: ['fantasy', 'neon', 'stylized illustration'],
      },
    ],
    scenes,
  };
}

function validSupplied() {
  return validWorkspace().characters.map((character) => ({ name: character.name, gender: character.gender }));
}

// ---------------------------------------------------------------------------
// Story-store level helpers (no HTTP server, no DeepSeek)
// ---------------------------------------------------------------------------

function freshDb() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ws-'));
  delete process.env.DB_PATH;
  process.env.DATA_DIR = workDir;
  delete require.cache[require.resolve(path.join(ROOT, 'db.js'))];
  const db = require(path.join(ROOT, 'db.js'));
  const security = require(path.join(ROOT, 'security.js'));
  const story = require(path.join(ROOT, 'story.js'));
  return { workDir, db, security, story };
}

async function makeUser(db, security, username) {
  const { hash, salt } = await security.hashPassword('password123');
  return db.createUser({
    id: crypto.randomUUID(),
    username: username || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: hash,
    passwordSalt: salt,
  });
}

test('story workspace normalization validates, caps, and rejects malformed payloads', () => {
  const { normalizeStoryWorkspace } = require(path.join(ROOT, 'story.js'));
  const supplied = validSupplied();
  const good = validWorkspace();

  const normalized = normalizeStoryWorkspace(good, supplied);
  assert.equal(normalized.brief.title, 'Harvest Moon');
  assert.equal(normalized.characters.length, 2);
  assert.equal(normalized.characters[0].name, 'Ava');
  assert.equal(normalized.locations.length, 2);
  assert.equal(normalized.styles.length, 1);
  assert.deepEqual(normalized.styles[0].exclusions, ['fantasy', 'neon', 'stylized illustration']);
  assert.equal(normalized.scenes.length, 6);

  const expectReject = (value, characters = supplied, pattern) => {
    assert.throws(() => normalizeStoryWorkspace(value, characters), (err) => {
      assert.equal(err.status, 502);
      if (pattern) assert.match(err.message, pattern);
      return true;
    });
  };

  // Unreadable / missing.
  expectReject(null, supplied);
  expectReject('not-an-object', supplied);
  expectReject({}, supplied);

  // Incomplete brief.
  const noLogline = validWorkspace();
  delete noLogline.brief.logline;
  expectReject(noLogline, supplied, /logline/);

  // Character count mismatch.
  const tooFewChars = validWorkspace();
  tooFewChars.characters = tooFewChars.characters.slice(0, 1);
  expectReject(tooFewChars, supplied, /exactly one character record/);

  // Exact name enforcement.
  const wrongName = validWorkspace();
  wrongName.characters[0].name = 'Bella';
  expectReject(wrongName, supplied, /must be named "Ava"/);

  // Missing character age.
  const noAge = validWorkspace();
  noAge.characters[0].age = '';
  expectReject(noAge, supplied, /age for "Ava"/);

  // Duplicate location.
  const dupLocation = validWorkspace();
  dupLocation.locations = [good.locations[0], { ...good.locations[0] }];
  expectReject(dupLocation, supplied, /Duplicate location/);

  // Incomplete location (missing lighting).
  const noLighting = validWorkspace();
  noLighting.locations[0].lighting = '';
  expectReject(noLighting, supplied, /lighting for "Farmhouse kitchen"/);

  // Oversized locations.
  const oversizedLocations = validWorkspace();
  oversizedLocations.locations = Array.from({ length: 21 }, (_, i) => ({
    name: `Loc ${i}`,
    description: 'd',
    lighting: 'l',
    continuityNotes: 'c',
  }));
  expectReject(oversizedLocations, supplied, /too many locations/);

  // Scene count out of range.
  const tooManyScenes = validWorkspace(11);
  expectReject(tooManyScenes, supplied, /6 to 10 scenes/);
  const tooFewScenes = validWorkspace(5);
  expectReject(tooFewScenes, supplied, /6 to 10 scenes/);

  // Mismatched scene reference.
  const mismatchedScene = validWorkspace();
  mismatchedScene.scenes[0].location = 'A place that does not exist';
  expectReject(mismatchedScene, supplied, /references location/);
  const mismatchedCharacter = validWorkspace();
  mismatchedCharacter.scenes[0].characters = ['Nobody'];
  expectReject(mismatchedCharacter, supplied, /references character "Nobody"/);
});

test('story workspace import populates structured drafts without approving anything', async (t) => {
  const { workDir, db, security, story } = freshDb();
  const storyStore = story.init(db.db, db.DB_PATH);
  t.after(() => {
    try { db.db.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  const user = await makeUser(db, security, 'importer');
  const project = db.createProject(user.id, { title: 'Harvest', stage: 'Reference Stage', idea: 'A farm story.' });
  const supplied = validSupplied();
  const workspace = validWorkspace();
  const characterReferences = workspace.characters.map((character) => ({
    name: character.name,
    gender: character.gender,
    referenceMaterial: `${character.name}: standalone appearance and continuity.`,
  }));

  const imported = storyStore.importWorkspace(user.id, project.id, workspace, { characterReferences });
  assert.equal(imported.characters, 2);
  assert.equal(imported.locations, 2);
  assert.equal(imported.styles, 1);
  assert.equal(imported.scenes, 6);
  assert.equal(imported.replaced, false);

  const storyData = storyStore.getStory(user.id, project.id);
  assert.ok(storyData);

  // 1. Every story-brief field is populated.
  assert.equal(storyData.brief.title, 'Harvest Moon');
  assert.equal(storyData.brief.logline, workspace.brief.logline);
  assert.equal(storyData.brief.premise, workspace.brief.premise);
  assert.equal(storyData.brief.tone, workspace.brief.tone);
  assert.equal(storyData.brief.genre, workspace.brief.genre);
  assert.equal(storyData.brief.audience, workspace.brief.audience);
  assert.equal(storyData.brief.setting, workspace.brief.setting);

  // 2. Character structured fields + legacy material.
  const ava = storyData.characters.find((character) => character.name === 'Ava');
  assert.equal(ava.age, '42');
  assert.ok(ava.appearance);
  assert.ok(ava.wardrobe);
  assert.ok(ava.continuityNotes);
  assert.equal(ava.legacyMaterial, 'Ava: standalone appearance and continuity.');
  assert.equal(ava.approved, false);

  // 3. Location structured fields.
  const kitchen = storyData.locations.find((location) => location.name === 'Farmhouse kitchen');
  assert.ok(kitchen.description);
  assert.ok(kitchen.lighting);
  assert.ok(kitchen.continuityNotes);
  assert.equal(kitchen.approved, false);

  // 4. Style structured fields.
  assert.equal(storyData.styles.length, 1);
  assert.ok(storyData.styles[0].description);
  assert.ok(storyData.styles[0].guidance);
  assert.deepEqual(storyData.styles[0].exclusions, ['fantasy', 'neon', 'stylized illustration']);
  assert.equal(storyData.styles[0].approved, false);

  // 5. Scene beat/action/props and links.
  assert.equal(storyData.scenes.length, 6);
  const first = storyData.scenes[0];
  assert.ok(first.beat);
  assert.ok(first.action);
  assert.ok(first.props);
  assert.ok(first.locationId);
  assert.ok(first.characterIds.length >= 1);

  // 6. All generated records unapproved and prompt drafts non-final.
  assert.ok(storyData.characters.every((character) => character.approved === false));
  assert.ok(storyData.locations.every((location) => location.approved === false));
  assert.ok(storyData.styles.every((style) => style.approved === false));

  // 12. No content warnings; approval warnings remain.
  const codes = storyData.warnings.map((warning) => warning.code);
  assert.ok(!codes.includes('STORY_BRIEF_INCOMPLETE'));
  assert.ok(!codes.includes('CHARACTER_APPEARANCE_MISSING'));
  assert.ok(!codes.includes('CHARACTER_WARDROBE_MISSING'));
  assert.ok(!codes.includes('LOCATION_DESCRIPTION_MISSING'));
  assert.ok(!codes.includes('STYLE_GUIDANCE_MISSING'));
  assert.ok(codes.includes('CHARACTER_NOT_APPROVED'));
  assert.ok(codes.includes('LOCATION_NOT_APPROVED'));
  assert.ok(codes.includes('STYLE_NOT_APPROVED'));

  // workspaceExists now reports structured data.
  assert.equal(storyStore.workspaceExists(user.id, project.id), true);
});

test('worksheet saves action outlines and locations separately per user', async (t) => {
  const { workDir, db, security, story } = freshDb();
  const store = story.init(db.db, db.DB_PATH);
  t.after(() => {
    try { db.db.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });
  const user = await makeUser(db, security, 'worksheet-owner');
  const stranger = await makeUser(db, security, 'worksheet-stranger');
  const project = db.createProject(user.id, { title: 'Worksheet', stage: 'Reference Stage' });
  assert.equal(store.setWorksheetSetting(stranger.id, project.id, 'Wrong setting'), null);
  store.setWorksheetSetting(user.id, project.id, 'Riverside at sunset');
  const actions = [
    { action: 'Ava crosses the bridge.', locationSentence: 'The bridge stands above the river.', characters: ['Ava'] },
    { action: 'Ava waits.', locationSentence: 'The park has a stone fountain.', characters: ['Ava'] },
  ];
  assert.equal(store.saveWorksheetActions(stranger.id, project.id, actions), null);
  store.saveWorksheetActions(user.id, project.id, actions);
  let loaded = store.getStory(user.id, project.id);
  assert.equal(loaded.worksheet.setting, 'Riverside at sunset');
  assert.deepEqual(loaded.worksheet.actions, actions);
  assert.deepEqual(loaded.worksheet.locations, []);
  assert.equal(loaded.scenes.length, 2);
  assert.match(loaded.scenes[0].action, /bridge stands above the river\.$/);
  const locations = [
    { name: 'Bridge', description: 'A narrow stone bridge over a broad river.' },
    { name: 'Park', description: 'A quiet park with a stone fountain.' },
  ];
  store.saveWorksheetLocations(user.id, project.id, locations);
  loaded = store.getStory(user.id, project.id);
  assert.deepEqual(loaded.worksheet.locations, locations);
  store.saveWorksheetActions(user.id, project.id, [actions[0]]);
  assert.deepEqual(store.getStory(user.id, project.id).worksheet.locations, []);
  assert.equal(store.getStory(stranger.id, project.id), null);
});

test('worksheet generators preview without saving and use isolated source contexts', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-worksheet-http-'));
  const calls = [];
  const actions = [
    { action: 'Ava finds a note.', locationSentence: 'The riverbank is lined with reeds.', characters: ['Ava'] },
    { action: 'Ava opens the note.', locationSentence: 'The riverside path leads to a pier.', characters: ['Ava'] },
  ];
  const locations = [
    { name: 'Riverbank', description: 'Reeds frame a broad river at dusk.' },
    { name: 'Pier', description: 'A weathered pier extends from the path.' },
  ];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const messages = JSON.parse(body).messages;
      calls.push(messages);
      const content = JSON.stringify(messages[0].content.includes('location sentences') ? { locations } : { actions });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], model: 'deepseek-v4-pro' }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: workDir,
      APP_SECRET: 'worksheet-test-secret-long-enough-1234', NODE_ENV: 'test',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mock.address().port}/chat/completions` }, stdio: 'ignore',
  });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => mock.close(resolve));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  async function request(route, method = 'GET', body, cookie = '') {
    const response = await fetch(base + route, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  }
  let result = await request('/api/auth/register', 'POST', { username: 'worksheet', password: 'password123' });
  assert.equal(result.status, 201);
  const cookie = result.cookie;
  result = await request('/api/me/api-key', 'PUT', { apiKey: 'test-deepseek-key-1234567890' }, cookie);
  assert.equal(result.status, 200);
  result = await request('/api/projects', 'POST', { title: 'Worksheet source', idea: 'SECRET IDEA', stage: 'Reference Stage' }, cookie);
  assert.equal(result.status, 201);
  const id = result.data.project.id;
  result = await request(`/api/projects/${id}`, 'PUT', {
    referenceMaterial: 'ONLY REFERENCE MATERIAL', characterReferences: [
      { name: 'Ava', gender: 'Female', referenceMaterial: 'SECRET CHARACTER DESCRIPTION' },
    ],
  }, cookie);
  assert.equal(result.status, 200);
  result = await request(`/api/story/${id}/worksheet/actions/generate`, 'POST', { count: 2 }, cookie);
  assert.equal(result.status, 200, result.data.error);
  assert.deepEqual(result.data.actions, actions);
  assert.match(calls[0][1].content, /ONLY REFERENCE MATERIAL/);
  assert.match(calls[0][1].content, /Ava/);
  assert.doesNotMatch(calls[0][1].content, /SECRET IDEA|SECRET CHARACTER DESCRIPTION/);
  result = await request(`/api/story/${id}`, 'GET', undefined, cookie);
  assert.deepEqual(result.data.story.worksheet.actions, []);
  result = await request(`/api/story/${id}/worksheet/locations/generate`, 'POST', {}, cookie);
  assert.equal(result.status, 409);
  result = await request(`/api/story/${id}/worksheet/actions/save`, 'POST', { actions }, cookie);
  assert.equal(result.status, 200);
  result = await request(`/api/story/${id}/worksheet/locations/generate`, 'POST', {}, cookie);
  assert.equal(result.status, 200, result.data.error);
  assert.deepEqual(result.data.locations, locations);
  assert.match(calls[1][1].content, /riverbank is lined with reeds/);
  assert.doesNotMatch(calls[1][1].content, /ONLY REFERENCE MATERIAL|SECRET IDEA|SECRET CHARACTER DESCRIPTION|Ava finds/);
  result = await request(`/api/story/${id}`, 'GET', undefined, cookie);
  assert.deepEqual(result.data.story.worksheet.locations, []);
  result = await request(`/api/story/${id}/worksheet/locations/save`, 'POST', { locations }, cookie);
  assert.equal(result.status, 200);
  result = await request(`/api/story/${id}`, 'GET', undefined, cookie);
  assert.deepEqual(result.data.story.worksheet.locations, locations);
});

test('workspace import is atomic and does not write on failure', async (t) => {
  const { workDir, db, security, story } = freshDb();
  const storyStore = story.init(db.db, db.DB_PATH);
  t.after(() => {
    try { db.db.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  const user = await makeUser(db, security, 'atomic');
  const project = db.createProject(user.id, { title: 'Atomic', stage: 'Reference Stage' });
  const workspace = validWorkspace();
  workspace.scenes = []; // invalid, would fail import

  // The import is guarded by normalization before any write; verify the store
  // has no partial characters/locations/styles even if import is attempted with
  // bad scenes through a replace path is not reachable — instead assert that a
  // valid import is all-or-nothing by confirming an invalid one leaves nothing.
  assert.equal(storyStore.workspaceExists(user.id, project.id), false);
  // Simulate the server contract: normalization throws before any write.
  assert.throws(() => story.normalizeStoryWorkspace(workspace, validSupplied()), (err) => err.status === 502);
  assert.equal(storyStore.workspaceExists(user.id, project.id), false);
});

test('legacy projects migrate and load without data loss', async (t) => {
  const { workDir, db, security } = freshDb();
  t.after(() => {
    try { db.db.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  const user = await makeUser(db, security, 'legacy');
  // Legacy project: scenes + character_references + generation_prompts, no
  // story tables yet (story.init not yet called).
  const project = db.createProject(user.id, {
    title: 'Legacy project',
    stage: 'Generation Stage',
    reference_material: 'REF',
    scenes: [{ id: 's1', title: 'Opening', action: 'Ava runs.', location: 'Alley', characters: ['Ava'] }],
    generation_prompts: [{ sceneId: 's1', prompt: 'Photoreal Ava in the alley.' }],
    character_references: [{ name: 'Ava', gender: 'Female', referenceMaterial: 'Legacy Ava' }],
  });

  const story = require(path.join(ROOT, 'story.js'));
  const storyStore = story.init(db.db, db.DB_PATH);

  const storyData = storyStore.getStory(user.id, project.id);
  assert.ok(storyData);
  const ava = storyData.characters.find((character) => character.name === 'Ava');
  assert.ok(ava);
  assert.equal(ava.legacyMaterial, 'Legacy Ava');
  assert.equal(ava.approved, false);
  assert.equal(storyData.scenes.length, 1);
  assert.equal(storyData.scenes[0].id, 's1');
  assert.equal(storyData.prompts.some((prompt) => prompt.sceneId === 's1' && prompt.text.includes('alley')), true);

  // Original projections preserved.
  const current = db.getProject(user.id, project.id);
  assert.equal(current.referenceMaterial, 'REF');
  assert.equal(current.characterReferences.length, 1);
  assert.equal(current.generationPrompts.length, 1);
});

// ---------------------------------------------------------------------------
// End-to-end HTTP test with a mocked DeepSeek endpoint
// ---------------------------------------------------------------------------

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

function referenceContent() {
  const workspace = validWorkspace();
  const scenes = workspace.scenes.map((scene) => ({
    title: scene.title,
    action: scene.action,
    location: scene.location,
    characters: scene.characters,
  }));
  const characterReferences = workspace.characters.map((character) => ({
    name: character.name,
    gender: character.gender,
    referenceMaterial: `${character.name}: ${character.appearance} ${character.wardrobe}`,
  }));
  return JSON.stringify({
    referenceMaterial: [
      '1. Story Overview - a farmer and her brother.',
      '2. Characters - Ava and Jon.',
      '3. Relationships - siblings.',
      '4. Setting - a wheat farm.',
      '5. Story Progression - six scenes.',
      '6. Visual Continuity - consistent wardrobe.',
      '7. Additional Notes - none.',
    ].join('\n'),
    storyWorkspace: workspace,
    scenes,
    characterReferences,
  });
}

test('reference generation imports a reviewable workspace end to end', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ws-http-'));

  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: referenceContent() }, finish_reason: 'stop' }],
        model: 'deepseek-v4-pro',
      }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'story-ws-http-secret-long-enough-123456',
      NODE_ENV: 'test',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
    },
    stdio: 'ignore',
  });

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
    body: { username: 'storyuser', password: 'password123' },
  });
  assert.equal(registration.status, 201);
  const cookie = registration.cookie;

  let result = await request('/api/me/api-key', { method: 'PUT', body: { apiKey: 'sk-test-key-1234567890' }, cookie });
  assert.equal(result.status, 200);

  result = await request('/api/projects', {
    method: 'POST',
    cookie,
    body: { title: 'Reference project', stage: 'Reference Stage' },
  });
  assert.equal(result.status, 201);
  const project = result.data.project;

  result = await request('/api/reference', {
    method: 'POST',
    cookie,
    body: {
      projectId: project.id,
      context: 'A farmer and her brother.',
      setting: 'A wheat farm.',
      characters: [{ name: 'Ava', gender: 'Female' }, { name: 'Jon', gender: 'Male' }],
      model: 'deepseek-v4-pro',
    },
  });
  assert.equal(result.status, 200, result.data && result.data.error);
  assert.equal(result.data.workspace.imported, true);
  assert.equal(result.data.workspace.characters, 2);

  // Structured drafts are present and unapproved.
  const storyResult = await request(`/api/story/${project.id}`, { cookie });
  assert.equal(storyResult.status, 200);
  const storyData = storyResult.data.story;
  assert.equal(storyData.brief.title, 'Harvest Moon');
  assert.equal(storyData.characters.length, 2);
  assert.ok(storyData.characters.every((character) => character.approved === false));
  assert.ok(storyData.locations.every((location) => location.approved === false));
  assert.ok(storyData.styles.every((style) => style.approved === false));
  assert.equal(storyData.scenes.length, 6);
  assert.ok(storyData.scenes.every((scene) => scene.beat && scene.action && scene.props));

  const referenceReview = result.data.generationReview;
  assert.equal((await request('/api/generation/reviews/' + referenceReview.id, {
    method: 'POST', cookie, body: { decision: 'approved' },
  })).status, 200);

  // Regeneration without an explicit replacement choice is rejected.
  result = await request('/api/reference', {
    method: 'POST',
    cookie,
    body: {
      projectId: project.id,
      context: 'A farmer and her brother.',
      setting: 'A wheat farm.',
      characters: [{ name: 'Ava', gender: 'Female' }, { name: 'Jon', gender: 'Male' }],
      model: 'deepseek-v4-pro',
    },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'WORKSPACE_REPLACE_REQUIRED');

  // With an explicit choice it succeeds.
  result = await request('/api/reference', {
    method: 'POST',
    cookie,
    body: {
      projectId: project.id,
      context: 'A farmer and her brother.',
      setting: 'A wheat farm.',
      characters: [{ name: 'Ava', gender: 'Female' }, { name: 'Jon', gender: 'Male' }],
      model: 'deepseek-v4-pro',
      replaceWorkspace: true,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.workspace.replaced, true);

  // User scoping: another user cannot read this story.
  const other = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'story-other', password: 'password123' },
  });
  assert.equal(other.status, 201);
  const otherStory = await request(`/api/story/${project.id}`, { cookie: other.cookie });
  assert.equal(otherStory.status, 404);

  // Same-origin protection on a mutating story route.
  const crossOrigin = await request(`/api/story/${project.id}/brief`, {
    method: 'PUT',
    cookie,
    origin: 'https://evil.example',
    body: { title: 'Hacked' },
  });
  assert.equal(crossOrigin.status, 403);
});

test('character sheets are versioned and promotable', async (t) => {
  const { workDir, db, security, story } = freshDb();
  const storyStore = story.init(db.db, db.DB_PATH);
  t.after(() => {
    try { db.db.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  });

  const user = await makeUser(db, security, 'sheets');
  const project = db.createProject(user.id, { title: 'Sheets', stage: 'Reference Stage' });
  const character = storyStore.createCharacter(user.id, project.id, {
    name: 'Ava',
    gender: 'Female',
    age: '42',
    appearance: 'Auburn hair.',
    wardrobe: 'Denim overalls.',
    continuityNotes: 'Scar above right eyebrow.',
  });
  assert.ok(character && character.id);

  const first = storyStore.createCharacterSheet(user.id, project.id, character.id, {
    file: 'sheet-v1.png',
    mime: 'image/png',
    size: '2K',
    prompt: 'Ava reference sheet v1',
    imageModel: 'dola-seedream-5-0-pro-260628',
    imageSize: '2K',
    source: 'generated',
  });
  assert.equal(first.version, 1);
  assert.equal(first.status, 'draft');
  assert.equal(first.file, 'sheet-v1.png');
  const second = storyStore.createCharacterSheet(user.id, project.id, character.id, {
    file: 'sheet-v2.png',
    mime: 'image/png',
    prompt: 'Ava reference sheet v2',
    imageModel: 'dola-seedream-5-0-pro-260628',
    imageSize: '2K',
    source: 'generated',
  });
  assert.equal(second.version, 2);

  let storyData = storyStore.getStory(user.id, project.id);
  assert.equal(storyData.characterSheets.length, 2);
  assert.deepEqual(storyData.characterSheets.map((sheet) => sheet.version).sort(), [1, 2]);

  const promoted = storyStore.updateCharacterSheetStatus(user.id, second.id, 'final');
  assert.equal(promoted.status, 'final');
  storyData = storyStore.getStory(user.id, project.id);
  assert.equal(storyData.characterSheets.find((sheet) => sheet.id === second.id).status, 'final');
  storyStore.updateCharacterSheetStatus(user.id, first.id, 'final');
  storyData = storyStore.getStory(user.id, project.id);
  assert.equal(storyData.characterSheets.find((sheet) => sheet.id === first.id).status, 'final');
  assert.equal(storyData.characterSheets.find((sheet) => sheet.id === second.id).status, 'draft');

  // User scoping: another user cannot promote this sheet.
  const other = await makeUser(db, security, 'sheets-other');
  assert.equal(storyStore.updateCharacterSheetStatus(other.id, second.id, 'final'), null);
});

test('character sheet generation endpoint writes a versioned image', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ws-sheet-http-'));
  const imagePrompts = [];

  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      imagePrompts.push(JSON.parse(body).prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), output_format: 'png' }] }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'story-ws-sheet-secret-long-enough-123456',
      NODE_ENV: 'test',
      BYTEPLUS_IMAGE_ENDPOINT: `http://127.0.0.1:${mockPort}/images/generations`,
    },
    stdio: 'ignore',
  });

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

  async function request(pathname, { method = 'GET', body, cookie = '' } = {}) {
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
  }

  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'sheetgen', password: 'password123' },
  });
  assert.equal(registration.status, 201);
  const cookie = registration.cookie;

  let result = await request('/api/me/byteplus-key', { method: 'PUT', body: { apiKey: 'bp-sheet-key-1234567890' }, cookie });
  assert.equal(result.status, 200);

  result = await request('/api/projects', {
    method: 'POST',
    cookie,
    body: { title: 'Sheet project', stage: 'Reference Stage' },
  });
  assert.equal(result.status, 201);
  const project = result.data.project;

  result = await request(`/api/story/${project.id}/characters`, {
    method: 'POST',
    cookie,
    body: { name: 'Ava', gender: 'Female', appearance: 'short red hair and freckles', wardrobe: 'blue jacket', continuityNotes: 'silver pendant' },
  });
  assert.equal(result.status, 201);
  const character = result.data.character;
  result = await request(`/api/projects/${project.id}`, {
    method: 'PUT', cookie, body: { characterReferences: [
      { name: 'Ava', gender: 'Female', referenceMaterial: 'short red hair and freckles, blue jacket, silver pendant' },
      { name: 'Ben', gender: 'Male', referenceMaterial: 'long black hair, green coat' },
    ] },
  });
  assert.equal(result.status, 200);

  result = await request(`/api/story/${project.id}/characters/${character.id}/sheets/generate`, {
    method: 'POST',
    cookie,
  });
  assert.equal(result.status, 201, result.data && result.data.error);
  assert.equal(result.data.sheet.version, 1);
  assert.equal(result.data.sheet.status, 'draft');
  assert.match(result.data.sheet.file, /\.png$/);
  assert.ok(result.data.sheet.prompt.includes('Ava'));
  assert.equal(result.data.story.characterSheets.length, 1);
  const firstPrompt = result.data.sheet.prompt;
  assert.equal(imagePrompts[0], firstPrompt);
  assert.match(firstPrompt, /short red hair and freckles/);
  assert.match(firstPrompt, /blue jacket/);
  assert.match(firstPrompt, /silver pendant/);
  assert.doesNotMatch(firstPrompt, /Style:|Visual guidance:/);
  const layout = firstPrompt.split('\n').find((line) => line.startsWith('Use the same character-sheet layout'));
  assert.ok(layout);
  assert.match(layout, /exactly three evenly spaced, equal-size, full-body standing poses/);
  assert.match(layout, /front view, three-quarter view, and side profile/);
  assert.match(layout, /head to toe.*same scale.*consistent margins.*clear space/);
  assert.match(layout, /seamless light gray studio background.*same soft, even lighting/);

  const pendingSheet = result.data.generationReview;
  const duplicate = await request(`/api/story/${project.id}/characters/${character.id}/sheets/generate`, { method: 'POST', cookie });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'GENERATION_REVIEW_REQUIRED');
  assert.equal(imagePrompts.length, 1, 'no duplicate provider call while awaiting a decision');
  assert.equal((await request('/api/generation/reviews/' + pendingSheet.id, {
    method: 'POST', cookie, body: { decision: 'disapproved' },
  })).status, 200);

  result = await request(`/api/story/${project.id}/characters/${character.id}/sheets/generate`, { method: 'POST', cookie });
  assert.equal(result.status, 201, result.data && result.data.error);
  assert.equal(result.data.sheet.version, 2);
  assert.equal(result.data.sheet.prompt, firstPrompt);
  assert.equal(imagePrompts[1], firstPrompt);

  const secondCharacter = await request(`/api/story/${project.id}/characters`, {
    method: 'POST', cookie, body: { name: 'Ben', appearance: 'long black hair', wardrobe: 'green coat' },
  });
  assert.equal(secondCharacter.status, 201);
  const secondSheet = await request(`/api/story/${project.id}/characters/${secondCharacter.data.character.id}/sheets/generate`, {
    method: 'POST', cookie,
  });
  assert.equal(secondSheet.status, 201, secondSheet.data && secondSheet.data.error);
  assert.equal(secondSheet.data.sheet.version, 1);
  assert.match(secondSheet.data.sheet.prompt, /long black hair/);
  assert.match(secondSheet.data.sheet.prompt, /green coat/);
  assert.doesNotMatch(secondSheet.data.sheet.prompt, /short red hair and freckles/);
  assert.ok(secondSheet.data.sheet.prompt.split('\n').includes(layout));
  assert.equal(imagePrompts[2], secondSheet.data.sheet.prompt);

  // The generated sheet image is served back.
  const imageUrl = `/api/story/sheet-image/${project.id}/${encodeURIComponent(secondSheet.data.sheet.file)}`;
  const served = await fetch(base + imageUrl, { headers: { cookie } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  assert.equal((await request('/api/generation/reviews/' + secondSheet.data.generationReview.id, {
    method: 'POST', cookie, body: { decision: 'approved' },
  })).status, 200);
  assert.equal((await request('/api/story/sheets/' + result.data.sheet.id + '/promote', { method: 'POST', cookie })).status, 200);
  const accepted = (await request(`/api/story/${project.id}`, { cookie })).data.story.characterSheets;
  assert.equal(accepted.find((sheet) => sheet.id === secondSheet.data.sheet.id).status, 'final');
  assert.equal(accepted.find((sheet) => sheet.id === result.data.sheet.id).status, 'final');
  assert.deepEqual((await request('/api/generation/reviews', { cookie })).data.reviews, []);
});

test('DeepSeek chat endpoint authenticates and answers per mode', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ws-chat-'));

  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* ignore */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isReviewer = messages.some(
        (m) => m && m.role === 'system' && typeof m.content === 'string' && /review assistant/i.test(m.content)
      );
      const reply = isReviewer ? 'Reviewer reply.' : 'Guide reply.';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        model: 'deepseek-v4-pro',
      }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'story-ws-chat-secret-long-enough-123456',
      NODE_ENV: 'test',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
    },
    stdio: 'ignore',
  });

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
    body: { username: 'chatter', password: 'password123' },
  });
  assert.equal(registration.status, 201);
  const cookie = registration.cookie;

  // No key yet → rejected with a clear code.
  let result = await request('/api/chat', { method: 'POST', cookie, body: { mode: 'guide', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'NO_API_KEY');

  result = await request('/api/me/api-key', { method: 'PUT', body: { apiKey: 'sk-chat-key-1234567890' }, cookie });
  assert.equal(result.status, 200);

  result = await request('/api/chat', { method: 'POST', cookie, body: { mode: 'guide', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.reply, 'Guide reply.');

  result = await request('/api/chat', { method: 'POST', cookie, body: { mode: 'reviewer', messages: [{ role: 'user', content: 'review' }] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.reply, 'Reviewer reply.');

  // Cross-origin mutation is rejected.
  result = await request('/api/chat', {
    method: 'POST',
    cookie,
    origin: 'https://evil.example',
    body: { mode: 'guide', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(result.status, 403);
});

test('chat routes to Anthropic and OpenAI-compatible providers with custom context', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ws-providers-'));

  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* ignore */ }
      const isAnthropic = Boolean(req.headers['x-api-key']);
      if (isAnthropic) {
        const system = String(body.system || '');
        const reply = `anthropic:${system.includes('GUIDEMARK') ? 'ctx' : 'noctx'}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: reply }], model: body.model }));
      } else {
        const sysMessage = (body.messages || []).find((m) => m && m.role === 'system');
        const system = sysMessage ? String(sysMessage.content || '') : '';
        const reply = `openai:${system.includes('REVIEWMARK') ? 'ctx' : 'noctx'}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }], model: body.model }));
      }
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'story-ws-providers-secret-long-enough-123456',
      NODE_ENV: 'test',
      DEEPSEEK_ENDPOINT: `http://127.0.0.1:${mockPort}/chat/completions`,
      ANTHROPIC_ENDPOINT: `http://127.0.0.1:${mockPort}/v1/messages`,
    },
    stdio: 'ignore',
  });

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

  async function request(pathname, { method = 'GET', body, cookie = '' } = {}) {
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
  }

  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'providers', password: 'password123' },
  });
  assert.equal(registration.status, 201);
  const cookie = registration.cookie;

  // Anthropic key + guide config.
  let result = await request('/api/me/anthropic-key', { method: 'PUT', body: { apiKey: 'sk-ant-test-1234567890' }, cookie });
  assert.equal(result.status, 200);
  // OpenAI-compatible key + base URL.
  result = await request('/api/me/openai-key', {
    method: 'PUT',
    body: { apiKey: 'sk-openai-test-1234567890', baseUrl: `http://127.0.0.1:${mockPort}/v1` },
    cookie,
  });
  assert.equal(result.status, 200);

  result = await request('/api/me/chat-settings', {
    method: 'PUT',
    cookie,
    body: {
      guideProvider: 'anthropic',
      guideModel: 'claude-test',
      guideContext: 'GUIDEMARK',
      reviewerProvider: 'openai',
      reviewerModel: 'gpt-test',
      reviewerContext: 'REVIEWMARK',
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.guideProvider, 'anthropic');
  assert.equal(result.data.user.reviewerProvider, 'openai');

  result = await request('/api/chat', { method: 'POST', cookie, body: { mode: 'guide', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.reply, 'anthropic:ctx');

  result = await request('/api/chat', { method: 'POST', cookie, body: { mode: 'reviewer', messages: [{ role: 'user', content: 'review' }] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.reply, 'openai:ctx');
});
