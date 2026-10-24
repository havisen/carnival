'use strict';

// ---------------------------------------------------------------------------
// Authoritative asset registry
//
// Files remain under data/images/<relative-path>. SQLite is the source of truth
// for asset identity, provenance, and immutable version history. Legacy
// projects.scene_images is maintained as a compatibility projection.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const HIDDEN_NAMES = new Set(['Thumbs.db', 'desktop.ini']);

let rawDb = null;
let dataDir = null;
let dbPath = null;
let imagesDir = null;

function isHidden(name) {
  return !name || name.startsWith('.') || name === '__MACOSX' || HIDDEN_NAMES.has(name);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function humanize(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

function normalizeRelative(input) {
  if (typeof input !== 'string' || !input || input.length > 2000) return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return null;
  const normalized = path.posix.normalize(input);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function absolutePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) return null;
  const full = path.resolve(imagesDir, ...normalized.split('/'));
  const relative = path.relative(imagesDir, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return full;
}

function detectType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { extension: 'png', mime: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg' };
  }
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') {
    return { extension: 'gif', mime: 'image/gif' };
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mime: 'image/webp' };
  }
  return null;
}

function dimensions(buffer, extension) {
  try {
    if (extension === 'png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (extension === 'gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if ((extension === 'jpg' || extension === 'jpeg') && buffer.length >= 4) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        if (marker === 0xd8 || marker === 0xd9) {
          offset += 2;
          continue;
        }
        if (offset + 4 > buffer.length) break;
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof && offset + 9 <= buffer.length) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (extension === 'webp' && buffer.length >= 30) {
      const chunk = buffer.slice(12, 16).toString('ascii');
      if (chunk === 'VP8X') {
        const read24 = (offset) => buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        return { width: 1 + read24(24), height: 1 + read24(27) };
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch (_) { /* dimensions are optional */ }
  return {};
}

function fileFacts(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) return { missing: true };
  const full = absolutePath(normalized);
  if (!full) return { missing: true };
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (_) {
    return { missing: true };
  }
  if (!stat.isFile()) return { missing: true };
  let buffer;
  try {
    buffer = fs.readFileSync(full);
  } catch (_) {
    return { missing: true };
  }
  const extension = path.posix.extname(normalized).slice(1).toLowerCase();
  const type = detectType(buffer);
  if (!type || (type.extension === 'jpg' ? !['jpg', 'jpeg'].includes(extension) : type.extension !== extension)) {
    return { missing: false, invalid: true };
  }
  const dims = dimensions(buffer, extension);
  return {
    missing: false,
    relativePath: normalized,
    extension,
    mime: MIME[extension],
    bytes: stat.size,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    width: dims.width || null,
    height: dims.height || null,
    modifiedAt: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null,
  };
}

function tableExists(name) {
  return Boolean(rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id);

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT,
      episode_id TEXT,
      scene_id TEXT,
      asset_type TEXT NOT NULL DEFAULT 'image',
      title TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, scene_id);

    CREATE TABLE IF NOT EXISTS asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      is_source INTEGER NOT NULL DEFAULT 1,
      derived_from_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
      sha256 TEXT NOT NULL,
      mime TEXT,
      bytes INTEGER,
      width INTEGER,
      height INTEGER,
      source TEXT,
      model TEXT,
      prompt TEXT,
      prompt_draft_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (asset_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(asset_id, revision);
    CREATE INDEX IF NOT EXISTS idx_asset_versions_sha ON asset_versions(sha256);

    CREATE TABLE IF NOT EXISTS collection_assets (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS asset_tags (
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (asset_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS asset_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const versionColumns = rawDb.prepare('PRAGMA table_info(asset_versions)').all().map((column) => column.name);
  if (!versionColumns.includes('prompt_draft_id')) {
    rawDb.exec('ALTER TABLE asset_versions ADD COLUMN prompt_draft_id TEXT');
  }
}

function backupBeforeMigration() {
  try {
    const projectCount = rawDb.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    if (!projectCount) return;
    rawDb.exec('PRAGMA wal_checkpoint(FULL)');
    const backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `app-pre-assets-${stamp}.db`);
    fs.copyFileSync(dbPath, target);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${dbPath}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`);
    }
    console.log(`  Asset registry migration backup: ${target}`);
  } catch (error) {
    throw new Error(`Could not back up the database before the asset migration: ${error.message}`);
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function projectRows() {
  return rawDb.prepare('SELECT * FROM projects').all().map((row) => ({
    ...row,
    scenes: parseJsonArray(row.scenes),
    sceneImages: parseJsonArray(row.scene_images),
  }));
}

function projectRow(id) {
  const row = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, scenes: parseJsonArray(row.scenes), sceneImages: parseJsonArray(row.scene_images) };
}

function projectTitleForScene(project, sceneId) {
  const scene = (project.scenes || []).find((item) => item.id === sceneId);
  return scene && scene.title ? scene.title : '';
}

function insertAsset(fields) {
  const now = new Date().toISOString();
  const id = fields.id || crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO assets
      (id, user_id, project_id, episode_id, scene_id, asset_type, title,
       lifecycle_status, current_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.userId || null,
    fields.projectId || null,
    fields.episodeId || null,
    fields.sceneId || null,
    fields.assetType || 'image',
    fields.title || '',
    fields.lifecycleStatus || 'ACTIVE',
    null,
    now,
    now
  );
  return id;
}

function insertVersion(fields) {
  const id = fields.id || crypto.randomUUID();
  rawDb.prepare(`
    INSERT INTO asset_versions
      (id, asset_id, revision, relative_path, is_source, derived_from_version_id,
       sha256, mime, bytes, width, height, source, model, prompt, prompt_draft_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.assetId,
    fields.revision,
    fields.relativePath,
    fields.isSource ? 1 : 0,
    fields.derivedFromVersionId || null,
    fields.sha256 || '',
    fields.mime || null,
    fields.bytes === undefined ? null : fields.bytes,
    fields.width || null,
    fields.height || null,
    fields.source || null,
    fields.model || null,
    fields.prompt || null,
    fields.promptDraftId || null,
    fields.createdAt || new Date().toISOString()
  );
  return id;
}

function versionByPath(relativePath) {
  return rawDb.prepare(`
    SELECT v.*, a.user_id, a.project_id, a.episode_id, a.scene_id, a.lifecycle_status,
           a.current_version_id, a.title
    FROM asset_versions v
    JOIN assets a ON a.id = v.asset_id
    WHERE v.relative_path = ?
  `).get(relativePath);
}

function assetById(id) {
  return rawDb.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

function currentVersion(asset) {
  if (!asset || !asset.current_version_id) return null;
  return rawDb.prepare('SELECT * FROM asset_versions WHERE id = ?').get(asset.current_version_id);
}

function versionsFor(assetId) {
  return rawDb.prepare('SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY revision ASC').all(assetId);
}

function setCurrentVersion(assetId, versionId, status = 'ACTIVE') {
  rawDb.prepare('UPDATE assets SET current_version_id = ?, lifecycle_status = ?, updated_at = ? WHERE id = ?')
    .run(versionId, status, new Date().toISOString(), assetId);
}

function ensureSceneAsset(project, item) {
  if (!item || !item.file) return null;
  const relativePath = normalizeRelative(`${project.id}/${item.file}`);
  if (!relativePath) return null;
  const existing = versionByPath(relativePath);
  if (existing) {
    item.assetId = existing.asset_id;
    item.versionId = existing.id;
    item.revision = existing.revision;
    return { assetId: existing.asset_id, versionId: existing.id, revision: existing.revision };
  }

  const facts = fileFacts(relativePath);
  const sceneTitle = projectTitleForScene(project, item.sceneId);
  const title = sceneTitle || project.title || humanize(item.file);
  const assetId = item.assetId && assetById(item.assetId)
    ? item.assetId
    : insertAsset({
      userId: project.user_id,
      projectId: project.id,
      sceneId: item.sceneId || null,
      title,
      lifecycleStatus: facts.missing ? 'MISSING' : 'ACTIVE',
    });
  const versionId = insertVersion({
    assetId,
    revision: 1,
    relativePath,
    isSource: true,
    sha256: facts.sha256 || '',
    mime: facts.mime || item.mime || null,
    bytes: facts.bytes === undefined ? item.bytes : facts.bytes,
    width: facts.width,
    height: facts.height,
    source: item.source || 'existing',
    model: item.model || null,
    prompt: item.prompt || null,
    createdAt: item.createdAt || new Date().toISOString(),
  });
  setCurrentVersion(assetId, versionId, facts.missing ? 'MISSING' : 'ACTIVE');
  item.assetId = assetId;
  item.versionId = versionId;
  item.revision = 1;
  return { assetId, versionId, revision: 1 };
}

function migrateSceneImages() {
  const projects = projectRows();
  if (!projects.length) return;
  rawDb.exec('BEGIN');
  try {
    for (const project of projects) {
      let changed = false;
      const images = project.sceneImages.slice();
      for (const item of images) {
        const before = `${item.assetId || ''}|${item.versionId || ''}|${item.revision || ''}`;
        ensureSceneAsset(project, item);
        const after = `${item.assetId || ''}|${item.versionId || ''}|${item.revision || ''}`;
        if (before !== after) changed = true;
      }
      if (changed) {
        rawDb.prepare('UPDATE projects SET scene_images = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(images), new Date().toISOString(), project.id);
      }
    }
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
}

function projectMap() {
  const map = new Map();
  for (const project of projectRows()) map.set(project.id, project);
  return map;
}

function scanFilesystem() {
  if (!fs.existsSync(imagesDir)) return;
  const projects = projectMap();
  const known = new Set(rawDb.prepare('SELECT relative_path FROM asset_versions').all().map((row) => row.relative_path));

  function walk(directory, relativeDir) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isUuid(entry.name) && !projects.has(entry.name)) continue;
        walk(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile() || known.has(relativePath)) continue;
      const extension = path.posix.extname(entry.name).slice(1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) continue;
      const facts = fileFacts(relativePath);
      if (facts.missing || facts.invalid) continue;

      const projectSegment = relativePath.split('/').find((segment) => isUuid(segment));
      const project = projectSegment ? projects.get(projectSegment) : null;
      const sceneImage = project
        ? project.sceneImages.find((item) => item.file && `${projectSegment}/${item.file}` === relativePath)
        : null;
      const sceneId = sceneImage ? sceneImage.sceneId : null;
      const title = (project && projectTitleForScene(project, sceneId)) || (project && project.title) || humanize(entry.name);
      const assetId = insertAsset({
        userId: project ? project.user_id : null,
        projectId: project ? project.id : null,
        sceneId,
        title,
        lifecycleStatus: 'ACTIVE',
      });
      const versionId = insertVersion({
        assetId,
        revision: 1,
        relativePath,
        isSource: true,
        sha256: facts.sha256,
        mime: facts.mime,
        bytes: facts.bytes,
        width: facts.width,
        height: facts.height,
        source: 'filesystem',
        createdAt: facts.modifiedAt,
      });
      setCurrentVersion(assetId, versionId, 'ACTIVE');
      known.add(relativePath);
    }
  }

  rawDb.exec('BEGIN');
  try {
    walk(imagesDir, '');
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
}

function assetRowsForUser(userId) {
  return rawDb.prepare(`
    SELECT a.*, v.id AS version_id, v.revision, v.relative_path, v.is_source,
           v.derived_from_version_id, v.sha256, v.mime, v.bytes, v.width, v.height,
           v.source, v.model, v.prompt, v.prompt_draft_id, v.created_at AS version_created_at,
           p.title AS project_title, p.stage AS project_stage, p.status AS project_status,
           e.title AS episode_title
    FROM assets a
    LEFT JOIN asset_versions v ON v.id = a.current_version_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN episodes e ON e.id = a.episode_id
    WHERE (a.user_id = ? OR a.user_id IS NULL)
    ORDER BY COALESCE(v.created_at, a.updated_at) DESC, v.relative_path ASC
  `).all(userId);
}

function tagsForAsset(assetId) {
  return rawDb.prepare(`
    SELECT t.* FROM tags t JOIN asset_tags at ON at.tag_id = t.id
    WHERE at.asset_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(assetId);
}

function collectionsForAsset(assetId, userId) {
  return rawDb.prepare(`
    SELECT c.* FROM collections c JOIN collection_assets ca ON ca.collection_id = c.id
    WHERE ca.asset_id = ? AND c.user_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(assetId, userId);
}

function duplicateCounts(userId) {
  const rows = rawDb.prepare(`
    SELECT v.sha256, COUNT(DISTINCT v.asset_id) AS count
    FROM asset_versions v JOIN assets a ON a.id = v.asset_id AND a.current_version_id = v.id
    WHERE v.sha256 <> '' AND (a.user_id = ? OR a.user_id IS NULL)
    GROUP BY v.sha256 HAVING count > 1
  `).all(userId);
  return new Map(rows.map((row) => [row.sha256, row.count]));
}

function mapAssetRow(row, userId, duplicates) {
  const project = row.project_id ? projectRow(row.project_id) : null;
  const sceneTitle = project && row.scene_id ? projectTitleForScene(project, row.scene_id) : '';
  const tags = tagsForAsset(row.id);
  const collections = collectionsForAsset(row.id, userId);
  const duplicateCount = duplicates.get(row.sha256) || 1;
  const missing = !row.relative_path || !fs.existsSync(absolutePath(row.relative_path));
  const lifecycleStatus = missing ? 'MISSING' : row.lifecycle_status;
  return {
    id: row.id,
    assetId: row.id,
    versionId: row.version_id,
    revision: row.revision || 0,
    name: row.relative_path ? path.posix.basename(row.relative_path) : '',
    label: row.title || (row.relative_path ? humanize(path.posix.basename(row.relative_path)) : 'Asset'),
    relativePath: row.relative_path || '',
    url: row.relative_path ? `/api/library/file?path=${encodeURIComponent(row.relative_path)}` : '',
    extension: row.relative_path ? path.posix.extname(row.relative_path).slice(1).toLowerCase() : '',
    mime: row.mime || '',
    width: row.width || null,
    height: row.height || null,
    sizeBytes: row.bytes === null || row.bytes === undefined ? null : row.bytes,
    modifiedAt: row.version_created_at || null,
    isSource: Boolean(row.is_source),
    derivedFromVersionId: row.derived_from_version_id || null,
    sha256: row.sha256,
    lifecycleStatus,
    missing,
    duplicateCount,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
    collections: collections.map((collection) => ({ id: collection.id, name: collection.name })),
    metadata: row.project_id ? {
      projectId: row.project_id,
      episodeId: row.episode_id,
      sceneId: row.scene_id,
      sceneTitle,
      projectTitle: row.project_title,
      projectStage: row.project_stage,
      projectStatus: row.project_status,
      episodeTitle: row.episode_title,
      source: row.source,
      model: row.model,
      prompt: row.prompt,
      revision: row.revision,
      promptDraftId: row.prompt_draft_id || null,
      reviewDecision: null,
      workflowStatus: null,
    } : null,
  };
}

function listAssets(userId, filters = {}) {
  scanFilesystem();
  const duplicates = duplicateCounts(userId);
  let rows = assetRowsForUser(userId).map((row) => mapAssetRow(row, userId, duplicates));
  const query = String(filters.q || filters.search || '').trim().toLowerCase();
  if (query) {
    rows = rows.filter((asset) =>
      `${asset.name} ${asset.relativePath} ${asset.label}`.toLowerCase().includes(query)
    );
  }
  if (filters.projectId) rows = rows.filter((asset) => asset.metadata && asset.metadata.projectId === filters.projectId);
  if (filters.episodeId) rows = rows.filter((asset) => asset.metadata && asset.metadata.episodeId === filters.episodeId);
  if (filters.collectionId) rows = rows.filter((asset) => asset.collections.some((item) => item.id === filters.collectionId));
  if (filters.tag) rows = rows.filter((asset) => asset.tags.some((item) =>
    item.name.toLowerCase() === String(filters.tag).toLowerCase() || item.id === filters.tag
  ));
  if (filters.type) rows = rows.filter((asset) => asset.extension.toLowerCase() === String(filters.type).toLowerCase());
  if (filters.status) rows = rows.filter((asset) => asset.lifecycleStatus === filters.status);
  if (filters.duplicate === '1' || filters.duplicate === 'true') rows = rows.filter((asset) => asset.duplicateCount > 1);
  if (filters.missing === '1' || filters.missing === 'true') rows = rows.filter((asset) => asset.missing);
  if (filters.unassigned === '1' || filters.unassigned === 'true') rows = rows.filter((asset) => !asset.metadata || !asset.metadata.projectId);
  return rows;
}

function listLibraryImages(userId) {
  return listAssets(userId).map((asset) => ({
    ...asset,
    // Keep the Phase 1 Library identifier as the normalized relative path.
    // The authoritative stable asset ID remains available as `assetId`.
    id: asset.relativePath || asset.id,
    metadata: asset.metadata ? {
      projectId: asset.metadata.projectId,
      episodeId: asset.metadata.episodeId,
      sceneId: asset.metadata.sceneId,
      revision: asset.metadata.revision,
      workflowStatus: null,
      reviewDecision: null,
      promptVersion: null,
      promptDraftId: asset.metadata.promptDraftId || null,
      model: asset.metadata.model,
      referenceIds: [],
      source: asset.metadata.source,
      prompt: asset.metadata.prompt,
      projectStage: asset.metadata.projectStage,
      projectStatus: asset.metadata.projectStatus,
    } : null,
  }));
}

function getAsset(userId, assetId) {
  scanFilesystem();
  const row = assetRowsForUser(userId).find((item) => item.id === assetId);
  if (!row) return null;
  const duplicates = duplicateCounts(userId);
  const asset = mapAssetRow(row, userId, duplicates);
  const versions = versionsFor(assetId).map((version) => ({
    id: version.id,
    revision: version.revision,
    relativePath: version.relative_path,
    url: `/api/library/file?path=${encodeURIComponent(version.relative_path)}`,
    isSource: Boolean(version.is_source),
    derivedFromVersionId: version.derived_from_version_id,
    sha256: version.sha256,
    mime: version.mime,
    bytes: version.bytes,
    width: version.width,
    height: version.height,
    source: version.source,
    model: version.model,
    prompt: version.prompt,
    promptDraftId: version.prompt_draft_id || null,
    createdAt: version.created_at,
  }));
  const peers = row.sha256
    ? rawDb.prepare(`
        SELECT DISTINCT a.id, a.title, v.relative_path
        FROM asset_versions v JOIN assets a ON a.id = v.asset_id AND a.current_version_id = v.id
        WHERE v.sha256 = ? AND a.id <> ? AND (a.user_id = ? OR a.user_id IS NULL)
      `).all(row.sha256, assetId, userId).map((peer) => ({
        id: peer.id,
        title: peer.title,
        relativePath: peer.relative_path,
      }))
    : [];
  return { ...asset, versions, duplicatePeers: peers };
}

function recordImage({
  userId,
  projectId,
  sceneId,
  relativePath,
  source,
  model,
  prompt,
  promptDraftId,
  derivedFromVersionId,
}) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error('Invalid asset path.');
  const facts = fileFacts(normalized);
  if (facts.missing || facts.invalid) throw new Error('Image file is missing or invalid.');
  const project = projectId ? projectRow(projectId) : null;
  if (projectId && (!project || project.user_id !== userId)) throw new Error('Project not found.');

  rawDb.exec('BEGIN');
  try {
    let asset = projectId && sceneId
      ? rawDb.prepare('SELECT * FROM assets WHERE user_id = ? AND project_id = ? AND scene_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId, projectId, sceneId)
      : null;
    if (!asset) {
      const existingVersion = versionByPath(normalized);
      if (existingVersion) asset = assetById(existingVersion.asset_id);
    }
    if (!asset) {
      const sceneTitle = project && sceneId ? projectTitleForScene(project, sceneId) : '';
      asset = {
        id: insertAsset({
          userId,
          projectId: projectId || null,
          sceneId: sceneId || null,
          title: sceneTitle || (project ? project.title : humanize(path.posix.basename(normalized))),
          lifecycleStatus: 'ACTIVE',
        }),
      };
    }
    const currentMax = rawDb.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM asset_versions WHERE asset_id = ?').get(asset.id);
    const revision = currentMax.revision + 1;
    const versionId = insertVersion({
      assetId: asset.id,
      revision,
      relativePath: normalized,
      isSource: !derivedFromVersionId,
      derivedFromVersionId: derivedFromVersionId || null,
      sha256: facts.sha256,
      mime: facts.mime,
      bytes: facts.bytes,
      width: facts.width,
      height: facts.height,
      source: source || 'generated',
      model: model || null,
      prompt: prompt || null,
      promptDraftId: promptDraftId || null,
    });
    rawDb.prepare('UPDATE assets SET project_id = ?, scene_id = ?, lifecycle_status = ?, current_version_id = ?, updated_at = ? WHERE id = ?')
      .run(projectId || null, sceneId || null, 'ACTIVE', versionId, new Date().toISOString(), asset.id);

    if (project) {
      const images = project.sceneImages.slice();
      let item = images.find((entry) => entry.sceneId === sceneId);
      if (!item) {
        item = { sceneId };
        images.push(item);
      }
      item.file = path.posix.basename(normalized);
      item.mime = facts.mime;
      item.size = '';
      item.bytes = facts.bytes;
      item.assetId = asset.id;
      item.versionId = versionId;
      item.revision = revision;
      if (promptDraftId) item.promptDraftId = promptDraftId;
      if (source) item.source = source;
      if (model) item.model = model;
      if (prompt) item.prompt = prompt;
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      rawDb.prepare('UPDATE projects SET scene_images = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(images), new Date().toISOString(), project.id);
    }
    rawDb.exec('COMMIT');
    return {
      assetId: asset.id,
      versionId,
      revision,
      relativePath: normalized,
      promptDraftId: promptDraftId || null,
    };
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
}

function archiveProject(userId, projectId) {
  rawDb.prepare(`
    UPDATE assets SET lifecycle_status = 'ARCHIVED', updated_at = ?
    WHERE user_id = ? AND project_id = ?
  `).run(new Date().toISOString(), userId, projectId);
}

function canReadPath(userId, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) return false;
  return Boolean(rawDb.prepare(`
    SELECT 1 AS ok
    FROM asset_versions v JOIN assets a ON a.id = v.asset_id
    WHERE v.relative_path = ? AND (a.user_id = ? OR a.user_id IS NULL)
    LIMIT 1
  `).get(normalized, userId));
}

function updateAsset(userId, assetId, patch) {
  const asset = rawDb.prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?').get(assetId, userId);
  if (!asset) return null;
  const next = {
    title: patch.title !== undefined ? String(patch.title).trim().slice(0, 300) : asset.title,
    projectId: patch.projectId !== undefined ? patch.projectId || null : asset.project_id,
    episodeId: patch.episodeId !== undefined ? patch.episodeId || null : asset.episode_id,
    lifecycleStatus: patch.lifecycleStatus !== undefined ? patch.lifecycleStatus : asset.lifecycle_status,
  };
  if (!['ACTIVE', 'ARCHIVED', 'MISSING', 'UNASSIGNED'].includes(next.lifecycleStatus)) {
    throw new Error('Invalid lifecycle status.');
  }
  if (next.projectId) {
    const project = rawDb.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(next.projectId, userId);
    if (!project) throw new Error('Project not found.');
  }
  if (next.episodeId) {
    const episode = rawDb.prepare('SELECT * FROM episodes WHERE id = ? AND user_id = ?').get(next.episodeId, userId);
    if (!episode) throw new Error('Episode not found.');
    if (next.projectId && episode.project_id !== next.projectId) throw new Error('Episode does not belong to the project.');
  }
  rawDb.prepare(`
    UPDATE assets SET title = ?, project_id = ?, episode_id = ?, lifecycle_status = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(next.title, next.projectId, next.episodeId, next.lifecycleStatus, new Date().toISOString(), assetId, userId);
  return getAsset(userId, assetId);
}

function listDuplicateGroups(userId) {
  const assets = listAssets(userId).filter((asset) => asset.sha256);
  const groups = new Map();
  for (const asset of assets) {
    if (!groups.has(asset.sha256)) groups.set(asset.sha256, []);
    groups.get(asset.sha256).push({
      id: asset.id,
      title: asset.label,
      relativePath: asset.relativePath,
      revision: asset.revision,
    });
  }
  return Array.from(groups.entries())
    .filter(([, items]) => items.length > 1)
    .map(([sha256, items]) => ({ sha256, count: items.length, assets: items }));
}

function listEpisodes(userId, projectId) {
  return rawDb.prepare('SELECT * FROM episodes WHERE user_id = ? AND project_id = ? ORDER BY position, created_at')
    .all(userId, projectId);
}

function createEpisode(userId, projectId, title) {
  const project = rawDb.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  if (!project) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const position = (rawDb.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM episodes WHERE project_id = ?').get(projectId).p || 0) + 1;
  rawDb.prepare('INSERT INTO episodes (id,user_id,project_id,title,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, userId, projectId, title, position, now, now);
  return rawDb.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
}

function updateEpisode(userId, episodeId, title) {
  const episode = rawDb.prepare('SELECT * FROM episodes WHERE id = ? AND user_id = ?').get(episodeId, userId);
  if (!episode) return null;
  rawDb.prepare('UPDATE episodes SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, new Date().toISOString(), episodeId, userId);
  return rawDb.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
}

function deleteEpisode(userId, id) {
  return rawDb.prepare('DELETE FROM episodes WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function listCollections(userId) {
  return rawDb.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);
}

function createCollection(userId, name, description) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  rawDb.prepare('INSERT INTO collections (id,user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, name, description || '', now, now);
  return rawDb.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}

function updateCollection(userId, id, name, description) {
  const collection = rawDb.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(id, userId);
  if (!collection) return null;
  rawDb.prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, description || '', new Date().toISOString(), id, userId);
  return rawDb.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}

function deleteCollection(userId, id) {
  return rawDb.prepare('DELETE FROM collections WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function addAssetToCollection(userId, collectionId, assetId) {
  const collection = rawDb.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  const asset = getAsset(userId, assetId);
  if (!collection || !asset) return false;
  rawDb.prepare('INSERT OR IGNORE INTO collection_assets (collection_id,asset_id,added_at) VALUES (?,?,?)')
    .run(collectionId, assetId, new Date().toISOString());
  return true;
}

function removeAssetFromCollection(userId, collectionId, assetId) {
  const collection = rawDb.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!collection) return false;
  rawDb.prepare('DELETE FROM collection_assets WHERE collection_id = ? AND asset_id = ?').run(collectionId, assetId);
  return true;
}

function listTags(userId) {
  return rawDb.prepare('SELECT * FROM tags WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);
}

function createTag(userId, name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  const existing = rawDb.prepare('SELECT * FROM tags WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, normalized);
  if (existing) return existing;
  const id = crypto.randomUUID();
  rawDb.prepare('INSERT INTO tags (id,user_id,name,created_at) VALUES (?,?,?,?)')
    .run(id, userId, normalized, new Date().toISOString());
  return rawDb.prepare('SELECT * FROM tags WHERE id = ?').get(id);
}

function updateTag(userId, id, name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  const tag = rawDb.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(id, userId);
  if (!tag) return null;
  rawDb.prepare('UPDATE tags SET name = ? WHERE id = ? AND user_id = ?').run(normalized, id, userId);
  return rawDb.prepare('SELECT * FROM tags WHERE id = ?').get(id);
}

function deleteTag(userId, id) {
  return rawDb.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function addAssetTag(userId, assetId, name) {
  const asset = getAsset(userId, assetId);
  if (!asset) return null;
  const tag = createTag(userId, name);
  if (!tag) return null;
  rawDb.prepare('INSERT OR IGNORE INTO asset_tags (asset_id,tag_id) VALUES (?,?)').run(assetId, tag.id);
  return tag;
}

function removeAssetTag(userId, assetId, tagId) {
  if (!getAsset(userId, assetId)) return false;
  rawDb.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?').run(assetId, tagId);
  return true;
}

function init(database, directory, databasePath) {
  rawDb = database;
  dataDir = directory;
  dbPath = databasePath;
  imagesDir = path.join(dataDir, 'images');

  const hadAssets = tableExists('assets');
  if (!hadAssets) backupBeforeMigration();
  createSchema();
  migrateSceneImages();
  scanFilesystem();
  return {
    init,
    recordImage,
    archiveProject,
    canReadPath,
    updateAsset,
    listAssets,
    listDuplicateGroups,
    listLibraryImages,
    getAsset,
    listEpisodes,
    createEpisode,
    updateEpisode,
    deleteEpisode,
    listCollections,
    createCollection,
    updateCollection,
    deleteCollection,
    addAssetToCollection,
    removeAssetFromCollection,
    listTags,
    createTag,
    updateTag,
    deleteTag,
    addAssetTag,
    removeAssetTag,
    syncFilesystem: scanFilesystem,
  };
}

module.exports = { init };
