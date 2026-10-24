'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j8sAAAAASUVORK5CYII=',
  'base64'
);

let child;
let workDir;
let baseUrl;
let cookieA = '';
let cookieB = '';
let projectA;
let assetA;
let duplicateProject;
let duplicateFile;

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

async function request(pathname, { method = 'GET', body, cookie = cookieA } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie') || '';
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { status: response.status, data, cookie: setCookie.split(';')[0] };
}

async function upload(projectId, cookie = cookieA) {
  const response = await fetch(`${baseUrl}/api/images/upload?projectId=${encodeURIComponent(projectId)}&sceneId=s1`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
    body: PNG,
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

test('Phase 2 asset registry', async (t) => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-registry-test-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'asset-registry-test-secret-long-enough-123456',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForHealth(baseUrl);

  t.after(async () => {
    if (child && !child.killed) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) { /* Windows may briefly hold SQLite files */ }
  });

  await t.test('migrates an uploaded scene image into an asset and version', async () => {
    let result = await request('/api/auth/register', {
      method: 'POST',
      body: { username: 'asset-user', password: 'password123' },
    });
    assert.equal(result.status, 201);
    cookieA = result.cookie;
    assert.ok(cookieA);

    result = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'Asset project',
        stage: 'Generation Stage',
        referenceMaterial: 'REF',
        scenes: [{ id: 's1', title: 'Scene One', action: '', location: '', characters: [] }],
      },
    });
    assert.equal(result.status, 201);
    projectA = result.data.project;

    const uploaded = await upload(projectA.id);
    assert.ok(uploaded.image.assetId);
    assetA = uploaded.image.assetId;
    const firstFile = uploaded.project.sceneImages[0].file;

    result = await request('/api/assets');
    assert.equal(result.status, 200);
    const asset = result.data.assets.find((item) => item.id === assetA);
    assert.ok(asset);
    assert.equal(asset.revision, 1);
    assert.equal(asset.metadata.projectId, projectA.id);
    assert.equal(asset.metadata.sceneId, 's1');
    assert.ok(asset.relativePath.endsWith(firstFile));

    result = await request(`/api/assets/${encodeURIComponent(assetA)}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.asset.versions.length, 1);
    assert.equal(result.data.asset.versions[0].isSource, true);

    const second = await upload(projectA.id);
    assert.equal(second.image.assetId, assetA);
    assert.equal(second.image.revision, 2);
    const secondFile = second.project.sceneImages[0].file;
    assert.notEqual(firstFile, secondFile);
    assert.equal(fs.existsSync(path.join(workDir, 'images', projectA.id, firstFile)), true);

    result = await request(`/api/assets/${encodeURIComponent(assetA)}`);
    assert.equal(result.data.asset.versions.length, 2);
    assert.equal(result.data.asset.versions[1].revision, 2);
    assert.equal(result.data.asset.versions[0].relativePath, `${projectA.id}/${firstFile}`);
  });

  await t.test('detects duplicate content without deleting files', async () => {
    const result = await request('/api/projects', {
      method: 'POST',
      body: {
        title: 'Duplicate project',
        stage: 'Generation Stage',
        referenceMaterial: 'REF',
        scenes: [{ id: 's1', title: 'Duplicate scene', action: '', location: '', characters: [] }],
      },
    });
    assert.equal(result.status, 201);
    const project = result.data.project;
    const uploaded = await upload(project.id);
    assert.ok(uploaded.image.assetId);
    duplicateProject = project;
    duplicateFile = uploaded.image.file;

    const groups = await request('/api/assets/duplicates');
    assert.equal(groups.status, 200);
    const matching = groups.data.groups.find((group) =>
      group.assets.some((asset) => asset.id === assetA)
    );
    assert.ok(matching);
    assert.ok(matching.count >= 2);
    assert.ok(fs.existsSync(path.join(workDir, 'images', project.id, uploaded.image.file)));
  });

  await t.test('serves archived project assets after project deletion', async () => {
    let result = await request(`/api/projects/${duplicateProject.id}`, { method: 'DELETE' });
    assert.equal(result.status, 200);
    const relativePath = `${duplicateProject.id}/${duplicateFile}`;
    const response = await fetch(`${baseUrl}/api/library/file?path=${encodeURIComponent(relativePath)}`, {
      headers: { cookie: cookieA },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(fs.existsSync(path.join(workDir, 'images', duplicateProject.id, duplicateFile)), true);
  });

  await t.test('episodes, collections, tags, and filters', async () => {
    let result = await request(`/api/projects/${projectA.id}/episodes`, {
      method: 'POST',
      body: { title: 'Episode One' },
    });
    assert.equal(result.status, 201);
    const episode = result.data.episode;
    result = await request(`/api/projects/${projectA.id}/episodes`);
    assert.equal(result.data.episodes.length, 1);

    result = await request('/api/collections', {
      method: 'POST',
      body: { name: 'Selects', description: 'Asset selects' },
    });
    assert.equal(result.status, 201);
    const collection = result.data.collection;
    result = await request(`/api/collections/${collection.id}/assets/${assetA}`, { method: 'POST' });
    assert.equal(result.status, 200);

    result = await request(`/api/assets/${assetA}/tags`, {
      method: 'POST',
      body: { name: 'continuity' },
    });
    assert.equal(result.status, 200);
    const tag = result.data.tag;

    result = await request(`/api/assets/${assetA}`, {
      method: 'PUT',
      body: { episodeId: episode.id },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.asset.metadata.episodeId, episode.id);

    result = await request(`/api/assets?collectionId=${collection.id}`);
    assert.equal(result.data.assets.length, 1);
    result = await request('/api/assets?tag=continuity');
    assert.equal(result.data.assets.length, 1);
    result = await request(`/api/assets?episodeId=${episode.id}`);
    assert.equal(result.data.assets.length, 1);
    result = await request(`/api/assets?projectId=${projectA.id}`);
    assert.ok(result.data.assets.length >= 1);
    result = await request('/api/assets?duplicate=1');
    assert.ok(result.data.assets.length >= 2);
    result = await request('/api/assets?unassigned=1');
    assert.equal(result.data.assets.length, 0);

    result = await request(`/api/assets/${assetA}`);
    assert.equal(result.data.asset.tags[0].id, tag.id);
    assert.equal(result.data.asset.collections[0].id, collection.id);
  });

  await t.test('missing files remain recorded and project deletion archives assets', async () => {
    let result = await request(`/api/assets/${assetA}`);
    const current = result.data.asset;
    fs.rmSync(path.join(workDir, 'images', current.relativePath), { force: true });

    result = await request('/api/assets?missing=1');
    const missing = result.data.assets.find((asset) => asset.id === assetA);
    assert.ok(missing);
    assert.equal(missing.lifecycleStatus, 'MISSING');

    result = await request(`/api/projects/${projectA.id}`, { method: 'DELETE' });
    assert.equal(result.status, 200);
    result = await request(`/api/assets/${assetA}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.asset.lifecycleStatus, 'MISSING');
    assert.ok(fs.existsSync(path.join(workDir, 'images', projectA.id)));
  });

  await t.test('registers unassigned filesystem images without inventing metadata', async () => {
    fs.mkdirSync(path.join(workDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'images', 'unassigned.png'), PNG);
    const result = await request('/api/assets?unassigned=1');
    assert.equal(result.status, 200);
    const asset = result.data.assets.find((item) => item.relativePath === 'unassigned.png');
    assert.ok(asset);
    assert.equal(asset.metadata, null);
    assert.equal(asset.lifecycleStatus, 'ACTIVE');
    assert.equal(asset.duplicateCount > 1, true);
  });

  await t.test('keeps assets scoped between users', async () => {
    let result = await request('/api/auth/register', {
      method: 'POST',
      body: { username: 'other-user', password: 'password123' },
      cookie: '',
    });
    assert.equal(result.status, 201);
    cookieB = result.cookie;
    assert.ok(cookieB);
    result = await request('/api/assets', { cookie: cookieB });
    assert.equal(result.status, 200);
    assert.equal(result.data.assets.some((asset) => asset.id === assetA), false);
    result = await request(`/api/assets/${assetA}`, { cookie: cookieB });
    assert.equal(result.status, 404);
  });
});
