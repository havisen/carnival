'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function png(width, height, color = [220, 40, 60]) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(color).copy(pixels, y * (1 + width * 3) + 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('Library split saves four isolated derived assets atomically and preserves the source', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'carnival-library-split-'));
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: temp, APP_SECRET: 'collage-split-synthetic-secret' }, stdio: 'ignore' });
  let sqlite;
  t.after(async () => {
    if (sqlite?.isOpen) sqlite.close();
    if (child.exitCode === null && !child.signalCode) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 70)); }
  async function request(url, { method = 'GET', body, cookie, headers = {} } = {}) {
    const isJson = body && !(body instanceof FormData) && !Buffer.isBuffer(body);
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers }, body: isJson ? JSON.stringify(body) : body });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = (await request('/api/auth/register', { method: 'POST', body: { username: 'split_owner', password: 'password123' } })).cookie;
  const other = (await request('/api/auth/register', { method: 'POST', body: { username: 'split_other', password: 'password123' } })).cookie;
  const project = (await request('/api/projects', { method: 'POST', cookie: owner, body: { title: 'Collage project', stage: 'Generation Stage', referenceMaterial: 'Synthetic reference', scenes: [{ id: 'collage', title: 'Collage' }] } })).data.project;
  const original = png(5, 7);
  const upload = () => request(`/api/images/upload?projectId=${project.id}&sceneId=collage`, { method: 'POST', cookie: owner, body: original, headers: { 'content-type': 'image/png' } });
  assert.equal((await upload()).status, 200);
  const library = async cookie => (await request('/api/library', { cookie })).data.images;
  const listedSource = (await library(owner))[0];
  const source = { ...listedSource, id: listedSource.assetId };
  assert.equal((await request(`/api/assets/${source.id}/reviews`, { method: 'POST', cookie: owner, body: { decision: 'APPROVED', notes: 'Synthetic source-only review' } })).status, 201);
  const endpoint = `/api/assets/${source.id}/split`;
  const sizes = [[2, 3], [3, 3], [2, 4], [3, 4]];
  const form = ({ count = 4, wrongSize = false, version = source.versionId, invalid = false } = {}) => {
    const body = new FormData(); body.append('width', '5'); body.append('height', '7'); body.append('sourceVersionId', version);
    for (let i = 0; i < count; i++) body.append('photos', new Blob([invalid ? Buffer.from('invalid png') : png(...(wrongSize && i === 3 ? [1, 1] : sizes[i]))], { type: 'image/png' }), `photo-${i}.png`);
    return body;
  };
  for (const [cookie, status] of [[undefined, 401], [other, 404]]) assert.equal((await request(endpoint, { method: 'POST', cookie, body: form() })).status, status);
  assert.equal((await request(endpoint, { method: 'POST', cookie: owner, body: form(), headers: { origin: 'https://foreign.invalid' } })).status, 403);
  for (const options of [{ count: 3 }, { wrongSize: true }, { invalid: true }]) assert.equal((await request(endpoint, { method: 'POST', cookie: owner, body: form(options) })).status, 400);
  assert.equal((await request(endpoint, { method: 'POST', cookie: owner, body: form({ version: 'stale' }) })).status, 409);
  assert.equal((await library(owner)).length, 1);

  // Force a mid-batch insert failure. No partial rows or discovered image files may survive.
  sqlite = new DatabaseSync(path.join(temp, 'app.db'));
  sqlite.exec("CREATE TRIGGER reject_split BEFORE INSERT ON assets WHEN NEW.title LIKE '%Bottom left' BEGIN SELECT RAISE(ABORT, 'Synthetic batch failure'); END");
  assert.equal((await request(endpoint, { method: 'POST', cookie: owner, body: form() })).status, 500);
  assert.equal((await library(owner)).length, 1);
  assert.equal(fs.readdirSync(path.join(temp, 'images')).filter(name => name.startsWith('.split-')).length, 0);
  sqlite.exec('DROP TRIGGER reject_split');
  const result = await request(endpoint, { method: 'POST', cookie: owner, body: form() });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.photos.length, 4);
  for (const [index, photo] of result.data.photos.entries()) {
    assert.deepEqual([photo.width, photo.height], sizes[index]);
    assert.equal(photo.derivedFromVersionId, source.versionId); assert.equal(photo.isSource, false);
    assert.equal(photo.versions[0].source, 'collage-split-2x2');
    const file = await fetch(base + photo.url, { headers: { cookie: owner } }); assert.equal(file.status, 200);
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(png(...sizes[index])));
    assert.equal((await fetch(base + photo.url, { headers: { cookie: other } })).status, 404);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM review_records WHERE asset_id = ?').get(photo.id).n, 0);
  }
  assert.equal((await library(owner)).length, 5); assert.equal((await library(other)).length, 0);
  const sourceAfter = (await request(`/api/assets/${source.id}`, { cookie: owner })).data.asset;
  assert.equal(sourceAfter.versionId, source.versionId); assert.equal(sourceAfter.versions.length, 1);
  assert.equal(sourceAfter.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM review_records WHERE asset_id = ? AND decision = ?').get(source.id, 'APPROVED').n, 1);
  assert.equal((await request('/api/projects', { cookie: owner })).data.projects.find(item => item.id === project.id).sceneImages.length, 1);
  await upload();
  assert.equal((await request(endpoint, { method: 'POST', cookie: owner, body: form() })).status, 409);
  sqlite.close();
});
