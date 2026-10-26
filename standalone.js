'use strict';

// Standalone image generator storage: generated images that belong to no
// project, reusable prompt presets, and uploaded reference images.
//
// Generated images are also registered in the Library as project-less assets
// (see server.js), so `asset_id` links a generation to its Library asset.

const crypto = require('node:crypto');

let rawDb = null;

const MAX_PROMPT = 30000;
const MAX_PRESET_NAME = 120;

function now() {
  return new Date().toISOString();
}

function text(value, max) {
  const string = typeof value === 'string' ? value.trim() : '';
  return string.length > max ? string.slice(0, max) : string;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function schema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS standalone_generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      image_model TEXT NOT NULL,
      image_size TEXT NOT NULL,
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER,
      asset_id TEXT,
      asset_version_id TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_standalone_generations_user
      ON standalone_generations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generation_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generation_presets_user
      ON generation_presets(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generation_references (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generation_references_user
      ON generation_references(user_id, created_at DESC);
  `);
  const columns = rawDb.prepare('PRAGMA table_info(standalone_generations)').all();
  if (!columns.some((column) => column.name === 'composition_json')) {
    rawDb.exec('ALTER TABLE standalone_generations ADD COLUMN composition_json TEXT');
  }
}

function toGeneration(row) {
  let composition = null;
  try { composition = row.composition_json ? JSON.parse(row.composition_json) : null; } catch (_) { /* legacy row */ }
  return {
    id: row.id,
    prompt: row.prompt,
    imageModel: row.image_model,
    imageSize: row.image_size,
    file: row.file,
    mime: row.mime,
    bytes: row.bytes === null || row.bytes === undefined ? null : row.bytes,
    assetId: row.asset_id || '',
    assetVersionId: row.asset_version_id || '',
    references: parseJsonArray(row.references_json),
    composition,
    createdAt: row.created_at,
  };
}

function toPreset(row) {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReference(row) {
  return {
    id: row.id,
    file: row.file,
    mime: row.mime,
    bytes: row.bytes === null || row.bytes === undefined ? null : row.bytes,
    name: row.name || '',
    createdAt: row.created_at,
  };
}

function generationRow(userId, generationId) {
  return rawDb.prepare('SELECT * FROM standalone_generations WHERE id = ? AND user_id = ?')
    .get(text(generationId, 80), userId);
}

function list(userId) {
  return rawDb.prepare('SELECT * FROM standalone_generations WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(userId)
    .map(toGeneration);
}

function get(userId, generationId) {
  const row = generationRow(userId, generationId);
  return row ? toGeneration(row) : null;
}

function create(userId, data) {
  // The caller supplies the id so the row matches the image folder it wrote.
  const id = text(data && data.id, 80) || crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO standalone_generations
      (id, user_id, prompt, image_model, image_size, file, mime, bytes, asset_id, asset_version_id, references_json, composition_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    text(data && data.prompt, MAX_PROMPT),
    text(data && data.imageModel, 120),
    text(data && data.imageSize, 20),
    text(data && data.file, 200),
    text(data && data.mime, 80) || 'image/png',
    Number.isFinite(data && data.bytes) ? data.bytes : null,
    text(data && data.assetId, 80) || null,
    text(data && data.assetVersionId, 80) || null,
    JSON.stringify(Array.isArray(data && data.references) ? data.references.slice(0, 10) : []),
    data && data.composition ? JSON.stringify(data.composition) : null,
    now()
  );
  return get(userId, id);
}

function remove(userId, generationId) {
  const row = generationRow(userId, generationId);
  if (!row) return null;
  rawDb.prepare('DELETE FROM standalone_generations WHERE id = ? AND user_id = ?').run(row.id, userId);
  return toGeneration(row);
}

function listPresets(userId) {
  return rawDb.prepare('SELECT * FROM generation_presets WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(userId)
    .map(toPreset);
}

function createPreset(userId, data) {
  const id = crypto.randomUUID();
  const stamp = now();
  rawDb.prepare(`
    INSERT INTO generation_presets (id, user_id, name, text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    text(data && data.name, MAX_PRESET_NAME) || 'Untitled preset',
    text(data && data.text, MAX_PROMPT),
    stamp,
    stamp
  );
  return toPreset(rawDb.prepare('SELECT * FROM generation_presets WHERE id = ? AND user_id = ?').get(id, userId));
}

function updatePreset(userId, presetId, data) {
  const row = rawDb.prepare('SELECT * FROM generation_presets WHERE id = ? AND user_id = ?')
    .get(text(presetId, 80), userId);
  if (!row) return null;
  rawDb.prepare('UPDATE generation_presets SET name = ?, text = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(
      text(data && data.name, MAX_PRESET_NAME) || row.name,
      data && data.text !== undefined ? text(data.text, MAX_PROMPT) : row.text,
      now(),
      row.id,
      userId
    );
  return toPreset(rawDb.prepare('SELECT * FROM generation_presets WHERE id = ? AND user_id = ?').get(row.id, userId));
}

function removePreset(userId, presetId) {
  const row = rawDb.prepare('SELECT * FROM generation_presets WHERE id = ? AND user_id = ?')
    .get(text(presetId, 80), userId);
  if (!row) return null;
  rawDb.prepare('DELETE FROM generation_presets WHERE id = ? AND user_id = ?').run(row.id, userId);
  return toPreset(row);
}

function addReference(userId, data) {
  const id = text(data && data.id, 80) || crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO generation_references (id, user_id, file, mime, bytes, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    text(data && data.file, 200),
    text(data && data.mime, 80) || 'image/png',
    Number.isFinite(data && data.bytes) ? data.bytes : null,
    text(data && data.name, 200),
    now()
  );
  return referenceForUser(userId, id);
}

function referenceForUser(userId, referenceId) {
  const row = rawDb.prepare('SELECT * FROM generation_references WHERE id = ? AND user_id = ?')
    .get(text(referenceId, 80), userId);
  return row ? toReference(row) : null;
}

function listReferences(userId) {
  return rawDb.prepare('SELECT * FROM generation_references WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map(toReference);
}

function removeReference(userId, referenceId) {
  const row = rawDb.prepare('SELECT * FROM generation_references WHERE id = ? AND user_id = ?')
    .get(text(referenceId, 80), userId);
  if (!row) return null;
  rawDb.prepare('DELETE FROM generation_references WHERE id = ? AND user_id = ?').run(row.id, userId);
  return toReference(row);
}

function init(database) {
  rawDb = database;
  schema();
  return {
    list,
    get,
    create,
    remove,
    listPresets,
    createPreset,
    updatePreset,
    removePreset,
    addReference,
    referenceForUser,
    listReferences,
    removeReference,
  };
}

module.exports = { init };
