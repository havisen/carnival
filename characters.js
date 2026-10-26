'use strict';

// ---------------------------------------------------------------------------
// Character maker
//
// Standalone, user-scoped characters that are not tied to any project. Each
// character keeps an append-only list of generated image versions, and exactly
// one version can be final at a time.
//
// Nothing here approves or publishes anything: "final" only marks which image
// is this character's current reference, and the review checklist in reviews.js
// is unaffected.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

let rawDb = null;

const MODES = new Set(['portrait', 'sheet']);

function now() {
  return new Date().toISOString();
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function schema() {
  rawDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS maker_characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      final_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maker_characters_user ON maker_characters(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS maker_character_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES maker_characters(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('portrait', 'sheet')),
      file TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'image/png',
      size TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      image_model TEXT NOT NULL DEFAULT '',
      image_size TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (character_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_maker_versions_character ON maker_character_versions(character_id, version DESC);
  `);

  // project_id arrived after the first release: add it to existing databases.
  const columns = rawDb.prepare('PRAGMA table_info(maker_characters)').all().map((column) => column.name);
  if (!columns.includes('project_id')) {
    rawDb.exec('ALTER TABLE maker_characters ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE');
  }
  rawDb.exec('CREATE INDEX IF NOT EXISTS idx_maker_characters_project ON maker_characters(user_id, project_id, created_at DESC)');
}

function toVersion(row) {
  return {
    id: row.id,
    characterId: row.character_id,
    version: row.version,
    mode: row.mode,
    file: row.file,
    mime: row.mime,
    size: row.size,
    prompt: row.prompt,
    imageModel: row.image_model,
    imageSize: row.image_size,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionRows(characterId) {
  return rawDb.prepare(
    'SELECT * FROM maker_character_versions WHERE character_id = ? ORDER BY version DESC'
  ).all(characterId);
}

function toCharacter(row, versions) {
  const list = versions || versionRows(row.id);
  return {
    id: row.id,
    projectId: row.project_id || '',
    name: row.name,
    description: row.description || '',
    finalVersionId: row.final_version_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versionCount: list.length,
    versions: list.map(toVersion),
  };
}

function characterRow(userId, characterId) {
  return rawDb.prepare('SELECT * FROM maker_characters WHERE id = ? AND user_id = ?')
    .get(text(characterId, 80), userId);
}

// Without a projectId this lists standalone characters only, so the Character
// maker tab never shows project characters (and the reverse).
function list(userId, projectId = '') {
  const scope = text(projectId, 80);
  const rows = scope
    ? rawDb.prepare('SELECT * FROM maker_characters WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC')
      .all(userId, scope)
    : rawDb.prepare('SELECT * FROM maker_characters WHERE user_id = ? AND project_id IS NULL ORDER BY created_at DESC')
      .all(userId);
  return rows.map((row) => toCharacter(row));
}

function get(userId, characterId) {
  const row = characterRow(userId, characterId);
  return row ? toCharacter(row) : null;
}

function cleanName(value) {
  const name = text(value, 120);
  if (!name) throw Object.assign(new Error('Character name is required.'), { status: 400 });
  return name;
}

function create(userId, data) {
  const created = now();
  const characterId = crypto.randomUUID();
  const projectId = text(data && data.projectId, 80) || null;
  rawDb.prepare(`
    INSERT INTO maker_characters (id, user_id, project_id, name, description, final_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    characterId,
    userId,
    projectId,
    cleanName(data && data.name),
    text(data && data.description, 6000),
    created,
    created
  );
  return get(userId, characterId);
}

function update(userId, characterId, data) {
  const row = characterRow(userId, characterId);
  if (!row) return null;
  const patch = data || {};
  const name = patch.name === undefined ? row.name : cleanName(patch.name);
  const description = patch.description === undefined ? row.description : text(patch.description, 6000);
  rawDb.prepare('UPDATE maker_characters SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, description, now(), row.id, userId);
  return get(userId, row.id);
}

// Returns the removed character (with its versions) so the caller can clean up
// the image files on disk, or null when it does not exist for this user.
function remove(userId, characterId) {
  const row = characterRow(userId, characterId);
  if (!row) return null;
  const character = toCharacter(row);
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare('DELETE FROM maker_character_versions WHERE character_id = ? AND user_id = ?').run(row.id, userId);
    rawDb.prepare('DELETE FROM maker_characters WHERE id = ? AND user_id = ?').run(row.id, userId);
    rawDb.exec('COMMIT');
  } catch (err) {
    rawDb.exec('ROLLBACK');
    throw err;
  }
  return character;
}

function addVersion(userId, characterId, data) {
  const row = characterRow(userId, characterId);
  if (!row) return null;
  const mode = text(data && data.mode, 20);
  if (!MODES.has(mode)) throw Object.assign(new Error('Choose portrait or character sheet.'), { status: 400 });
  const versionRow = rawDb.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM maker_character_versions WHERE character_id = ?'
  ).get(row.id);
  const version = versionRow.version + 1;
  const created = now();
  const versionId = crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO maker_character_versions
      (id, user_id, character_id, version, mode, file, mime, size, prompt,
       image_model, image_size, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    versionId,
    userId,
    row.id,
    version,
    mode,
    text(data.file, 200),
    text(data.mime, 80) || 'image/png',
    text(data.size, 20),
    text(data.prompt, 30000),
    text(data.imageModel, 100),
    text(data.imageSize, 20),
    created,
    created
  );
  rawDb.prepare('UPDATE maker_characters SET updated_at = ? WHERE id = ? AND user_id = ?').run(created, row.id, userId);
  return toVersion(rawDb.prepare('SELECT * FROM maker_character_versions WHERE id = ?').get(versionId));
}

// Exactly one final version per character, mirroring character_sheets.
function promoteVersion(userId, characterId, versionId) {
  const row = characterRow(userId, characterId);
  if (!row) return null;
  const version = rawDb.prepare(
    'SELECT * FROM maker_character_versions WHERE id = ? AND character_id = ? AND user_id = ?'
  ).get(text(versionId, 80), row.id, userId);
  if (!version) return null;
  const updated = now();
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare(`UPDATE maker_character_versions SET status = 'draft', updated_at = ?
      WHERE character_id = ? AND user_id = ? AND id != ? AND status = 'final'`)
      .run(updated, row.id, userId, version.id);
    rawDb.prepare('UPDATE maker_character_versions SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run('final', updated, version.id, userId);
    rawDb.prepare('UPDATE maker_characters SET final_version_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(version.id, updated, row.id, userId);
    rawDb.exec('COMMIT');
  } catch (err) {
    rawDb.exec('ROLLBACK');
    throw err;
  }
  return get(userId, row.id);
}

function versionByFile(userId, characterId, file) {
  const row = characterRow(userId, characterId);
  if (!row) return null;
  const version = rawDb.prepare(
    'SELECT * FROM maker_character_versions WHERE character_id = ? AND user_id = ? AND file = ?'
  ).get(row.id, userId, text(file, 200));
  return version ? toVersion(version) : null;
}

// Any version owned by this user, whichever character holds it. Used when
// copying a standalone maker image into a project character.
function versionForUser(userId, versionId) {
  const row = rawDb.prepare('SELECT * FROM maker_character_versions WHERE id = ? AND user_id = ?')
    .get(text(versionId, 80), userId);
  return row ? toVersion(row) : null;
}

function init(database) {
  rawDb = database;
  schema();
  return {
    list,
    get,
    create,
    update,
    remove,
    addVersion,
    promoteVersion,
    versionByFile,
    versionForUser,
    toCharacter,
    toVersion,
  };
}

module.exports = { init };