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

test('Phase 2 migrates existing scene_images and backs up the database', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-migration-test-'));
  const projectId = '11111111-1111-4111-8111-111111111111';
  const imageFile = 'existing-image.png';
  process.env.DATA_DIR = dataDir;
  process.env.APP_SECRET = 'asset-migration-secret-long-enough-123456';
  delete require.cache[require.resolve(path.join(ROOT, 'db.js'))];
  const db = require(path.join(ROOT, 'db.js'));
  const security = require(path.join(ROOT, 'security.js'));

  const { hash, salt } = await security.hashPassword('password123');
  const user = db.createUser({
    id: '22222222-2222-4222-8222-222222222222',
    username: 'migration-user',
    passwordHash: hash,
    passwordSalt: salt,
  });
  db.createProject(user.id, {
    id: projectId,
    title: 'Migrated project',
    stage: 'Generation Stage',
    referenceMaterial: 'REF',
    scenes: [{ id: 's1', title: 'Migrated scene', action: '', location: '', characters: [] }],
    scene_images: [{
      sceneId: 's1',
      file: imageFile,
      mime: 'image/png',
      size: '',
      prompt: 'existing prompt',
      model: 'test-model',
      source: 'upload',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    created_at: '2026-01-01T00:00:00.000Z',
  });
  const imagesDir = path.join(dataDir, 'images', projectId);
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, imageFile), PNG);
  db.db.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: 'asset-migration-secret-long-enough-123456',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
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
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (_) { /* Windows may briefly retain SQLite files */ }
  });
  await waitForHealth(base);

  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.ok(backups.some((name) => name.startsWith('app-pre-assets-') && name.endsWith('.db')));

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'migration-user', password: 'password123' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const assetsResponse = await fetch(`${base}/api/assets`, { headers: { cookie } });
  const assets = await assetsResponse.json();
  const asset = assets.assets.find((item) => item.metadata && item.metadata.projectId === projectId);
  assert.ok(asset);
  assert.equal(asset.metadata.sceneId, 's1');
  assert.equal(asset.metadata.prompt, 'existing prompt');
  assert.equal(asset.revision, 1);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);

  const detailResponse = await fetch(`${base}/api/assets/${asset.id}`, { headers: { cookie } });
  const detail = await detailResponse.json();
  assert.equal(detail.asset.versions.length, 1);
  assert.equal(detail.asset.versions[0].relativePath, `${projectId}/${imageFile}`);
  assert.equal(detail.asset.versions[0].isSource, true);

  const projectsResponse = await fetch(`${base}/api/projects`, { headers: { cookie } });
  const projects = await projectsResponse.json();
  const project = projects.projects.find((item) => item.id === projectId);
  assert.equal(project.sceneImages[0].assetId, asset.id);
  assert.equal(project.sceneImages[0].versionId, asset.versionId);
});
