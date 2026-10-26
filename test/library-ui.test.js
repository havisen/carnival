'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

test('Library UI contract', () => {
  // The Library is a shared service reachable from every module.
  assert.match(app, /id: 'library', label: 'Library', icon: '[^']*', tab: 'library'/);
  assert.match(html, /id="panel-library"/);
  assert.match(html, /id="library-loading"/);
  assert.match(html, /id="library-empty"[\s\S]*data\/images/);
  assert.match(html, /id="library-error"/);
  assert.match(html, /id="library-retry"/);
  assert.match(html, /id="library-grid"/);
  assert.match(html, /id="library-search"/);
  assert.match(html, /id="library-project-filter"/);
  assert.match(html, /id="library-episode-filter"/);
  assert.match(html, /id="library-collection-filter"/);
  assert.match(html, /id="library-tag-filter"/);
  assert.match(html, /id="library-type-filter"/);
  assert.match(html, /id="library-status-filter"/);
  assert.match(html, /id="library-duplicate-filter"/);
  assert.match(html, /id="library-missing-filter"/);
  assert.match(html, /id="library-unassigned-filter"/);
  assert.match(html, /id="library-versions"/);
  assert.match(html, /id="library-asset-tags"/);
  assert.match(html, /id="episodes-modal"/);
  assert.match(html, /id="review-status"/);
  assert.match(html, /id="review-checklist"/);
  assert.match(html, /id="review-cover-select"/);
  assert.match(html, /id="review-publication-approve"/);
  assert.match(html, /id="review-audit"/);
  assert.match(html, /id="review-compare"/);
  assert.match(html, /id="worksheet-character"/);

  assert.match(app, /library: 'panel-library'/);
  assert.match(app, /if \(name === 'library'\) loadLibrary\(\)/);
  assert.match(app, /async function loadLibrary/);
  assert.match(app, /function openLibraryDetail/);
  assert.match(app, /function closeLibraryDetail/);
  assert.match(app, /function libraryModalKeydown/);
  assert.match(app, /modal\.contains\(document\.activeElement\)/);
  assert.match(app, /function renderLibrary/);
  assert.match(app, /function hydrateLibraryDetail/);
  assert.match(app, /function openEpisodesModal/);

  assert.match(html, /class="modal-backdrop hidden" id="library-modal"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /id="library-modal-close"[^>]*aria-label="Close image details"/);
  assert.match(css, /\.library-card:focus-visible/);
  assert.match(css, /aspect-ratio:\s*4\s*\/\s*3/);
});

// Character sheet generation is a slow image request. Like every other long
// Generation Stage step it must register a tracked process, otherwise the
// floating bottom-right process widget never appears.
test('Character sheet generation shows the process tracker', () => {
  assert.match(app, /startProcess\(mode === 'sheet' \? 'Generating character sheet' : 'Generating character portrait'\)/);
  assert.match(app, /startProcess\('Generating character reference sheet'\)/);
  assert.match(app, /startProcess\(`Generating \$\{characters\.length\} character reference sheet\(s\)`\)/);
  assert.match(app, /updateProcess\(processId, `Generating character sheet \$\{index\} of \$\{characters\.length\}`\)/);
  assert.match(app, /if \(!ownedProcessId\) finishProcess\(processId\)/);
});
