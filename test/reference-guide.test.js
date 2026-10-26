'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('Reference Stage exposes the Use guide shortcut', () => {
  assert.match(html, /id="ref-use-guide"[^>]*>Use guide</);
  assert.match(html, /id="ref-setting"[\s\S]*id="ref-use-guide"/);
  assert.match(app, /#ref-use-guide'\)\.addEventListener\('click'/);
  assert.match(app, /Create setting for the current reference project/);
  assert.match(app, /projectId: state\.reference\.projectId/);
  assert.match(app, /mode: 'guide'/);
  assert.match(app, /function setReferenceButtons\(enabled\)[\s\S]*ref-use-guide/);
});
