'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('Reference Stage exposes the Use chat shortcut for all reference fields', () => {
  assert.match(html, /id="ref-use-guide"[^>]*>Use chat</);
  assert.match(html, /id="ref-setting"[\s\S]*id="ref-use-guide"/);
  assert.match(app, /#ref-use-guide'\)\.addEventListener\('click'/);
  assert.match(app, /Make a refrence, setting and character refrence for both the characters/);
  assert.match(app, /projectId: state\.reference\.projectId/);
  assert.match(app, /mode: 'guide'/);
  assert.match(app, /function setReferenceButtons\(enabled\)[\s\S]*ref-use-guide/);
});
