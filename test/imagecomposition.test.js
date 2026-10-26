'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { prepareImagePrompt } = require('../imagecomposition');

test('multi-panel prompts retain ordered inputs and request a single combined image', () => {
  const panels = ['Kitchen at dawn.', 'A sunny cafe.', 'Reading on a sofa.', 'Breakfast in bed.'];
  const result = prepareImagePrompt(' Natural light. ', { layout: 'grid-2x2', panels });
  assert.match(result.prompt, /ONE finished image containing exactly 4/);
  assert.match(result.prompt, /2 column\(s\) and 2 row\(s\)/);
  assert.match(result.prompt, /single combined image/);
  assert.deepEqual(result.composition, { layout: 'grid-2x2', panels, sharedPrompt: 'Natural light.' });
  let previous = -1;
  for (const text of panels) { const at = result.prompt.indexOf(text); assert.ok(at > previous); previous = at; }
  assert.match(prepareImagePrompt('', { layout: 'stacked', panels: ['First', 'Second'] }).prompt, /1 column\(s\) and 2 row\(s\)/);
  assert.match(prepareImagePrompt('', { layout: 'side-by-side', panels: ['First', 'Second'] }).prompt, /2 column\(s\) and 1 row\(s\)/);
  assert.deepEqual(prepareImagePrompt(' A single scene. ', null), { prompt: 'A single scene.', composition: null });
});

test('invalid or oversized panel inputs are rejected', () => {
  for (const composition of [
    { layout: '__proto__', panels: ['one', 'two'] },
    { layout: 'grid-2x2', panels: ['one', 'two'] },
    { layout: 'stacked', panels: ['one', ' '] },
    { layout: 'stacked', panels: ['one', 42] },
    { layout: 'stacked', panels: ['one', 'x'.repeat(6001)] },
  ]) assert.throws(() => prepareImagePrompt('', composition), { status: 400 });
  assert.throws(() => prepareImagePrompt('x'.repeat(29000), { layout: 'stacked', panels: ['one', 'two'.repeat(500)] }), { status: 400 });
  assert.throws(() => prepareImagePrompt(' '), { status: 400 });
  assert.throws(() => prepareImagePrompt('x'.repeat(30001)), { status: 400 });
});

test('storage migration preserves existing images and editable compositions', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner');
      CREATE TABLE standalone_generations (
        id TEXT PRIMARY KEY, user_id TEXT, prompt TEXT, image_model TEXT, image_size TEXT,
        file TEXT, mime TEXT, bytes INTEGER, asset_id TEXT, asset_version_id TEXT, references_json TEXT, created_at TEXT
      );
      INSERT INTO standalone_generations VALUES
        ('legacy', 'owner', 'Keep this prompt', 'model', '2K', 'legacy.png', 'image/png', 10, NULL, NULL, '[]', '2026-10-25');
    `);
    const standalone = require('../standalone');
    const store = standalone.init(database);
    assert.equal(store.get('owner', 'legacy').prompt, 'Keep this prompt');
    assert.equal(store.get('owner', 'legacy').composition, null);
    const prepared = prepareImagePrompt('Shared style', { layout: 'stacked', panels: ['one', 'two'] });
    store.create('owner', { id: 'new', ...prepared, file: 'new.png', imageModel: 'model', imageSize: '2K' });
    standalone.init(database);
    assert.deepEqual(store.get('owner', 'new').composition, prepared.composition);
    assert.equal(store.list('owner').length, 2);
    assert.equal(store.get('other', 'new'), null);
  } finally { database.close(); }
});
