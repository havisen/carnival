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

test('Phase 4 review and quality control', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: workDir,
      APP_SECRET: 'review-test-secret-long-enough-123456',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  let cookie = '';
  let cookieB = '';

  async function request(pathname, { method = 'GET', body, useCookie = cookie, origin } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (useCookie) headers.cookie = useCookie;
    if (origin) headers.origin = origin;
    const response = await fetch(base + pathname, {
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
    } catch (_) { /* Windows may briefly retain SQLite files */ }
  });
  await waitForHealth(base);

  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'reviewer', password: 'password123' },
    useCookie: '',
  });
  assert.equal(registration.status, 201);
  cookie = registration.cookie;

  let result = await request('/api/projects', {
    method: 'POST',
    body: {
      title: 'Review project',
      stage: 'Generation Stage',
      referenceMaterial: 'REF',
      scenes: [{ id: 's1', title: 'Opening', action: 'Ava runs.', location: 'Alley', characters: ['Ava'] }],
      characterReferences: [{ name: 'Ava', gender: 'Female', referenceMaterial: 'Legacy Ava' }],
    },
  });
  assert.equal(result.status, 201);
  const project = result.data.project;

  const uploadResponse = await fetch(`${base}/api/images/upload?projectId=${project.id}&sceneId=s1`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
    body: PNG,
  });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  const assetId = uploaded.image.assetId;
  const versionId = uploaded.image.versionId;
  assert.ok(assetId && versionId);

  await t.test('records all review decisions and rejects invalid decisions', async () => {
    let review = await request(`/api/assets/${assetId}/review`);
    assert.equal(review.status, 200);
    assert.equal(review.data.review.status, 'NOT REVIEWED');
    assert.equal(review.data.review.publicationReady, false);

    for (const decision of ['REVISE', 'REJECT', 'OWNER REVIEW', 'APPROVED']) {
      const created = await request(`/api/assets/${assetId}/reviews`, {
        method: 'POST',
        body: { decision, notes: `${decision} notes` },
      });
      assert.equal(created.status, 201);
      assert.equal(created.data.review.review.decision, decision);
      assert.equal(created.data.review.review.reviewer, 'reviewer');
      assert.equal(created.data.review.review.notes, `${decision} notes`);
      assert.ok(created.data.review.review.createdAt);
    }
    review = await request(`/api/assets/${assetId}/review`);
    assert.equal(review.data.review.review.decision, 'APPROVED');
    assert.equal(review.data.review.history.length, 4);
    assert.equal(review.data.review.publicationReady, false);

    const earlyPublication = await request(`/api/assets/${assetId}/publication`, {
      method: 'POST',
      body: { approved: true, notes: 'Content approved only' },
    });
    assert.equal(earlyPublication.status, 409);
    assert.equal(earlyPublication.data.code, 'PUBLICATION_EVIDENCE_INCOMPLETE');

    const invalid = await request(`/api/assets/${assetId}/reviews`, {
      method: 'POST',
      body: { decision: 'PUBLISH' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'INVALID_DECISION');
  });

  await t.test('checklist states and safe cover are explicit', async () => {
    const categories = ['rights', 'adult-character', 'consent', 'explicitness', 'ai-label', 'placement', 'quality'];
    let result = await request(`/api/assets/${assetId}/checklist`, {
      method: 'PUT',
      body: { items: categories.map((category) => ({ category, state: 'pass', notes: 'Checked' })) },
    });
    assert.equal(result.status, 200);
    for (const item of result.data.review.checklist) {
      assert.ok(categories.includes(item.category));
      assert.equal(item.state, 'pass');
    }

    result = await request(`/api/assets/${assetId}/review`);
    assert.equal(result.data.review.safeCover, null);
    assert.equal(result.data.review.checklistComplete, true);

    result = await request(`/api/assets/${assetId}/safe-cover`, {
      method: 'POST',
      body: { versionId },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.review.safeCover.versionId, versionId);
  });

  await t.test('publication is separate and requires evidence', async () => {
    const approval = await request(`/api/assets/${assetId}/publication`, {
      method: 'POST',
      body: { approved: true, notes: 'Publication evidence complete' },
    });
    assert.equal(approval.status, 201);
    assert.equal(approval.data.review.publicationReady, true);
    assert.equal(approval.data.review.publication.approved, true);

    const review = await request(`/api/assets/${assetId}/review`);
    assert.equal(review.data.review.status, 'PUBLICATION READY');
    assert.equal(review.data.review.publicationReady, true);

    const library = await request('/api/library');
    const libraryAsset = library.data.images.find((image) => image.assetId === assetId);
    assert.ok(libraryAsset);
    assert.equal(libraryAsset.reviewDecision, 'APPROVED');
    assert.equal(libraryAsset.publicationReady, true);
  });

  await t.test('a new revision makes prior review evidence stale', async () => {
    const replacement = await fetch(`${base}/api/images/upload?projectId=${project.id}&sceneId=s1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/png' },
      body: PNG,
    });
    const uploadedReplacement = await replacement.json();
    assert.equal(replacement.status, 200);
    assert.equal(uploadedReplacement.image.assetId, assetId);
    assert.equal(uploadedReplacement.image.revision, 2);

    const review = await request(`/api/assets/${assetId}/review`);
    assert.equal(review.status, 200);
    assert.equal(review.data.review.publicationReady, false);
    assert.ok(review.data.review.blockers.some((item) => /earlier revision/i.test(item)));
  });

  await t.test('continuity checks are factual and read-only audit is append-only', async () => {
    const review = await request(`/api/assets/${assetId}/review`);
    assert.equal(review.status, 200);
    const labels = review.data.review.continuity.map((check) => check.label);
    assert.deepEqual(labels, ['Character identity', 'Wardrobe', 'Props', 'Scene order']);
    const identity = review.data.review.continuity.find((check) => check.label === 'Character identity');
    assert.equal(identity.state, 'warn');
    assert.match(identity.message, /Appearance missing for/);
    const props = review.data.review.continuity.find((check) => check.label === 'Props');
    assert.equal(props.state, 'warn');
    assert.match(props.message, /No props/);

    const audit = await request(`/api/assets/${assetId}/audit`);
    assert.equal(audit.status, 200);
    assert.ok(audit.data.audit.length >= 4);
    assert.ok(audit.data.audit.every((entry) => entry.actor === 'reviewer' && entry.createdAt));
    assert.ok(audit.data.audit.some((entry) => entry.action === 'review' && entry.decision === 'APPROVED'));
    assert.ok(audit.data.audit.some((entry) => entry.action === 'checklist'));
    assert.ok(audit.data.audit.some((entry) => entry.action === 'safe-cover'));
    assert.ok(audit.data.audit.some((entry) => entry.action === 'publication'));

    const attemptEdit = await request(`/api/assets/${assetId}/audit`, { method: 'PUT', body: {} });
    const attemptDelete = await request(`/api/assets/${assetId}/audit`, { method: 'DELETE' });
    assert.equal(attemptEdit.status, 405);
    assert.equal(attemptDelete.status, 405);
  });

  await t.test('prompt drafts can be reviewed', async () => {
    let result = await request(`/api/story/${project.id}/scenes/s1/prompts`, {
      method: 'POST',
      body: {
        text: 'Photoreal Ava in the alley.',
        textModel: 'deepseek-v4-pro',
        imageModel: 'dola-seedream-5-0-pro-260628',
        imageSize: '2K',
      },
    });
    assert.equal(result.status, 201);
    const promptId = result.data.prompt.id;
    const created = await request(`/api/story/prompts/${promptId}/reviews`, {
      method: 'POST',
      body: { decision: 'REVISE', notes: 'Tighten wardrobe continuity.' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.review.latest.decision, 'REVISE');
    const loaded = await request(`/api/story/prompts/${promptId}/review`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.data.review.latest.reviewer, 'reviewer');
    assert.ok(loaded.data.review.audit.some((entry) => entry.action === 'prompt-review'));
  });

  await t.test('review data is user scoped and mutations reject cross-origin', async () => {
    const second = await request('/api/auth/register', {
      method: 'POST',
      body: { username: 'other-reviewer', password: 'password123' },
      useCookie: '',
    });
    assert.equal(second.status, 201);
    cookieB = second.cookie;
    const other = await request(`/api/assets/${assetId}/review`, { useCookie: cookieB });
    assert.equal(other.status, 404);

    const crossOrigin = await request(`/api/assets/${assetId}/reviews`, {
      method: 'POST',
      body: { decision: 'APPROVED' },
      origin: 'https://evil.example',
    });
    assert.equal(crossOrigin.status, 403);
  });

  await t.test('checklist records fail, not-applicable, and unreviewed states', async () => {
    const result = await request(`/api/assets/${assetId}/checklist`, {
      method: 'PUT',
      body: {
        items: [
          { category: 'rights', state: 'fail', notes: 'Rights evidence missing' },
          { category: 'consent', state: 'not-applicable', notes: 'No identifiable person' },
          { category: 'quality', state: 'unreviewed', notes: '' },
        ],
      },
    });
    assert.equal(result.status, 200);
    const states = new Map(result.data.review.checklist.map((item) => [item.category, item.state]));
    assert.equal(states.get('rights'), 'fail');
    assert.equal(states.get('consent'), 'not-applicable');
    assert.equal(states.get('quality'), 'unreviewed');
    assert.equal(result.data.review.checklistComplete, false);
    assert.equal(result.data.review.publicationReady, false);
  });
});
