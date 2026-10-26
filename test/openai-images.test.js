'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('../public/image-models');
const { generateOpenAIImage } = require('../openaiimages');
const ROOT = path.resolve(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j8sAAAAASUVORK5CYII=', 'base64');
const KEY = 'sk-openai-local-synthetic-123456789';
const DIRECT_KEY = 'sk-direct-openai-local-synthetic-987654321';

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('the shared catalog includes every active GPT Image alias and dated snapshot', () => {
  assert.deepEqual(catalog.filter(x => x.provider === 'openai').map(x => x.id).sort(), [
    'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21',
    'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08', 'chatgpt-image-latest',
  ].sort());
  assert.ok(!catalog.some(x => ['gpt-image-1', 'dall-e-2', 'dall-e-3'].includes(x.id)));
});

test('OpenAI models route generation and references correctly, remain isolated, and survive restarts', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'carnival-openai-'));
  const calls = [];
  let next = '';
  const mock = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const contentType = req.headers['content-type'];
      const bytes = Buffer.concat(chunks);
      let body;
      let images = [];
      if (contentType.startsWith('multipart/form-data')) {
        const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
        body = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'));
        images = await Promise.all(form.getAll('image[]').map(async image => ({ mime: image.type, bytes: Buffer.from(await image.arrayBuffer()) })));
      } else body = JSON.parse(bytes);
      calls.push({ url: req.url, authorization: req.headers.authorization, body, images });
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Synthetic assistant reply' } }] }));
      }
      const mode = next; next = '';
      const status = /^\d+$/.test(mode) ? Number(mode) : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(mode === 'bad-json' ? 'not json' : JSON.stringify(status !== 200
        ? { error: { message: `Synthetic rejection for ${KEY}` } }
        : mode === 'empty' ? { data: [] }
          : { data: [{ b64_json: mode === 'bad-image' ? 'bm90IGFuIGltYWdl' : PNG.toString('base64') }], size: '1024x1024' }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: temp,
      APP_SECRET: 'openai-image-test-secret-123456789', NODE_ENV: 'test', OPENAI_BASE_URL: upstream + '/v1', OPENAI_DIRECT_TEST_BASE_URL: upstream + '/direct/v1', BYTEPLUS_IMAGE_ENDPOINT: upstream + '/byteplus' }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('Test server did not start');
  };
  t.after(async () => { await stop(child); await new Promise(resolve => mock.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  await start();
  const request = async (url, { method = 'GET', body, cookie, raw } = {}) => {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = async username => (await request('/api/auth/register', { method: 'POST', body: { username, password: 'password123' } })).cookie;
  const cookie = await register('openai_owner');
  const other = await register('openai_other');
  assert.equal((await request('/api/auth/me', { cookie })).data.user.openAIImageProvider, 'openai-direct');
  const choose = async imageModel => request('/api/me/ai-settings', { method: 'PUT', cookie, body: { imageModel, openAIImageProvider: 'openai' } });
  await choose('gpt-image-2.5-sunburst');
  let result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'A lighthouse' } });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'NO_OPENAI_IMAGE_KEY'); assert.equal(calls.length, 0);
  await request('/api/me/openai-key', { method: 'PUT', cookie, body: { apiKey: KEY, baseUrl: upstream + '/v1/' } });
  const upload = await request('/api/generation-references?name=reference.png', { method: 'POST', cookie, raw: PNG });
  assert.equal(upload.status, 201);
  const composition = { layout: 'grid-2x2', panels: ['First scene', 'Second scene', 'Third scene', 'Fourth scene'] };
  for (const model of catalog.filter(x => x.provider === 'openai')) {
    result = await choose(model.id); assert.equal(result.status, 200); assert.equal(result.data.user.imageModel, model.id);
    result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'A lighthouse', size: '1024x1024' } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.generation.imageModel, model.id);
    assert.equal(calls.at(-1).url, '/v1/images/generations');
    assert.equal(calls.at(-1).authorization, `Bearer ${KEY}`);
    assert.equal(calls.at(-1).body.model, model.id);
    assert.equal(calls.at(-1).body.response_format, undefined);
    assert.equal(calls.at(-1).body.watermark, undefined);
    result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Natural light', composition, references: [{ kind: 'upload', id: upload.data.reference.id }] } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const call = calls.at(-1);
    assert.equal(call.url, '/v1/images/edits'); assert.equal(call.body.model, model.id); assert.equal(call.body.n, '1');
    assert.equal(call.images.length, 1); assert.ok(call.images[0].bytes.equals(PNG));
    assert.match(call.body.prompt, /Fourth scene/); assert.match(call.body.safety_identifier, /^[a-f0-9]{64}$/);
    assert.equal(call.body.input_fidelity, model.id === 'gpt-image-1.5' ? 'high' : undefined);
    assert.deepEqual(result.data.generation.composition.panels, composition.panels);
  }
  const selected = catalog.filter(x => x.provider === 'openai').at(-1).id;
  // Both slots coexist. Direct requests must ignore the compatible URL and key.
  result = await request('/api/me/openai-direct-key', { method: 'PUT', cookie, body: { apiKey: DIRECT_KEY, baseUrl: upstream + '/wrong' } });
  assert.equal(result.status, 200); assert.equal(result.data.user.hasOpenAIKey, true); assert.equal(result.data.user.hasDirectOpenAIKey, true);
  assert.equal(result.data.user.openAIBaseUrl, upstream + '/v1');
  assert.ok(!JSON.stringify(result.data).includes(DIRECT_KEY));
  assert.equal((await request('/api/auth/me', { cookie: other })).data.user.hasDirectOpenAIKey, false);
  assert.equal((await request('/api/me/openai-direct-key', { method: 'PUT', cookie, body: { apiKey: 'bad key' } })).status, 400);
  result = await request('/api/me/ai-settings', { method: 'PUT', cookie, body: { openAIImageProvider: 'wrong' } }); assert.equal(result.status, 400);
  await request('/api/me/ai-settings', { method: 'PUT', cookie, body: { openAIImageProvider: 'openai-direct' } });
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Direct image with reference', references: [{ kind: 'upload', id: upload.data.reference.id }] } });
  assert.equal(result.status, 201); assert.equal(calls.at(-1).url, '/direct/v1/images/edits'); assert.equal(calls.at(-1).authorization, `Bearer ${DIRECT_KEY}`);
  for (const mode of ['guide', 'reviewer']) {
    for (const provider of ['openai', 'openai-direct']) {
      result = await request('/api/me/chat-settings', { method: 'PUT', cookie, body: { [`${mode}Provider`]: provider, [`${mode}Model`]: 'synthetic-chat' } });
      assert.equal(result.status, 200);
      result = await request('/api/chat', { method: 'POST', cookie, body: { mode, messages: [{ role: 'user', content: 'Hello' }] } });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(calls.at(-1).url, provider === 'openai-direct' ? '/direct/v1/chat/completions' : '/v1/chat/completions');
      assert.equal(calls.at(-1).authorization, `Bearer ${provider === 'openai-direct' ? DIRECT_KEY : KEY}`);
    }
  }
  await stop(child); await start();
  result = await request('/api/auth/me', { cookie }); assert.equal(result.data.user.imageModel, selected);
  assert.equal(result.data.user.openAIImageProvider, 'openai-direct'); assert.equal(result.data.user.hasDirectOpenAIKey, true);
  result = await request('/api/me/openai-direct-key', { method: 'DELETE', cookie });
  assert.equal(result.data.user.hasOpenAIKey, true); assert.equal(result.data.user.hasDirectOpenAIKey, false);
  let beforeMissing = calls.length;
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'No credential fallback' } });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'NO_DIRECT_OPENAI_KEY'); assert.equal(calls.length, beforeMissing);
  await request('/api/me/openai-direct-key', { method: 'PUT', cookie, body: { apiKey: DIRECT_KEY } });
  result = await request('/api/me/openai-key', { method: 'DELETE', cookie });
  assert.equal(result.data.user.hasDirectOpenAIKey, true); assert.equal(result.data.user.hasOpenAIKey, false);
  await choose(selected);
  beforeMissing = calls.length;
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'No reverse fallback' } });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'NO_OPENAI_IMAGE_KEY'); assert.equal(calls.length, beforeMissing);
  await request('/api/me/openai-key', { method: 'PUT', cookie, body: { apiKey: KEY, baseUrl: upstream + '/v1' } });
  assert.equal((await request('/api/generations', { cookie: other })).data.generations.length, 0);
  const callCount = calls.length;
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'bad size', size: '2K' } }); assert.equal(result.status, 400);
  result = await choose('gpt-image-1'); assert.equal(result.status, 400); assert.equal(calls.length, callCount);
  const count = (await request('/api/generations', { cookie })).data.generations.length;
  for (const mode of ['401', '403', '429', '500', 'bad-json', 'empty', 'bad-image']) {
    next = mode;
    result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Keep my saved images' } });
    assert.equal(result.status, 502, JSON.stringify(result.data));
    assert.ok(!JSON.stringify(result.data).includes(KEY));
  }
  assert.equal((await request('/api/generations', { cookie })).data.generations.length, count);
  result = await request('/api/characters', { method: 'POST', cookie, body: { name: 'Ava', description: 'A red-haired explorer in a blue coat.' } });
  result = await request(`/api/characters/${result.data.character.id}/generate`, { method: 'POST', cookie, body: { mode: 'sheet' } });
  assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(calls.at(-1).url, '/v1/images/edits');
  assert.equal(calls.at(-1).images.length, 1, 'character-sheet layout image is attached');
  const history = await request('/api/track', { cookie });
  assert.ok(!JSON.stringify(history.data).includes(KEY));
  const outgoing = history.data.requests.find(entry => entry.provider === 'openai-images' && entry.url.endsWith('/images/edits'));
  assert.ok(outgoing, 'OpenAI reference requests are tracked');
  const trace = (await request('/api/track/' + outgoing.id, { cookie })).data.request;
  assert.equal(trace.requestBody['image[]'], '[image data omitted]');
  assert.equal(trace.requestBody.model, selected);
  assert.equal(trace.requestBytes, null, 'unavailable multipart wire size is not reported as zero');
  assert.ok(!JSON.stringify(trace).includes(KEY));
  assert.ok(!JSON.stringify(trace).includes(PNG.toString('base64')));
  await choose('dola-seedream-5-0-pro-260628');
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Seedream needs its own key' } }); assert.equal(result.status, 409);
  await request('/api/me/byteplus-key', { method: 'PUT', cookie, body: { apiKey: 'byteplus-local-synthetic-key' } });
  result = await request('/api/generations', { method: 'POST', cookie, body: { prompt: 'Seedream still works' } }); assert.equal(result.status, 201);
  assert.equal(calls.at(-1).url, '/byteplus'); assert.equal(calls.at(-1).authorization, 'Bearer byteplus-local-synthetic-key');
  // Simulate the previous schema: migration keeps compatible credentials/routing.
  await stop(child);
  const sqlite = new DatabaseSync(path.join(temp, 'app.db'));
  const saved = sqlite.prepare('SELECT openai_api_key_enc, openai_direct_api_key_enc FROM users WHERE username = ?').get('openai_owner');
  assert.ok(saved.openai_api_key_enc && saved.openai_direct_api_key_enc);
  assert.ok(!saved.openai_api_key_enc.includes(KEY)); assert.ok(!saved.openai_direct_api_key_enc.includes(DIRECT_KEY));
  for (const column of ['openai_direct_api_key_enc', 'openai_direct_api_key_hint', 'openai_image_provider']) sqlite.exec(`ALTER TABLE users DROP COLUMN ${column}`);
  sqlite.close();
  await start();
  result = await request('/api/auth/me', { cookie });
  assert.equal(result.data.user.hasOpenAIKey, true); assert.equal(result.data.user.hasDirectOpenAIKey, false); assert.equal(result.data.user.openAIImageProvider, 'openai');
  assert.equal(result.data.user.openAIBaseUrl, upstream + '/v1');
});

test('OpenAI network timeouts and unsupported reference formats fail without retrying', async () => {
  const input = { apiKey: KEY, model: 'gpt-image-2', size: '1024x1024', prompt: 'test', baseUrl: 'http://127.0.0.1/v1', userId: 'synthetic-user' };
  let calls = 0;
  await assert.rejects(generateOpenAIImage(input, async () => { calls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }), { status: 504, code: 'IMAGEGEN_TIMEOUT' });
  assert.equal(calls, 1);
  await assert.rejects(generateOpenAIImage({ ...input, images: ['data:image/gif;base64,AA=='] }, async () => { calls += 1; }), { status: 400, code: 'IMAGE_REFERENCE_FORMAT' });
  assert.equal(calls, 1);
});
