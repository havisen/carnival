'use strict';

// ---------------------------------------------------------------------------
// SQLite storage (built-in node:sqlite, no external dependencies)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  console.error(
    '\n  This app needs the built-in SQLite module, available in Node.js 23.4+.\n' +
      '  You are running %s. Install Node 24 LTS or newer and try again.\n',
    process.version
  );
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
// Keep the database (and WAL files) private even on shared hosting.
try {
  fs.chmodSync(path.dirname(DB_PATH), 0o700);
} catch (_) { /* Windows or restricted filesystems */ }

const db = new DatabaseSync(DB_PATH);

function createProjectsTableSql(ifNotExists = true) {
  return `
  CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}projects (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    idea        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    reference_material TEXT NOT NULL DEFAULT '',
    scenes      TEXT NOT NULL DEFAULT '[]',
    generation_prompts TEXT NOT NULL DEFAULT '[]',
    character_references TEXT NOT NULL DEFAULT '[]',
    scene_images TEXT NOT NULL DEFAULT '[]',
    stage       TEXT NOT NULL DEFAULT 'Idea Stage'
                CHECK (stage IN ('Idea Stage', 'Reference Stage', 'Generation Stage')),
    status      TEXT NOT NULL DEFAULT 'Not Started'
                CHECK (status IN ('Not Started', 'In Progress', 'Done')),
    priority    TEXT NOT NULL DEFAULT 'Medium'
                CHECK (priority IN ('Low', 'Medium', 'High')),
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `;
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    api_key_enc   TEXT,
    api_key_hint  TEXT,
    byteplus_api_key_enc TEXT,
    byteplus_api_key_hint TEXT,
    text_model    TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
    image_model   TEXT NOT NULL DEFAULT 'dola-seedream-5-0-pro-260628',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

  ${createProjectsTableSql()}

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at DESC);
`);

// Normalize retired choices while preserving all supported provider models.
db.prepare("UPDATE users SET text_model = 'deepseek-v4-pro' WHERE text_model <> 'deepseek-v4-pro'").run();
const supportedImageModels = require('./public/image-models').map((model) => model.id);
db.prepare(`UPDATE users SET image_model = 'dola-seedream-5-0-pro-260628' WHERE image_model NOT IN (${supportedImageModels.map(() => '?').join(',')})`).run(...supportedImageModels);

// ---------------------------------------------------------------------------
// Migrate projects created before the idea/stage fields and "Not Started"
// status existed. SQLite cannot alter CHECK constraints, so rebuild the table.
// ---------------------------------------------------------------------------

const projectsTableInfo = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
  .get();
const projectColumns = new Set(
  db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name)
);

const needsProjectMigration =
  !projectColumns.has('idea') ||
  !projectColumns.has('stage') ||
  String(projectsTableInfo && projectsTableInfo.sql).includes('Backlog');

if (needsProjectMigration) {
  console.log('  Migrating projects: adding idea/stage and renaming Backlog to Not Started...');

  const hasIdeaColumn = projectColumns.has('idea');
  const ideaSelect = hasIdeaColumn
    ? 'idea'
    : "CASE WHEN source = 'idea' THEN description ELSE '' END";
  const descriptionSelect = hasIdeaColumn
    ? 'description'
    : "CASE WHEN source = 'idea' THEN '' ELSE description END";
  const referenceSelect = projectColumns.has('reference_material') ? 'reference_material' : "''";
  const scenesSelect = projectColumns.has('scenes') ? 'scenes' : "'[]'";
  const promptsSelect = projectColumns.has('generation_prompts') ? 'generation_prompts' : "'[]'";
  const characterRefsSelect = projectColumns.has('character_references') ? 'character_references' : "'[]'";
  const sceneImagesSelect = projectColumns.has('scene_images') ? 'scene_images' : "'[]'";
  const stageSelect = projectColumns.has('stage') ? 'stage' : "'Idea Stage'";

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE projects RENAME TO projects_legacy');
    db.exec(createProjectsTableSql(false));
    db.exec(`
      INSERT INTO projects
        (id, user_id, title, idea, description, reference_material, scenes, generation_prompts, character_references, scene_images, stage, status, priority, source, created_at, updated_at)
      SELECT
        id,
        user_id,
        title,
        ${ideaSelect},
        ${descriptionSelect},
        ${referenceSelect},
        ${scenesSelect},
        ${promptsSelect},
        ${characterRefsSelect},
        ${sceneImagesSelect},
        ${stageSelect},
        CASE status WHEN 'Backlog' THEN 'Not Started' ELSE status END,
        priority,
        source,
        created_at,
        updated_at
      FROM projects_legacy
    `);
    db.exec('DROP TABLE projects_legacy');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at DESC)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
} else {
  const additions = [
    ['reference_material', "TEXT NOT NULL DEFAULT ''"],
    ['scenes', "TEXT NOT NULL DEFAULT '[]'"],
    ['generation_prompts', "TEXT NOT NULL DEFAULT '[]'"],
    ['character_references', "TEXT NOT NULL DEFAULT '[]'"],
    ['scene_images', "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [column, definition] of additions) {
    if (projectColumns.has(column)) continue;
    console.log(`  Migrating projects: adding ${column}...`);
    db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${definition}`);
  }
}

// ---------------------------------------------------------------------------
// User columns added after the first release (BytePlus image API key).
// ---------------------------------------------------------------------------

const userColumns = new Set(
  db.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
);
for (const [column, definition] of [
  ['byteplus_api_key_enc', 'TEXT'],
  ['byteplus_api_key_hint', 'TEXT'],
  ['text_model', "TEXT NOT NULL DEFAULT 'deepseek-v4-pro'"],
  ['text_provider', "TEXT NOT NULL DEFAULT 'deepseek'"],
  ['image_model', "TEXT NOT NULL DEFAULT 'dola-seedream-5-0-pro-260628'"],
  ['anthropic_api_key_enc', 'TEXT'],
  ['anthropic_api_key_hint', 'TEXT'],
  ['openai_api_key_enc', 'TEXT'],
  ['openai_api_key_hint', 'TEXT'],
  ['openai_base_url', "TEXT NOT NULL DEFAULT ''"],
  ['openai_direct_api_key_enc', 'TEXT'],
  ['openai_direct_api_key_hint', 'TEXT'],
  ['openai_image_provider', "TEXT NOT NULL DEFAULT 'openai'"],
  ['guide_provider', "TEXT NOT NULL DEFAULT 'deepseek'"],
  ['guide_model', "TEXT NOT NULL DEFAULT ''"],
  ['guide_context', "TEXT NOT NULL DEFAULT ''"],
  ['reviewer_provider', "TEXT NOT NULL DEFAULT 'deepseek'"],
  ['reviewer_model', "TEXT NOT NULL DEFAULT ''"],
  ['reviewer_context', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (userColumns.has(column)) continue;
  console.log(`  Migrating users: adding ${column}...`);
  db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, username, password_hash, password_salt, created_at, openai_image_provider)
  VALUES (?, ?, ?, ?, ?, 'openai-direct')
`);
const userByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const userByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const setApiKeyStmt = db.prepare('UPDATE users SET api_key_enc = ?, api_key_hint = ? WHERE id = ?');
const setBytePlusKeyStmt = db.prepare(
  'UPDATE users SET byteplus_api_key_enc = ?, byteplus_api_key_hint = ? WHERE id = ?'
);
const setAISettingsStmt = db.prepare(
  'UPDATE users SET text_model = ?, image_model = ?, openai_image_provider = ?, text_provider = ? WHERE id = ?'
);
const setAnthropicKeyStmt = db.prepare(
  'UPDATE users SET anthropic_api_key_enc = ?, anthropic_api_key_hint = ? WHERE id = ?'
);
const setOpenAIKeyStmt = db.prepare(
  'UPDATE users SET openai_api_key_enc = ?, openai_api_key_hint = ?, openai_base_url = ? WHERE id = ?'
);
const setDirectOpenAIKeyStmt = db.prepare(
  'UPDATE users SET openai_direct_api_key_enc = ?, openai_direct_api_key_hint = ? WHERE id = ?'
);
const setChatSettingsStmt = db.prepare(`
  UPDATE users SET guide_provider = ?, guide_model = ?, guide_context = ?,
    reviewer_provider = ?, reviewer_model = ?, reviewer_context = ? WHERE id = ?
`);

function createUser({ id, username, passwordHash, passwordSalt }) {
  insertUserStmt.run(id, username, passwordHash, passwordSalt, new Date().toISOString());
  return getUserById(id);
}

function getUserByUsername(username) {
  return userByUsernameStmt.get(username);
}

function getUserById(id) {
  return userByIdStmt.get(id);
}

function setUserApiKey(userId, encrypted, hint) {
  setApiKeyStmt.run(encrypted, hint, userId);
  return getUserById(userId);
}

function setUserBytePlusKey(userId, encrypted, hint) {
  setBytePlusKeyStmt.run(encrypted, hint, userId);
  return getUserById(userId);
}

function setUserAISettings(userId, textModel, imageModel, openAIImageProvider = getUserById(userId).openai_image_provider, textProvider = getUserById(userId).text_provider) {
  setAISettingsStmt.run(textModel, imageModel, openAIImageProvider, textProvider, userId);
  return getUserById(userId);
}

function setUserAnthropicKey(userId, encrypted, hint) {
  setAnthropicKeyStmt.run(encrypted, hint, userId);
  return getUserById(userId);
}

function setUserOpenAIKey(userId, encrypted, hint, baseUrl) {
  setOpenAIKeyStmt.run(encrypted, hint, baseUrl, userId);
  return getUserById(userId);
}

function setUserDirectOpenAIKey(userId, encrypted, hint) {
  setDirectOpenAIKeyStmt.run(encrypted, hint, userId);
  return getUserById(userId);
}

function setUserChatSettings(userId, settings) {
  setChatSettingsStmt.run(
    settings.guideProvider,
    settings.guideModel,
    settings.guideContext,
    settings.reviewerProvider,
    settings.reviewerModel,
    settings.reviewerContext,
    userId
  );
  return getUserById(userId);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
`);
const sessionStmt = db.prepare(`
  SELECT s.token_hash, s.user_id, s.expires_at,
         u.username, u.api_key_enc, u.api_key_hint,
         u.byteplus_api_key_enc, u.byteplus_api_key_hint,
         u.text_model, u.image_model, u.created_at,
         u.text_provider,
         u.anthropic_api_key_enc, u.anthropic_api_key_hint,
         u.openai_api_key_enc, u.openai_api_key_hint, u.openai_base_url,
         u.openai_direct_api_key_enc, u.openai_direct_api_key_hint, u.openai_image_provider,
         u.guide_provider, u.guide_model, u.guide_context,
         u.reviewer_provider, u.reviewer_model, u.reviewer_context
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const deleteUserSessionsStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');

function createSession({ tokenHash, userId, expiresAt }) {
  insertSessionStmt.run(tokenHash, userId, expiresAt, new Date().toISOString());
}

function getSession(tokenHash) {
  return sessionStmt.get(tokenHash);
}

function deleteSession(tokenHash) {
  deleteSessionStmt.run(tokenHash);
}

function deleteExpiredSessions(now = Date.now()) {
  deleteExpiredStmt.run(now);
}

function deleteUserSessions(userId) {
  deleteUserSessionsStmt.run(userId);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const listProjectsStmt = db.prepare(`
  SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC
`);
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?');
const insertProjectStmt = db.prepare(`
  INSERT INTO projects
    (id, user_id, title, idea, description, reference_material, scenes, generation_prompts, character_references, scene_images, stage, status, priority, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?');
const countProjectsStmt = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?');
const titleExistsStmt = db.prepare('SELECT 1 AS hit FROM projects WHERE user_id = ? AND title = ? LIMIT 1');

const PROJECT_COLUMNS = new Set([
  'title',
  'idea',
  'description',
  'reference_material',
  'scenes',
  'generation_prompts',
  'character_references',
  'scene_images',
  'stage',
  'status',
  'priority',
  'source',
]);

const PROJECT_STATUSES = ['Not Started', 'In Progress', 'Done'];
const PROJECT_STAGES = ['Idea Stage', 'Reference Stage', 'Generation Stage'];

function parseStoredArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function toProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    idea: row.idea,
    description: row.description,
    referenceMaterial: row.reference_material,
    scenes: parseStoredArray(row.scenes),
    generationPrompts: parseStoredArray(row.generation_prompts),
    characterReferences: parseStoredArray(row.character_references),
    sceneImages: parseStoredArray(row.scene_images),
    stage: row.stage,
    status: row.status,
    priority: row.priority,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listProjects(userId) {
  return listProjectsStmt.all(userId).map(toProject);
}

function getProject(userId, id) {
  return toProject(getProjectStmt.get(id, userId));
}

function createProject(userId, data) {
  const now = new Date().toISOString();
  const id = data.id || crypto.randomUUID();
  insertProjectStmt.run(
    id,
    userId,
    data.title,
    data.idea || '',
    data.description || '',
    data.reference_material || '',
    JSON.stringify(Array.isArray(data.scenes) ? data.scenes : []),
    JSON.stringify(Array.isArray(data.generation_prompts) ? data.generation_prompts : []),
    JSON.stringify(Array.isArray(data.character_references) ? data.character_references : []),
    JSON.stringify(Array.isArray(data.scene_images) ? data.scene_images : []),
    data.stage || 'Idea Stage',
    data.status || 'Not Started',
    data.priority || 'Medium',
    data.source || 'manual',
    data.createdAt || now,
    now
  );
  return getProject(userId, id);
}

function updateProject(userId, id, patch) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!PROJECT_COLUMNS.has(key) || value === undefined) continue;
    fields.push(`${key} = ?`);
    if (key === 'scenes' || key === 'generation_prompts' || key === 'character_references' || key === 'scene_images') {
      values.push(JSON.stringify(Array.isArray(value) ? value : []));
    } else {
      values.push(value);
    }
  }
  if (!fields.length) return getProject(userId, id);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString(), id, userId);

  const info = db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  if (!info.changes) return null;
  return getProject(userId, id);
}

function deleteProject(userId, id) {
  return deleteProjectStmt.run(id, userId).changes > 0;
}

function countProjects(userId) {
  return countProjectsStmt.get(userId).n;
}

/**
 * One-shot import of projects from the old localStorage-only version.
 * Skips titles the account already has, so a retry cannot duplicate data.
 */
function importProjects(userId, items) {
  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const item of items) {
      const title = String(item && item.title ? item.title : '').trim().slice(0, 200);
      if (!title) continue;
      if (titleExistsStmt.get(userId, title)) continue;

      const rawIdea = String(item.idea || '').slice(0, 5000);
      const rawDescription = String(item.description || '').slice(0, 5000);
      const source = item.source === 'idea' ? 'idea' : 'manual';
      // In the old version, idea-generator imports were stored in description.
      const idea = rawIdea || (source === 'idea' ? rawDescription : '');
      const description = source === 'idea' && !rawIdea ? '' : rawDescription;
      const referenceMaterial = String(item.referenceMaterial || '').slice(0, 100000);
      const scenes = Array.isArray(item.scenes) ? item.scenes.slice(0, 20) : [];
      const generationPrompts = Array.isArray(item.generationPrompts)
        ? item.generationPrompts.slice(0, 20)
        : [];
      const characterReferences = Array.isArray(item.characterReferences)
        ? item.characterReferences.slice(0, 8)
        : [];
      const sceneImages = Array.isArray(item.sceneImages) ? item.sceneImages.slice(0, 50) : [];
      const stage = PROJECT_STAGES.includes(item.stage) ? item.stage : 'Idea Stage';
      const status = item.status === 'Backlog'
        ? 'Not Started'
        : PROJECT_STATUSES.includes(item.status)
          ? item.status
          : 'Not Started';
      const priority = ['Low', 'Medium', 'High'].includes(item.priority) ? item.priority : 'Medium';
      const created = item.createdAt && !Number.isNaN(Date.parse(item.createdAt))
        ? new Date(item.createdAt).toISOString()
        : new Date().toISOString();

      insertProjectStmt.run(
        crypto.randomUUID(),
        userId,
        title,
        idea,
        description,
        referenceMaterial,
        JSON.stringify(scenes),
        JSON.stringify(generationPrompts),
        JSON.stringify(characterReferences),
        JSON.stringify(sceneImages),
        stage,
        status,
        priority,
        source,
        created,
        new Date().toISOString()
      );
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return imported;
}

module.exports = {
  DATA_DIR,
  DB_PATH,
  db,
  createUser,
  getUserByUsername,
  getUserById,
  setUserApiKey,
  setUserBytePlusKey,
  setUserAISettings,
  setUserAnthropicKey,
  setUserOpenAIKey,
  setUserDirectOpenAIKey,
  setUserChatSettings,
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
  deleteUserSessions,
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  countProjects,
  importProjects,
};
