'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

test('Reference Stage exposes the Use guide shortcut', () => {
  assert.match(html, /id="ref-use-guide"[^>]*>Use guide</);
  assert.match(html, /id="ref-setting"[\s\S]*id="ref-use-guide"/);
  assert.match(app, /#ref-use-guide'\)\.addEventListener\('click'/);
  assert.match(app, /Create setting for the current reference project/);
  assert.match(app, /projectId: state\.reference\.projectId/);
  assert.match(app, /mode: 'guide'/);
  assert.match(app, /function setReferenceButtons\(enabled\)[\s\S]*ref-use-guide/);
});

test('Guide assistant responses have a copy button', () => {
  assert.match(app, /if \(state\.chat\.mode === 'guide' && m\.role === 'assistant'\) \{[\s\S]*copy\.type = 'button'/);
  assert.match(app, /copy\.setAttribute\('aria-label', 'Copy guide response'\)/);
  assert.match(app, /copy\.addEventListener\('click', \(\) => copyToClipboard\(m\.content, 'Response'\)\)/);
  assert.match(app, /async function copyToClipboard\(text, label = 'Prompt'\)/);
  assert.match(css, /\.chat-copy:focus-visible/);
});
