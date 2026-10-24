'use strict';

// ---------------------------------------------------------------------------
// Phase 3 story workspace
//
// Structured story records live in SQLite. projects.scenes remains the scene
// ordering/projection consumed by the existing Generation Stage, and
// projects.generation_prompts remains a compatibility projection of the latest
// prompt draft for each scene.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let rawDb = null;
let dbPath = null;

const TEXT_MODEL = 'deepseek-v4-pro';
const IMAGE_MODEL = 'dola-seedream-5-0-pro-260628';
const IMAGE_SIZES = ['1K', '1.5K', '2K'];
const PROMPT_STATUSES = new Set(['draft', 'final']);

function id(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : crypto.randomUUID();
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function parseArray(value) {
  return Array.isArray(value) ? value : [];
}

function now() {
  return new Date().toISOString();
}

function workspaceError(message, code = 'INVALID_WORKSPACE') {
  return Object.assign(new Error(message), { status: 502, code });
}

/**
 * Parse and validate the structured `storyWorkspace` block returned by DeepSeek.
 * This is a pure function (no database access) so it can be unit-tested and
 * shared between the Reference Stage generation path and the Story Workspace
 * "generate from reference" path.
 *
 * @param {object|null} workspace  Raw `storyWorkspace` value.
 * @param {Array<{name:string, gender:string}>} suppliedCharacters  The exact
 *   characters the caller supplied, in order.
 * @returns {object} A normalized, capped workspace shape.
 * @throws {Error} with `.status = 502` on any malformed, incomplete, oversized,
 *   duplicate, or mismatched payload.
 */
function normalizeStoryWorkspace(workspace, suppliedCharacters) {
  const supplied = Array.isArray(suppliedCharacters) ? suppliedCharacters : [];
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw workspaceError('The reference response did not include a structured story workspace.');
  }

  const requiredString = (value, label, max) => {
    const out = text(value, max);
    if (!out) throw workspaceError(`The story workspace is missing ${label}.`);
    return out;
  };

  const briefRaw = workspace.brief && typeof workspace.brief === 'object' ? workspace.brief : {};
  const brief = {
    title: requiredString(briefRaw.title, 'a story title', 200),
    logline: requiredString(briefRaw.logline, 'a logline', 500),
    premise: requiredString(briefRaw.premise, 'a premise', 5000),
    tone: requiredString(briefRaw.tone, 'a tone', 200),
    genre: requiredString(briefRaw.genre, 'a genre', 200),
    audience: requiredString(briefRaw.audience, 'an audience', 200),
    setting: requiredString(briefRaw.setting, 'a setting summary', 3000),
  };

  const charArr = workspace.characters;
  if (!Array.isArray(charArr) || charArr.length !== supplied.length) {
    throw workspaceError(
      `The story workspace must include exactly one character record per supplied character (expected ${supplied.length}).`
    );
  }
  const characters = charArr.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const name = text(item.name, 120);
    const expected = supplied[index] || {};
    if (!name || name.toLowerCase() !== String(expected.name || '').toLowerCase()) {
      throw workspaceError(`Character ${index + 1} in the story workspace must be named "${expected.name}".`);
    }
    const gender = text(item.gender, 40);
    if (!gender || gender.toLowerCase() !== String(expected.gender || '').toLowerCase()) {
      throw workspaceError(`Character "${expected.name}" has an unexpected gender.`);
    }
    return {
      name: expected.name,
      gender: expected.gender,
      age: requiredString(item.age, `an age for "${expected.name}"`, 80),
      appearance: requiredString(item.appearance, `an appearance for "${expected.name}"`, 5000),
      wardrobe: requiredString(item.wardrobe, `a wardrobe for "${expected.name}"`, 5000),
      continuityNotes: requiredString(item.continuityNotes, `continuity notes for "${expected.name}"`, 5000),
    };
  });

  const seenCharacterNames = new Set();
  for (const character of characters) {
    const lower = character.name.toLowerCase();
    if (seenCharacterNames.has(lower)) throw workspaceError(`Duplicate character "${character.name}".`);
    seenCharacterNames.add(lower);
  }

  const locArr = workspace.locations;
  if (!Array.isArray(locArr) || !locArr.length) {
    throw workspaceError('The story workspace must include at least one location.');
  }
  if (locArr.length > 20) throw workspaceError('The story workspace has too many locations (max 20).');
  const locations = [];
  const seenLocationNames = new Set();
  for (const raw of locArr) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const name = text(item.name, 200);
    if (!name) throw workspaceError('A location in the story workspace is missing a name.');
    const lower = name.toLowerCase();
    if (seenLocationNames.has(lower)) throw workspaceError(`Duplicate location "${name}".`);
    seenLocationNames.add(lower);
    locations.push({
      name,
      description: requiredString(item.description, `a description for "${name}"`, 5000),
      lighting: requiredString(item.lighting, `lighting for "${name}"`, 2000),
      continuityNotes: requiredString(item.continuityNotes, `continuity notes for "${name}"`, 5000),
    });
  }

  const styleArr = workspace.styles;
  if (!Array.isArray(styleArr) || !styleArr.length) {
    throw workspaceError('The story workspace must include at least one style reference.');
  }
  if (styleArr.length > 5) throw workspaceError('The story workspace has too many styles (max 5).');
  const styles = styleArr.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const name = text(item.name, 200);
    if (!name) throw workspaceError('A style reference in the story workspace is missing a name.');
    return {
      name,
      description: requiredString(item.description, `a description for "${name}"`, 5000),
      guidance: requiredString(item.guidance, `visual guidance for "${name}"`, 5000),
      exclusions: Array.isArray(item.exclusions)
        ? item.exclusions.map((value) => text(value, 300)).filter(Boolean).slice(0, 30)
        : [],
    };
  });

  const sceneArr = workspace.scenes;
  if (!Array.isArray(sceneArr) || sceneArr.length < 6 || sceneArr.length > 10) {
    throw workspaceError('The story workspace must include 6 to 10 scenes.');
  }
  const locationNameSet = new Set(locations.map((location) => location.name.toLowerCase()));
  const characterNameSet = new Set(characters.map((character) => character.name.toLowerCase()));
  const scenes = sceneArr.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const title = requiredString(item.title, `a title for scene ${index + 1}`, 200);
    const beat = requiredString(item.beat, `a beat for scene ${index + 1}`, 2000);
    const action = requiredString(item.action, `an action for scene ${index + 1}`, 5000);
    const props = text(item.props, 2000);
    const location = requiredString(item.location, `a location for scene ${index + 1}`, 200);
    if (!locationNameSet.has(location.toLowerCase())) {
      throw workspaceError(`Scene "${title}" references location "${location}", which is not in the story workspace locations.`);
    }
    const sceneCharacters = Array.isArray(item.characters)
      ? item.characters.map((name) => text(name, 120)).filter(Boolean).slice(0, 12)
      : [];
    if (!sceneCharacters.length) {
      throw workspaceError(`Scene "${title}" has no characters.`);
    }
    for (const name of sceneCharacters) {
      if (!characterNameSet.has(name.toLowerCase())) {
        throw workspaceError(`Scene "${title}" references character "${name}", which is not in the story workspace characters.`);
      }
    }
    return { title, beat, action, props, location, characters: sceneCharacters };
  });

  return { brief, characters, locations, styles, scenes };
}

function schema() {
  // Character sheets were originally text-based drafts; they are now images.
  // Drop the obsolete text-shaped table so it can be recreated as image rows.
  const sheetTable = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_sheets'").get();
  if (sheetTable) {
    const sheetColumns = rawDb.prepare('PRAGMA table_info(character_sheets)').all().map((column) => column.name);
    if (sheetColumns.includes('text')) {
      rawDb.exec('DROP TABLE character_sheets');
    }
  }

  rawDb.exec(`    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS story_briefs (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      logline TEXT NOT NULL DEFAULT '',
      premise TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT '',
      setting TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_bibles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT '',
      age TEXT NOT NULL DEFAULT '',
      appearance TEXT NOT NULL DEFAULT '',
      wardrobe TEXT NOT NULL DEFAULT '',
      continuity_notes TEXT NOT NULL DEFAULT '',
      legacy_material TEXT NOT NULL DEFAULT '',
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_character_bibles_project ON character_bibles(project_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS location_refs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lighting TEXT NOT NULL DEFAULT '',
      continuity_notes TEXT NOT NULL DEFAULT '',
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_location_refs_project ON location_refs(project_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS style_refs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      guidance TEXT NOT NULL DEFAULT '',
      exclusions_json TEXT NOT NULL DEFAULT '[]',
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_style_refs_project ON style_refs(project_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS prompt_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scene_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
      exclusions_json TEXT NOT NULL DEFAULT '[]',
      reference_roles_json TEXT NOT NULL DEFAULT '{}',
      text_model TEXT NOT NULL DEFAULT '',
      temperature REAL,
      max_tokens INTEGER,
      image_model TEXT NOT NULL DEFAULT '',
      image_size TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, scene_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_drafts_scene ON prompt_drafts(project_id, scene_id, version DESC);

    CREATE TABLE IF NOT EXISTS character_sheets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES character_bibles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      file TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'image/png',
      size TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      image_model TEXT NOT NULL DEFAULT '',
      image_size TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
      source TEXT NOT NULL DEFAULT 'generated',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, character_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_character_sheets_char ON character_sheets(project_id, character_id, version DESC);

    CREATE TABLE IF NOT EXISTS story_worksheets (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      setting TEXT NOT NULL DEFAULT '',
      actions_json TEXT NOT NULL DEFAULT '[]',
      locations_json TEXT NOT NULL DEFAULT '[]'
    );


    CREATE TABLE IF NOT EXISTS story_sync (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      migrated_at TEXT NOT NULL
    );
  `);
}

function projectRow(projectId) {
  return rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
}

function projectForUser(userId, projectId) {
  return rawDb.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
}

function parseScenes(project) {
  return parseArray(parseJson(project.scenes, []));
}

function characterRows(projectId) {
  return rawDb.prepare('SELECT * FROM character_bibles WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(projectId);
}

function locationRows(projectId) {
  return rawDb.prepare('SELECT * FROM location_refs WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(projectId);
}

function styleRows(projectId) {
  return rawDb.prepare('SELECT * FROM style_refs WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(projectId);
}

function promptRows(projectId) {
  return rawDb.prepare('SELECT * FROM prompt_drafts WHERE project_id = ? ORDER BY scene_id, version ASC').all(projectId);
}

function characterSheetRows(projectId) {
  return rawDb.prepare('SELECT * FROM character_sheets WHERE project_id = ? ORDER BY character_id, version ASC').all(projectId);
}

function worksheetForUser(userId, projectId) {
  const row = rawDb.prepare('SELECT * FROM story_worksheets WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  return {
    setting: row ? row.setting : '',
    actions: row ? parseArray(parseJson(row.actions_json, [])) : [],
    locations: row ? parseArray(parseJson(row.locations_json, [])) : [],
  };
}

function setWorksheetSetting(userId, projectId, setting) {
  if (!projectForUser(userId, projectId)) return null;
  rawDb.prepare(`INSERT INTO story_worksheets (project_id, user_id, setting) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET setting = excluded.setting`).run(projectId, userId, text(setting, 2000));
  return worksheetForUser(userId, projectId);
}

function saveWorksheetActions(userId, projectId, actions) {
  if (!projectForUser(userId, projectId)) return null;
  const worksheet = worksheetForUser(userId, projectId);
  const scenes = actions.map((item, index) => ({
    id: crypto.randomUUID(), order: index, title: `Scene ${index + 1}`,
    action: `${item.action} ${item.locationSentence}`,
    location: item.location, characters: item.characters,
  }));
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare(`INSERT INTO story_worksheets (project_id, user_id, actions_json, locations_json) VALUES (?, ?, ?, '[]')
      ON CONFLICT(project_id) DO UPDATE SET actions_json = excluded.actions_json, locations_json = '[]'`)
      .run(projectId, userId, JSON.stringify(actions));
    updateProjectScenes(projectId, scenes);
    rawDb.exec('COMMIT');
  } catch (err) {
    rawDb.exec('ROLLBACK');
    throw err;
  }
  return { ...worksheet, actions, locations: [] };
}

function saveWorksheetLocations(userId, projectId, locations) {
  if (!projectForUser(userId, projectId)) return null;
  const worksheet = worksheetForUser(userId, projectId);
  if (!worksheet.actions.length) throw Object.assign(new Error('Save action references first.'), { status: 409 });
  rawDb.prepare(`INSERT INTO story_worksheets (project_id, user_id, locations_json) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET locations_json = excluded.locations_json`)
    .run(projectId, userId, JSON.stringify(locations));
  return worksheetForUser(userId, projectId);
}


function toCharacter(row) {
  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    age: row.age,
    appearance: row.appearance,
    wardrobe: row.wardrobe,
    continuityNotes: row.continuity_notes,
    legacyMaterial: row.legacy_material,
    approved: Boolean(row.approved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLocation(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lighting: row.lighting,
    continuityNotes: row.continuity_notes,
    approved: Boolean(row.approved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStyle(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    guidance: row.guidance,
    exclusions: parseArray(parseJson(row.exclusions_json, [])),
    approved: Boolean(row.approved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPrompt(row) {
  return {
    id: row.id,
    sceneId: row.scene_id,
    version: row.version,
    text: row.text,
    status: row.status,
    exclusions: parseArray(parseJson(row.exclusions_json, [])),
    referenceRoles: parseJson(row.reference_roles_json, {}),
    model: {
      id: row.text_model || '',
      temperature: row.temperature === null || row.temperature === undefined ? null : row.temperature,
      maxTokens: row.max_tokens === null || row.max_tokens === undefined ? null : row.max_tokens,
    },
    imageSettings: row.image_model || row.image_size
      ? { model: row.image_model || '', size: row.image_size || '' }
      : null,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCharacterSheet(row) {
  return {
    id: row.id,
    characterId: row.character_id,
    version: row.version,
    file: row.file,
    mime: row.mime,
    size: row.size,
    prompt: row.prompt,
    imageModel: row.image_model,
    imageSize: row.image_size,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function briefFor(projectId) {
  return rawDb.prepare('SELECT * FROM story_briefs WHERE project_id = ?').get(projectId);
}

function briefFromProject(project) {
  return {
    title: project.title || '',
    logline: '',
    premise: project.idea || '',
    tone: '',
    genre: '',
    audience: '',
    setting: '',
  };
}

function ensureBrief(project) {
  if (briefFor(project.id)) return;
  const brief = briefFromProject(project);
  const created = now();
  rawDb.prepare(`
    INSERT INTO story_briefs
      (project_id, user_id, title, logline, premise, tone, genre, audience, setting, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.user_id,
    brief.title,
    brief.logline,
    brief.premise,
    brief.tone,
    brief.genre,
    brief.audience,
    brief.setting,
    created,
    created
  );
}

function findCharacterByName(projectId, name) {
  return rawDb.prepare('SELECT * FROM character_bibles WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, name);
}

function findLocationByName(projectId, name) {
  return rawDb.prepare('SELECT * FROM location_refs WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, name);
}

function insertCharacter(userId, projectId, data) {
  const created = now();
  const characterId = data.id && !rawDb.prepare('SELECT 1 FROM character_bibles WHERE id = ?').get(data.id)
    ? data.id
    : crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO character_bibles
      (id, user_id, project_id, name, gender, age, appearance, wardrobe,
       continuity_notes, legacy_material, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    characterId,
    userId,
    projectId,
    data.name,
    data.gender || '',
    data.age || '',
    data.appearance || '',
    data.wardrobe || '',
    data.continuityNotes || '',
    data.legacyMaterial || '',
    bool(data.approved),
    created,
    created
  );
  return characterId;
}

function insertLocation(userId, projectId, data) {
  const created = now();
  const locationId = data.id && !rawDb.prepare('SELECT 1 FROM location_refs WHERE id = ?').get(data.id)
    ? data.id
    : crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO location_refs
      (id, user_id, project_id, name, description, lighting, continuity_notes, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    locationId,
    userId,
    projectId,
    data.name,
    data.description || '',
    data.lighting || '',
    data.continuityNotes || '',
    bool(data.approved),
    created,
    created
  );
  return locationId;
}

function normalizeScene(raw, index, characters, locations) {
  const scene = raw && typeof raw === 'object' ? raw : {};
  const characterByName = new Map(characters.map((item) => [item.name.toLowerCase(), item.id]));
  const locationByName = new Map(locations.map((item) => [item.name.toLowerCase(), item.id]));
  const characterNames = Array.isArray(scene.characters)
    ? scene.characters
    : typeof scene.characters === 'string'
      ? scene.characters.split(',')
      : [];
  const names = characterNames.map((name) => text(name, 120)).filter(Boolean).slice(0, 12);
  const existingLocationId = typeof scene.locationId === 'string' ? text(scene.locationId, 80) : '';
  const locationName = text(scene.location, 200);
  const locationId = existingLocationId || (locationName ? locationByName.get(locationName.toLowerCase()) || '' : '');
  const existingCharacterIds = Array.isArray(scene.characterIds)
    ? scene.characterIds.map((value) => text(value, 80)).filter(Boolean)
    : [];
  const characterIds = existingCharacterIds.length
    ? existingCharacterIds.slice(0, 12)
    : names.map((name) => characterByName.get(name.toLowerCase())).filter(Boolean);

  return {
    id: typeof scene.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(scene.id) ? scene.id : crypto.randomUUID(),
    order: index,
    title: text(scene.title || `Scene ${index + 1}`, 200),
    beat: text(scene.beat, 2000),
    props: text(scene.props, 2000),
    action: text(scene.action, 5000),
    location: locationName,
    characters: names,
    locationId,
    characterIds,
  };
}

function normalizedScenes(project) {
  const scenes = parseScenes(project);
  const chars = characterRows(project.id);
  const locs = locationRows(project.id);
  return scenes.map((scene, index) => normalizeScene(scene, index, chars, locs));
}

function scenesChanged(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function updateProjectScenes(projectId, scenes) {
  rawDb.prepare('UPDATE projects SET scenes = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(scenes), now(), projectId);
}

function importCharacterReferences(project) {
  const refs = parseArray(parseJson(project.character_references, []));
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const name = text(ref.name, 120);
    if (!name || findCharacterByName(project.id, name)) continue;
    insertCharacter(project.user_id, project.id, {
      name,
      gender: text(ref.gender, 40),
      legacyMaterial: text(ref.referenceMaterial || ref.material, 30000),
      approved: false,
    });
  }
}

function importSceneLocations(project, scenes) {
  for (const scene of scenes) {
    const name = text(scene.location, 200);
    if (name && !findLocationByName(project.id, name)) {
      insertLocation(project.user_id, project.id, { name, approved: false });
    }
  }
}

function importScenes(project, scenes) {
  importSceneLocations(project, scenes);
  const chars = characterRows(project.id);
  const locs = locationRows(project.id);
  return scenes.map((scene, index) => normalizeScene(scene, index, chars, locs));
}

function insertDraft(userId, project, data) {
  const sceneId = text(data.sceneId, 80);
  if (!sceneId) throw Object.assign(new Error('Scene is required.'), { status: 400 });
  const scenes = normalizedScenes(project);
  if (!scenes.some((scene) => scene.id === sceneId)) {
    throw Object.assign(new Error('Scene not found.'), { status: 404 });
  }
  const versionRow = rawDb.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM prompt_drafts WHERE project_id = ? AND scene_id = ?'
  ).get(project.id, sceneId);
  const version = versionRow.version + 1;
  const created = now();
  const draftId = crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO prompt_drafts
      (id, user_id, project_id, scene_id, version, text, status, exclusions_json,
       reference_roles_json, text_model, temperature, max_tokens, image_model,
       image_size, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    draftId,
    userId,
    project.id,
    sceneId,
    version,
    text(data.text, 30000),
    'draft',
    JSON.stringify(Array.isArray(data.exclusions) ? data.exclusions : []),
    JSON.stringify(data.referenceRoles || {}),
    text(data.textModel, 100),
    Number.isFinite(Number(data.temperature)) ? Number(data.temperature) : null,
    Number.isFinite(Number(data.maxTokens)) ? Number(data.maxTokens) : null,
    text(data.imageModel, 100),
    text(data.imageSize, 20),
    data.source === 'ai' ? 'ai' : 'manual',
    created,
    created
  );
  syncGenerationPrompts(project.id);
  return rawDb.prepare('SELECT * FROM prompt_drafts WHERE id = ?').get(draftId);
}

function insertCharacterSheet(userId, project, data) {
  const characterId = text(data.characterId, 80);
  if (!characterId) throw Object.assign(new Error('Character is required.'), { status: 400 });
  const character = rawDb.prepare('SELECT * FROM character_bibles WHERE id = ? AND project_id = ?').get(characterId, project.id);
  if (!character) throw Object.assign(new Error('Character not found.'), { status: 404 });
  const versionRow = rawDb.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM character_sheets WHERE project_id = ? AND character_id = ?'
  ).get(project.id, characterId);
  const version = versionRow.version + 1;
  const created = now();
  const sheetId = crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO character_sheets
      (id, user_id, project_id, character_id, version, file, mime, size, prompt,
       image_model, image_size, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    sheetId,
    userId,
    project.id,
    characterId,
    version,
    text(data.file, 200),
    text(data.mime, 80) || 'image/png',
    text(data.size, 20),
    text(data.prompt, 30000),
    text(data.imageModel, 100),
    text(data.imageSize, 20),
    data.source === 'generated' ? 'generated' : 'manual',
    created,
    created
  );
  return rawDb.prepare('SELECT * FROM character_sheets WHERE id = ?').get(sheetId);
}

function createCharacterSheet(userId, projectId, characterId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const sheet = insertCharacterSheet(userId, project, { ...data, characterId });
  return toCharacterSheet(sheet);
}

function updateCharacterSheetStatus(userId, sheetId, status) {
  if (!PROMPT_STATUSES.has(status)) throw Object.assign(new Error('Invalid sheet status.'), { status: 400 });
  const row = rawDb.prepare('SELECT * FROM character_sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
  if (!row) return null;
  rawDb.exec('BEGIN');
  try {
    if (status === 'final') rawDb.prepare(`UPDATE character_sheets SET status = 'draft', updated_at = ?
      WHERE project_id = ? AND character_id = ? AND user_id = ? AND id != ? AND status = 'final'`)
      .run(now(), row.project_id, row.character_id, userId, sheetId);
    rawDb.prepare('UPDATE character_sheets SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(status, now(), sheetId, userId);
    rawDb.exec('COMMIT');
  } catch (err) {
    rawDb.exec('ROLLBACK');
    throw err;
  }
  return toCharacterSheet(rawDb.prepare('SELECT * FROM character_sheets WHERE id = ?').get(sheetId));
}

function characterSheetByFile(projectId, file) {
  const row = rawDb.prepare('SELECT * FROM character_sheets WHERE project_id = ? AND file = ?').get(projectId, file);
  return row ? toCharacterSheet(row) : null;
}

function syncGenerationPrompts(projectId) {
  const project = projectRow(projectId);
  if (!project) return;
  const existing = parseArray(parseJson(project.generation_prompts, []));
  const byScene = new Map();
  const rows = rawDb.prepare(`
    SELECT * FROM prompt_drafts WHERE project_id = ? ORDER BY scene_id, version ASC
  `).all(projectId);
  for (const row of rows) byScene.set(row.scene_id, { sceneId: row.scene_id, prompt: row.text });
  const scenes = parseScenes(project);
  const merged = scenes.map((scene) => byScene.get(scene.id) || existing.find((item) => item.sceneId === scene.id))
    .filter((item) => item && item.sceneId && item.prompt);
  if (merged.length) {
    rawDb.prepare('UPDATE projects SET generation_prompts = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now(), projectId);
  }
}

function migrateProject(project) {
  ensureBrief(project);
  const marker = rawDb.prepare('SELECT 1 FROM story_sync WHERE project_id = ?').get(project.id);
  if (marker) return;
  rawDb.exec('BEGIN');
  try {
    importCharacterReferences(project);
    let scenes = parseScenes(project);
    scenes = importScenes(project, scenes);
    if (scenesChanged(scenes, parseScenes(project))) updateProjectScenes(project.id, scenes);
    const prompts = parseArray(parseJson(project.generation_prompts, []));
    for (const prompt of prompts) {
      if (!prompt || !prompt.sceneId || !prompt.prompt) continue;
      if (!scenes.some((scene) => scene.id === prompt.sceneId)) continue;
      if (rawDb.prepare('SELECT 1 FROM prompt_drafts WHERE project_id = ? AND scene_id = ?').get(project.id, prompt.sceneId)) continue;
      const scene = scenes.find((item) => item.id === prompt.sceneId);
      insertDraft(project.user_id, projectRow(project.id), {
        sceneId: prompt.sceneId,
        text: prompt.prompt,
        referenceRoles: scene ? {
          characterIds: scene.characterIds,
          locationId: scene.locationId || undefined,
        } : {},
        textModel: '',
        source: 'migrated',
      });
    }
    rawDb.prepare('INSERT OR REPLACE INTO story_sync (project_id, migrated_at) VALUES (?, ?)')
      .run(project.id, now());
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
}

function ensureProject(projectId) {
  const project = projectRow(projectId);
  if (!project) return null;
  migrateProject(project);
  return project;
}

function importReferenceResult(projectId) {
  const project = projectRow(projectId);
  if (!project) return;
  ensureProject(projectId);
  const current = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!current) return;
  rawDb.exec('BEGIN');
  try {
    importCharacterReferences(current);
    let scenes = parseScenes(current);
    scenes = importScenes(current, scenes);
    if (scenesChanged(scenes, parseScenes(current))) updateProjectScenes(projectId, scenes);
    if (!rawDb.prepare('SELECT 1 FROM story_sync WHERE project_id = ?').get(projectId)) {
      rawDb.prepare('INSERT INTO story_sync (project_id, migrated_at) VALUES (?, ?)').run(projectId, now());
    }
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
}

function workspaceExists(userId, projectId) {
  const project = projectForUser(userId, projectId);
  if (!project) return false;
  ensureProject(projectId);
  const brief = briefFor(projectId);
  const hasBriefContent = Boolean(
    brief && (brief.logline || brief.tone || brief.genre || brief.audience || brief.setting)
  );
  const count = (table) =>
    rawDb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId).n;
  return hasBriefContent || count('character_bibles') > 0 || count('location_refs') > 0 || count('style_refs') > 0;
}

/**
 * Atomically populate the Phase 3 tables and scene records from a validated
 * story workspace. Nothing is marked approved and no prompt is finalized.
 * When `replace` is false and structured records already exist, callers must
 * have explicitly chosen to replace (see `workspaceExists`); this function does
 * not guard that itself so the server can keep reference generation and the
 * Story Workspace refresh path consistent.
 */
function importWorkspace(userId, projectId, workspace, options = {}) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const replace = options.replace === true;

  const current = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const legacyByName = new Map();
  const refs = Array.isArray(options.characterReferences) && options.characterReferences.length
    ? options.characterReferences
    : parseArray(parseJson(current.character_references, []));
  for (const ref of refs) {
    const name = text(ref.name, 120);
    if (name) legacyByName.set(name.toLowerCase(), text(ref.referenceMaterial || ref.material, 30000));
  }

  const stamp = now();
  rawDb.exec('BEGIN');
  try {
    if (replace) {
      rawDb.prepare('DELETE FROM character_bibles WHERE project_id = ?').run(projectId);
      rawDb.prepare('DELETE FROM location_refs WHERE project_id = ?').run(projectId);
      rawDb.prepare('DELETE FROM style_refs WHERE project_id = ?').run(projectId);
    }

    const brief = workspace.brief;
    rawDb.prepare(`
      UPDATE story_briefs SET title = ?, logline = ?, premise = ?, tone = ?, genre = ?,
        audience = ?, setting = ?, updated_at = ? WHERE project_id = ? AND user_id = ?
    `).run(
      text(brief.title, 200),
      text(brief.logline, 500),
      text(brief.premise, 5000),
      text(brief.tone, 200),
      text(brief.genre, 200),
      text(brief.audience, 200),
      text(brief.setting, 3000),
      stamp,
      projectId,
      userId
    );

    const characterIdByName = new Map();
    for (const character of workspace.characters) {
      const characterId = insertCharacter(userId, projectId, {
        name: character.name,
        gender: character.gender,
        age: character.age,
        appearance: character.appearance,
        wardrobe: character.wardrobe,
        continuityNotes: character.continuityNotes,
        legacyMaterial: legacyByName.get(character.name.toLowerCase()) || '',
        approved: false,
      });
      characterIdByName.set(character.name.toLowerCase(), characterId);
    }

    const locationIdByName = new Map();
    for (const location of workspace.locations) {
      const locationId = insertLocation(userId, projectId, {
        name: location.name,
        description: location.description,
        lighting: location.lighting,
        continuityNotes: location.continuityNotes,
        approved: false,
      });
      locationIdByName.set(location.name.toLowerCase(), locationId);
    }

    for (const style of workspace.styles) {
      rawDb.prepare(`
        INSERT INTO style_refs
          (id, user_id, project_id, name, description, guidance, exclusions_json, approved, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        crypto.randomUUID(),
        userId,
        projectId,
        text(style.name, 200),
        text(style.description, 5000),
        text(style.guidance, 5000),
        JSON.stringify(Array.isArray(style.exclusions) ? style.exclusions : []),
        stamp,
        stamp
      );
    }

    const sceneRecords = workspace.scenes.map((scene, index) => {
      const locationName = text(scene.location, 200);
      const locationId = locationIdByName.get(locationName.toLowerCase()) || '';
      const names = (scene.characters || []).map((name) => text(name, 120)).filter(Boolean).slice(0, 12);
      const characterIds = names.map((name) => characterIdByName.get(name.toLowerCase())).filter(Boolean);
      return {
        id: crypto.randomUUID(),
        order: index,
        title: text(scene.title, 200),
        beat: text(scene.beat, 2000),
        props: text(scene.props, 2000),
        action: text(scene.action, 5000),
        location: locationName,
        characters: names,
        locationId,
        characterIds,
      };
    });
    updateProjectScenes(projectId, sceneRecords);

    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }

  return {
    replaced: replace,
    brief: true,
    characters: workspace.characters.length,
    locations: workspace.locations.length,
    styles: workspace.styles.length,
    scenes: workspace.scenes.length,
  };
}

function importGenerationPrompts(projectId) {
  const project = projectRow(projectId);
  if (!project) return;
  ensureProject(projectId);
  const current = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!current) return;
  const scenes = normalizedScenes(current);
  const prompts = parseArray(parseJson(current.generation_prompts, []));
  for (const prompt of prompts) {
    if (!prompt || !prompt.sceneId || !prompt.prompt) continue;
    const scene = scenes.find((item) => item.id === prompt.sceneId);
    if (!scene) continue;
    const latest = rawDb.prepare(`
      SELECT * FROM prompt_drafts WHERE project_id = ? AND scene_id = ? ORDER BY version DESC LIMIT 1
    `).get(projectId, prompt.sceneId);
    if (latest && latest.text === prompt.prompt) continue;
    insertDraft(current.user_id, current, {
      sceneId: prompt.sceneId,
      text: prompt.prompt,
      referenceRoles: {
        characterIds: scene.characterIds,
        locationId: scene.locationId || '',
        styleId: '',
      },
      textModel: '',
      imageModel: '',
      imageSize: '',
      source: 'manual',
    });
  }
}

function syncScenes(projectId) {
  const project = projectRow(projectId);
  if (!project) return;
  ensureProject(projectId);
  const current = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!current) return;
  const scenes = importScenes(current, parseScenes(current));
  if (scenesChanged(scenes, parseScenes(current))) updateProjectScenes(projectId, scenes);
}

function briefForUser(userId, projectId) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const row = briefFor(projectId);
  if (!row) return null;
  return {
    title: row.title,
    logline: row.logline,
    premise: row.premise,
    tone: row.tone,
    genre: row.genre,
    audience: row.audience,
    setting: row.setting,
    updatedAt: row.updated_at,
  };
}

function updateBrief(userId, projectId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const next = {
    title: text(data.title !== undefined ? data.title : project.title, 200),
    logline: text(data.logline, 500),
    premise: text(data.premise, 5000),
    tone: text(data.tone, 200),
    genre: text(data.genre, 200),
    audience: text(data.audience, 200),
    setting: text(data.setting, 3000),
  };
  if (!next.title) throw Object.assign(new Error('Story title is required.'), { status: 400 });
  rawDb.prepare(`
    UPDATE story_briefs SET title = ?, logline = ?, premise = ?, tone = ?, genre = ?,
      audience = ?, setting = ?, updated_at = ? WHERE project_id = ? AND user_id = ?
  `).run(next.title, next.logline, next.premise, next.tone, next.genre, next.audience, next.setting, now(), projectId, userId);
  return briefForUser(userId, projectId);
}

function setBriefSettingIfEmpty(userId, projectId, setting) {
  const project = projectForUser(userId, projectId);
  if (!project) return;
  ensureProject(projectId);
  const row = briefFor(projectId);
  if (!row || row.setting || !text(setting, 3000)) return;
  rawDb.prepare('UPDATE story_briefs SET setting = ?, updated_at = ? WHERE project_id = ? AND user_id = ?')
    .run(text(setting, 3000), now(), projectId, userId);
}

function createCharacter(userId, projectId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const name = text(data.name, 120);
  if (!name) throw Object.assign(new Error('Character name is required.'), { status: 400 });
  const characterId = insertCharacter(userId, projectId, {
    name,
    gender: text(data.gender, 40),
    age: text(data.age, 80),
    appearance: text(data.appearance, 5000),
    wardrobe: text(data.wardrobe, 5000),
    continuityNotes: text(data.continuityNotes, 5000),
    approved: data.approved,
  });
  return toCharacter(rawDb.prepare('SELECT * FROM character_bibles WHERE id = ?').get(characterId));
}

function updateCharacter(userId, characterId, data) {
  const row = rawDb.prepare('SELECT * FROM character_bibles WHERE id = ? AND user_id = ?').get(characterId, userId);
  if (!row) return null;
  const name = data.name !== undefined ? text(data.name, 120) : row.name;
  if (!name) throw Object.assign(new Error('Character name is required.'), { status: 400 });
  rawDb.prepare(`
    UPDATE character_bibles SET name = ?, gender = ?, age = ?, appearance = ?, wardrobe = ?,
      continuity_notes = ?, approved = ?, updated_at = ? WHERE id = ? AND user_id = ?
  `).run(
    name,
    data.gender !== undefined ? text(data.gender, 40) : row.gender,
    data.age !== undefined ? text(data.age, 80) : row.age,
    data.appearance !== undefined ? text(data.appearance, 5000) : row.appearance,
    data.wardrobe !== undefined ? text(data.wardrobe, 5000) : row.wardrobe,
    data.continuityNotes !== undefined ? text(data.continuityNotes, 5000) : row.continuity_notes,
    data.approved !== undefined ? bool(data.approved) : row.approved,
    now(),
    characterId,
    userId
  );
  return toCharacter(rawDb.prepare('SELECT * FROM character_bibles WHERE id = ?').get(characterId));
}

function removeSceneCharacter(projectId, characterId) {
  const project = projectRow(projectId);
  if (!project) return;
  const scenes = parseScenes(project).map((scene) => ({
    ...scene,
    characterIds: Array.isArray(scene.characterIds)
      ? scene.characterIds.filter((value) => value !== characterId)
      : [],
  }));
  updateProjectScenes(projectId, scenes);
}

function deleteCharacter(userId, characterId) {
  const row = rawDb.prepare('SELECT * FROM character_bibles WHERE id = ? AND user_id = ?').get(characterId, userId);
  if (!row) return false;
  rawDb.exec('BEGIN');
  try {
    removeSceneCharacter(row.project_id, characterId);
    rawDb.prepare('DELETE FROM character_bibles WHERE id = ? AND user_id = ?').run(characterId, userId);
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function createLocation(userId, projectId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const name = text(data.name, 200);
  if (!name) throw Object.assign(new Error('Location name is required.'), { status: 400 });
  const locationId = insertLocation(userId, projectId, {
    name,
    description: text(data.description, 5000),
    lighting: text(data.lighting, 2000),
    continuityNotes: text(data.continuityNotes, 5000),
    approved: data.approved,
  });
  return toLocation(rawDb.prepare('SELECT * FROM location_refs WHERE id = ?').get(locationId));
}

function updateLocation(userId, locationId, data) {
  const row = rawDb.prepare('SELECT * FROM location_refs WHERE id = ? AND user_id = ?').get(locationId, userId);
  if (!row) return null;
  const name = data.name !== undefined ? text(data.name, 200) : row.name;
  if (!name) throw Object.assign(new Error('Location name is required.'), { status: 400 });
  rawDb.prepare(`
    UPDATE location_refs SET name = ?, description = ?, lighting = ?, continuity_notes = ?,
      approved = ?, updated_at = ? WHERE id = ? AND user_id = ?
  `).run(
    name,
    data.description !== undefined ? text(data.description, 5000) : row.description,
    data.lighting !== undefined ? text(data.lighting, 2000) : row.lighting,
    data.continuityNotes !== undefined ? text(data.continuityNotes, 5000) : row.continuity_notes,
    data.approved !== undefined ? bool(data.approved) : row.approved,
    now(),
    locationId,
    userId
  );
  return toLocation(rawDb.prepare('SELECT * FROM location_refs WHERE id = ?').get(locationId));
}

function deleteLocation(userId, locationId) {
  const row = rawDb.prepare('SELECT * FROM location_refs WHERE id = ? AND user_id = ?').get(locationId, userId);
  if (!row) return false;
  const scenes = parseScenes(projectRow(row.project_id)).map((scene) => {
    if (scene.locationId !== locationId) return scene;
    const next = { ...scene, locationId: '' };
    return next;
  });
  rawDb.exec('BEGIN');
  try {
    updateProjectScenes(row.project_id, scenes);
    rawDb.prepare('DELETE FROM location_refs WHERE id = ? AND user_id = ?').run(locationId, userId);
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function createStyle(userId, projectId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const name = text(data.name, 200);
  if (!name) throw Object.assign(new Error('Style name is required.'), { status: 400 });
  const created = now();
  const styleId = crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO style_refs
      (id, user_id, project_id, name, description, guidance, exclusions_json, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    styleId,
    userId,
    projectId,
    name,
    text(data.description, 5000),
    text(data.guidance, 5000),
    JSON.stringify(Array.isArray(data.exclusions) ? data.exclusions : []),
    bool(data.approved),
    created,
    created
  );
  return toStyle(rawDb.prepare('SELECT * FROM style_refs WHERE id = ?').get(styleId));
}

function updateStyle(userId, styleId, data) {
  const row = rawDb.prepare('SELECT * FROM style_refs WHERE id = ? AND user_id = ?').get(styleId, userId);
  if (!row) return null;
  const name = data.name !== undefined ? text(data.name, 200) : row.name;
  if (!name) throw Object.assign(new Error('Style name is required.'), { status: 400 });
  rawDb.prepare(`
    UPDATE style_refs SET name = ?, description = ?, guidance = ?, exclusions_json = ?,
      approved = ?, updated_at = ? WHERE id = ? AND user_id = ?
  `).run(
    name,
    data.description !== undefined ? text(data.description, 5000) : row.description,
    data.guidance !== undefined ? text(data.guidance, 5000) : row.guidance,
    data.exclusions !== undefined ? JSON.stringify(Array.isArray(data.exclusions) ? data.exclusions : []) : row.exclusions_json,
    data.approved !== undefined ? bool(data.approved) : row.approved,
    now(),
    styleId,
    userId
  );
  return toStyle(rawDb.prepare('SELECT * FROM style_refs WHERE id = ?').get(styleId));
}

function deleteStyle(userId, styleId) {
  return rawDb.prepare('DELETE FROM style_refs WHERE id = ? AND user_id = ?').run(styleId, userId).changes > 0;
}

function validateSceneLinks(userId, projectId, scenes) {
  const project = projectForUser(userId, projectId);
  if (!project) return { error: 'Project not found.' };
  const characters = new Map(characterRows(projectId).map((item) => [item.id, item]));
  const locations = new Map(locationRows(projectId).map((item) => [item.id, item]));
  for (const scene of scenes) {
    if (scene.locationId) {
      const location = locations.get(scene.locationId);
      if (!location) throw Object.assign(new Error('A scene links to a location that does not exist.'), { status: 409, code: 'LOCATION_NOT_FOUND' });
      if (!location.approved) throw Object.assign(new Error('A scene links to a location that is not approved.'), { status: 409, code: 'LOCATION_NOT_APPROVED' });
    }
    for (const characterId of scene.characterIds || []) {
      const character = characters.get(characterId);
      if (!character) throw Object.assign(new Error('A scene links to a character that does not exist.'), { status: 409, code: 'CHARACTER_NOT_FOUND' });
      if (!character.approved) throw Object.assign(new Error('A scene links to a character that is not approved.'), { status: 409, code: 'CHARACTER_NOT_APPROVED' });
    }
  }
  return { characters, locations };
}

function saveScenes(userId, projectId, input) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  if (!Array.isArray(input)) throw Object.assign(new Error('Scenes must be an array.'), { status: 400 });
  if (input.length > 20) throw Object.assign(new Error('Too many scenes (max 20).'), { status: 400 });
  const chars = characterRows(projectId);
  const locs = locationRows(projectId);
  const scenes = input.map((raw, index) => normalizeScene(raw, index, chars, locs));
  validateSceneLinks(userId, projectId, scenes);
  updateProjectScenes(projectId, scenes);
  return scenes;
}

function createPrompt(userId, projectId, sceneId, data) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const draft = insertDraft(userId, project, {
    sceneId,
    text: data.text,
    exclusions: data.exclusions,
    referenceRoles: data.referenceRoles,
    textModel: data.textModel,
    temperature: data.temperature,
    maxTokens: data.maxTokens,
    imageModel: data.imageModel,
    imageSize: data.imageSize,
    source: data.source,
  });
  return toPrompt(draft);
}

function updatePromptStatus(userId, promptId, status) {
  if (!PROMPT_STATUSES.has(status)) throw Object.assign(new Error('Invalid prompt status.'), { status: 400 });
  const row = rawDb.prepare('SELECT * FROM prompt_drafts WHERE id = ? AND user_id = ?').get(promptId, userId);
  if (!row) return null;
  rawDb.prepare('UPDATE prompt_drafts SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(status, now(), promptId, userId);
  syncGenerationPrompts(row.project_id);
  return toPrompt(rawDb.prepare('SELECT * FROM prompt_drafts WHERE id = ?').get(promptId));
}

function latestDraft(userId, projectId, sceneId) {
  const row = rawDb.prepare(`
    SELECT * FROM prompt_drafts
    WHERE project_id = ? AND user_id = ? AND scene_id = ?
    ORDER BY version DESC LIMIT 1
  `).get(projectId, userId, sceneId);
  return row ? toPrompt(row) : null;
}

function getStory(userId, projectId) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  const current = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const scenes = normalizedScenes(current);
  const brief = briefForUser(userId, projectId);
  const characters = characterRows(projectId).map(toCharacter);
  const locations = locationRows(projectId).map(toLocation);
  const styles = styleRows(projectId).map(toStyle);
  const prompts = promptRows(projectId).map(toPrompt);
  const characterSheets = characterSheetRows(projectId).map(toCharacterSheet);
  return {
    projectId,
    projectTitle: current.title,
    hasReference: Boolean(current.reference_material),
    brief,
    characters,
    locations,
    styles,
    scenes,
    prompts,
    characterSheets,
    worksheet: worksheetForUser(userId, projectId),
    warnings: validate(userId, projectId, { project: current, brief, characters, locations, styles, scenes, prompts }),
  };
}

function validate(userId, projectId, supplied = {}) {
  const project = supplied.project || projectRow(projectId);
  const brief = supplied.brief || (briefFor(projectId) ? {
    title: briefFor(projectId).title,
    logline: briefFor(projectId).logline,
    premise: briefFor(projectId).premise,
    tone: briefFor(projectId).tone,
    genre: briefFor(projectId).genre,
    audience: briefFor(projectId).audience,
    setting: briefFor(projectId).setting,
  } : null);
  const characters = supplied.characters || characterRows(projectId).map(toCharacter);
  const locations = supplied.locations || locationRows(projectId).map(toLocation);
  const styles = supplied.styles || styleRows(projectId).map(toStyle);
  const scenes = supplied.scenes || normalizedScenes(project);
  const prompts = supplied.prompts || promptRows(projectId).map(toPrompt);
  const warnings = [];
  const add = (code, message, extra = {}) => warnings.push({ code, severity: 'warning', message, ...extra });
  const characterById = new Map(characters.map((item) => [item.id, item]));
  const locationById = new Map(locations.map((item) => [item.id, item]));
  const styleById = new Map(styles.map((item) => [item.id, item]));

  if (!brief) add('STORY_BRIEF_MISSING', 'The story brief is missing.');
  else {
    for (const [field, label] of [
      ['premise', 'premise'], ['tone', 'tone'], ['genre', 'genre'],
      ['audience', 'audience'], ['setting', 'setting'],
    ]) {
      if (!brief[field]) add('STORY_BRIEF_INCOMPLETE', `The story brief is missing ${label}.`, { field });
    }
  }

  for (const character of characters) {
    if (characters.filter((item) => item.name.toLowerCase() === character.name.toLowerCase()).length > 1) {
      add('DUPLICATE_CHARACTER_NAME', `More than one character bible is named "${character.name}".`, { referenceId: character.id, target: 'character' });
    }
    if (!character.approved) add('CHARACTER_NOT_APPROVED', `Character "${character.name}" is not approved.`, { referenceId: character.id, target: 'character' });
    if (!character.appearance) add('CHARACTER_APPEARANCE_MISSING', `Character "${character.name}" has no appearance record.`, { referenceId: character.id, target: 'character' });
    if (!character.wardrobe) add('CHARACTER_WARDROBE_MISSING', `Character "${character.name}" has no wardrobe record.`, { referenceId: character.id, target: 'character' });
  }
  for (const location of locations) {
    if (!location.approved) add('LOCATION_NOT_APPROVED', `Location "${location.name}" is not approved.`, { referenceId: location.id, target: 'location' });
    if (!location.description) add('LOCATION_DESCRIPTION_MISSING', `Location "${location.name}" has no description.`, { referenceId: location.id, target: 'location' });
  }
  for (const style of styles) {
    if (!style.approved) add('STYLE_NOT_APPROVED', `Style "${style.name}" is not approved.`, { referenceId: style.id, target: 'style' });
    if (!style.guidance) add('STYLE_GUIDANCE_MISSING', `Style "${style.name}" has no visual guidance.`, { referenceId: style.id, target: 'style' });
  }

  if (!scenes.length) add('SCENES_MISSING', 'The story has no scenes.');
  for (const scene of scenes) {
    const sceneLabel = scene.title || scene.id;
    if (!scene.locationId && !scene.location) add('SCENE_LOCATION_MISSING', `Scene "${sceneLabel}" has no location.`, { sceneId: scene.id, target: 'scene' });
    if (scene.locationId && !locationById.has(scene.locationId)) {
      add('SCENE_LOCATION_UNKNOWN', `Scene "${sceneLabel}" links to a location that does not exist.`, { sceneId: scene.id, target: 'scene' });
    } else if (scene.locationId && !locationById.get(scene.locationId).approved) {
      add('SCENE_LOCATION_UNAPPROVED', `Scene "${sceneLabel}" links to an unapproved location.`, { sceneId: scene.id, target: 'scene' });
    }
    if (!scene.characterIds || !scene.characterIds.length) {
      add('SCENE_CHARACTERS_MISSING', `Scene "${sceneLabel}" has no linked characters.`, { sceneId: scene.id, target: 'scene' });
    }
    for (const characterId of scene.characterIds || []) {
      if (!characterById.has(characterId)) {
        add('SCENE_CHARACTER_UNKNOWN', `Scene "${sceneLabel}" links to a character that does not exist.`, { sceneId: scene.id, target: 'scene' });
      } else if (!characterById.get(characterId).approved) {
        add('SCENE_CHARACTER_UNAPPROVED', `Scene "${sceneLabel}" links to an unapproved character.`, { sceneId: scene.id, target: 'scene' });
      }
    }
    if (scene.locationId && scene.location) {
      const linked = locationById.get(scene.locationId);
      if (linked && linked.name.toLowerCase() !== scene.location.toLowerCase()) {
        add('SCENE_LOCATION_CONFLICT', `Scene "${sceneLabel}" has a location name that conflicts with its linked location.`, { sceneId: scene.id, target: 'scene' });
      }
    }
    const linkedNames = (scene.characterIds || []).map((characterId) => characterById.get(characterId)?.name.toLowerCase()).filter(Boolean);
    const named = (scene.characters || []).map((name) => name.toLowerCase());
    if (linkedNames.length && named.some((name) => !linkedNames.includes(name))) {
      add('SCENE_CHARACTER_CONFLICT', `Scene "${sceneLabel}" has character names that conflict with its linked characters.`, { sceneId: scene.id, target: 'scene' });
    }
    const scenePrompts = prompts.filter((prompt) => prompt.sceneId === scene.id);
    if (!scenePrompts.length) {
      add('SCENE_PROMPT_MISSING', `Scene "${sceneLabel}" has no prompt draft.`, { sceneId: scene.id, target: 'prompt' });
    } else {
      const finals = scenePrompts.filter((prompt) => prompt.status === 'final');
      if (finals.length > 1) add('MULTIPLE_FINAL_PROMPTS', `Scene "${sceneLabel}" has multiple final prompts.`, { sceneId: scene.id, target: 'prompt' });
      const latest = scenePrompts.slice().sort((a, b) => b.version - a.version)[0];
      if (latest.referenceRoles) {
        for (const characterId of latest.referenceRoles.characterIds || []) {
          if (!characterById.has(characterId)) {
            add('PROMPT_CHARACTER_UNKNOWN', `A prompt for "${sceneLabel}" references a character that does not exist.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
          } else if (!characterById.get(characterId).approved) {
            add('PROMPT_CHARACTER_UNAPPROVED', `A prompt for "${sceneLabel}" references an unapproved character.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
          }
        }
        if (latest.referenceRoles.locationId && !locationById.has(latest.referenceRoles.locationId)) {
          add('PROMPT_LOCATION_UNKNOWN', `A prompt for "${sceneLabel}" references a location that does not exist.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
        } else if (latest.referenceRoles.locationId && !locationById.get(latest.referenceRoles.locationId).approved) {
          add('PROMPT_LOCATION_UNAPPROVED', `A prompt for "${sceneLabel}" references an unapproved location.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
        }
        if (latest.referenceRoles.styleId && !styleById.has(latest.referenceRoles.styleId)) {
          add('PROMPT_STYLE_UNKNOWN', `A prompt for "${sceneLabel}" references a style that does not exist.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
        } else if (latest.referenceRoles.styleId && !styleById.get(latest.referenceRoles.styleId).approved) {
          add('PROMPT_STYLE_UNAPPROVED', `A prompt for "${sceneLabel}" references an unapproved style.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
        }
        const roleCharacters = (latest.referenceRoles.characterIds || []).slice().sort().join(',');
        const sceneCharacters = (scene.characterIds || []).slice().sort().join(',');
        const roleLocation = latest.referenceRoles.locationId || '';
        const sceneLocation = scene.locationId || '';
        if (roleCharacters !== sceneCharacters || roleLocation !== sceneLocation) {
          add('PROMPT_REFERENCE_MISMATCH', `A prompt for "${sceneLabel}" has reference roles that differ from the scene links.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
        }
      }
      if (!latest.model || !latest.model.id) add('PROMPT_MODEL_MISSING', `The latest prompt for "${sceneLabel}" has no text-model record.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
      if (!latest.imageSettings) add('PROMPT_IMAGE_SETTINGS_MISSING', `The latest prompt for "${sceneLabel}" has no image-settings record.`, { sceneId: scene.id, promptId: latest.id, target: 'prompt' });
    }
  }
  return warnings;
}

function validateProject(userId, projectId) {
  const project = projectForUser(userId, projectId);
  if (!project) return null;
  ensureProject(projectId);
  return validate(userId, projectId);
}

function backupBeforeStoryMigration() {
  try {
    const projectCount = rawDb.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    if (!projectCount || !dbPath) return;
    rawDb.exec('PRAGMA wal_checkpoint(FULL)');
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `app-pre-story-${stamp}.db`);
    fs.copyFileSync(dbPath, target);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${dbPath}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`);
    }
    console.log(`  Story migration backup: ${target}`);
  } catch (error) {
    throw new Error(`Could not back up the database before the story migration: ${error.message}`);
  }
}

function init(database, databasePath) {
  rawDb = database;
  dbPath = databasePath;
  const hadStoryTables = Boolean(rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story_briefs'").get());
  if (!hadStoryTables) backupBeforeStoryMigration();
  schema();
  const projects = rawDb.prepare('SELECT * FROM projects').all();
  for (const project of projects) {
    try {
      migrateProject(project);
    } catch (error) {
      console.error(`  Story migration failed for project ${project.id}: ${error.message}`);
    }
  }
  return {
    ensureProject,
    importReferenceResult,
    importWorkspace,
    workspaceExists,
    importGenerationPrompts,
    syncScenes,
    getStory,
    briefFor: briefForUser,
    updateBrief,
    setBriefSettingIfEmpty,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    createLocation,
    updateLocation,
    deleteLocation,
    createStyle,
    updateStyle,
    deleteStyle,
    saveScenes,
    validateSceneLinks,
    createPrompt,
    updatePromptStatus,
    createCharacterSheet,
    updateCharacterSheetStatus,
    characterSheetByFile,
    setWorksheetSetting,
    saveWorksheetActions,
    saveWorksheetLocations,
    latestDraft,
    validate: validateProject,
    syncGenerationPrompts,
    toCharacter,
    toLocation,
    toStyle,
    toPrompt,
    toCharacterSheet,
  };
}

module.exports = { init, normalizeStoryWorkspace };
