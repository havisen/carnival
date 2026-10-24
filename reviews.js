'use strict';

// ---------------------------------------------------------------------------
// Phase 4 review and quality control
//
// Review records and audit events are append-only. Checklists and safe-cover
// designations are explicit user state. Publication readiness is computed from
// content review evidence plus a distinct publication decision; nothing here
// approves or publishes automatically.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let rawDb = null;
let storyStore = null;
let dbPath = null;

const DECISIONS = new Set(['APPROVED', 'REVISE', 'REJECT', 'OWNER REVIEW']);
const CATEGORIES = [
  { id: 'rights', label: 'Rights' },
  { id: 'adult-character', label: 'Adult character' },
  { id: 'consent', label: 'Consent' },
  { id: 'explicitness', label: 'Explicitness' },
  { id: 'ai-label', label: 'AI label' },
  { id: 'placement', label: 'Placement' },
  { id: 'quality', label: 'Quality' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((item) => item.id));
const STATES = new Set(['pass', 'fail', 'not-applicable', 'unreviewed']);

function now() {
  return new Date().toISOString();
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function schema() {
  rawDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS review_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT,
      prompt_draft_id TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REVISE', 'REJECT', 'OWNER REVIEW')),
      reviewer TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      compared_revisions_json TEXT NOT NULL DEFAULT '[]',
      asset_version_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_records_asset ON review_records(user_id, asset_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_records_prompt ON review_records(user_id, prompt_draft_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS review_checklists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('rights', 'adult-character', 'consent', 'explicitness', 'ai-label', 'placement', 'quality')),
      state TEXT NOT NULL CHECK (state IN ('pass', 'fail', 'not-applicable', 'unreviewed')),
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, asset_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_review_checklists_asset ON review_checklists(user_id, asset_id);

    CREATE TABLE IF NOT EXISTS asset_safe_covers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS publication_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      reviewer TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      asset_version_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_publication_asset ON publication_decisions(user_id, asset_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS review_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT,
      prompt_draft_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      decision TEXT,
      blockers_json TEXT NOT NULL DEFAULT '[]',
      checklist_json TEXT NOT NULL DEFAULT '[]',
      compared_revisions_json TEXT NOT NULL DEFAULT '[]',
      asset_version_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_audit_asset ON review_audit(user_id, asset_id, created_at DESC);
  `);

  for (const [table, column] of [
    ['review_records', 'asset_version_id'],
    ['publication_decisions', 'asset_version_id'],
    ['review_audit', 'asset_version_id'],
  ]) {
    const columns = rawDb.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
    if (!columns.includes(column)) rawDb.exec(`ALTER TABLE ${table} ADD COLUMN asset_version_id TEXT`);
  }
}

function backupBeforeReviewMigration() {
  try {
    const projectCount = rawDb.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    if (!projectCount || !dbPath) return;
    rawDb.exec('PRAGMA wal_checkpoint(FULL)');
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `app-pre-review-${stamp}.db`);
    fs.copyFileSync(dbPath, target);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${dbPath}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`);
    }
    console.log(`  Review migration backup: ${target}`);
  } catch (error) {
    throw new Error(`Could not back up the database before the review migration: ${error.message}`);
  }
}

function assetForUser(userId, assetId) {
  return rawDb.prepare('SELECT * FROM assets WHERE id = ? AND (user_id = ? OR user_id IS NULL)').get(assetId, userId);
}

function promptForUser(userId, promptId) {
  return rawDb.prepare('SELECT * FROM prompt_drafts WHERE id = ? AND user_id = ?').get(promptId, userId);
}

function assetVersion(assetId, versionId) {
  return rawDb.prepare('SELECT * FROM asset_versions WHERE id = ? AND asset_id = ?').get(versionId, assetId);
}

function toReview(row) {
  return {
    id: row.id,
    assetId: row.asset_id || null,
    promptDraftId: row.prompt_draft_id || null,
    decision: row.decision,
    reviewer: row.reviewer,
    reviewerUserId: row.reviewer_user_id,
    notes: row.notes,
    blockers: array(parseJson(row.blockers_json, [])),
    comparedRevisions: array(parseJson(row.compared_revisions_json, [])),
    assetVersionId: row.asset_version_id || null,
    createdAt: row.created_at,
  };
}

function toChecklist(row) {
  return {
    category: row.category,
    state: row.state,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

function toPublication(row) {
  if (!row) return null;
  return {
    id: row.id,
    approved: Boolean(row.approved),
    reviewer: row.reviewer,
    notes: row.notes,
    assetVersionId: row.asset_version_id || null,
    createdAt: row.created_at,
  };
}

function toAudit(row) {
  return {
    id: row.id,
    assetId: row.asset_id || null,
    promptDraftId: row.prompt_draft_id || null,
    actor: row.actor,
    action: row.action,
    decision: row.decision || null,
    blockers: array(parseJson(row.blockers_json, [])),
    checklist: array(parseJson(row.checklist_json, [])),
    comparedRevisions: array(parseJson(row.compared_revisions_json, [])),
    assetVersionId: row.asset_version_id || null,
    createdAt: row.created_at,
  };
}

function latestReview(userId, assetId, promptDraftId) {
  const row = promptDraftId
    ? rawDb.prepare(`
        SELECT * FROM review_records
        WHERE user_id = ? AND prompt_draft_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(userId, promptDraftId)
    : rawDb.prepare(`
        SELECT * FROM review_records
        WHERE user_id = ? AND asset_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(userId, assetId);
  return row ? toReview(row) : null;
}

function reviewHistory(userId, assetId, promptDraftId) {
  const rows = promptDraftId
    ? rawDb.prepare(`
        SELECT * FROM review_records
        WHERE user_id = ? AND prompt_draft_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(userId, promptDraftId)
    : rawDb.prepare(`
        SELECT * FROM review_records
        WHERE user_id = ? AND asset_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(userId, assetId);
  return rows.map(toReview);
}

function checklistFor(userId, assetId) {
  const rows = rawDb.prepare(
    'SELECT * FROM review_checklists WHERE user_id = ? AND asset_id = ?'
  ).all(userId, assetId);
  const byCategory = new Map(rows.map((row) => [row.category, toChecklist(row)]));
  return CATEGORIES.map((category) => byCategory.get(category.id) || {
    category: category.id,
    state: 'unreviewed',
    notes: '',
    updatedAt: null,
  });
}

function safeCoverFor(userId, assetId) {
  const row = rawDb.prepare(
    'SELECT * FROM asset_safe_covers WHERE user_id = ? AND asset_id = ?'
  ).get(userId, assetId);
  if (!row) return null;
  const version = rawDb.prepare('SELECT * FROM asset_versions WHERE id = ? AND asset_id = ?').get(row.version_id, assetId);
  if (!version) return null;
  return {
    versionId: row.version_id,
    relativePath: version.relative_path,
    url: `/api/library/file?path=${encodeURIComponent(version.relative_path)}`,
    createdAt: row.created_at,
  };
}

function latestPublication(userId, assetId) {
  const row = rawDb.prepare(`
    SELECT * FROM publication_decisions
    WHERE user_id = ? AND asset_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(userId, assetId);
  return toPublication(row);
}

function checklistComplete(checklist) {
  return checklist.every((item) => item.state !== 'unreviewed' && item.state !== 'fail');
}

function blockersFor(checklist, review) {
  const blockers = [];
  for (const item of checklist) {
    if (item.state === 'fail') blockers.push(`${item.category}: ${item.notes || 'failed checklist item'}`);
  }
  for (const blocker of array(review && review.blockers)) blockers.push(String(blocker));
  return blockers;
}

function publicationReadiness(userId, assetId) {
  const asset = assetForUser(userId, assetId);
  const currentVersionId = asset ? asset.current_version_id : null;
  const review = latestReview(userId, assetId, null);
  const checklist = checklistFor(userId, assetId);
  const cover = safeCoverFor(userId, assetId);
  const publication = latestPublication(userId, assetId);
  const reviewCurrent = Boolean(review && review.assetVersionId === currentVersionId);
  const publicationCurrent = Boolean(publication && publication.assetVersionId === currentVersionId);
  const contentApproved = Boolean(reviewCurrent && review.decision === 'APPROVED');
  const complete = checklistComplete(checklist);
  const blockers = blockersFor(checklist, review);
  if (review && !reviewCurrent) blockers.push('The latest content review is for an earlier revision.');
  if (publication && !publicationCurrent) blockers.push('The latest publication decision is for an earlier revision.');
  const publicationReady = Boolean(
    contentApproved && complete && cover && publicationCurrent && publication.approved && blockers.length === 0
  );
  const status = publicationReady
    ? 'PUBLICATION READY'
    : review
      ? review.decision
      : 'NOT REVIEWED';
  return {
    review,
    status,
    currentVersionId,
    reviewCurrent,
    publicationCurrent,
    contentApproved,
    checklist,
    checklistComplete: complete,
    safeCover: cover,
    publication,
    publicationReady,
    blockers,
  };
}

function continuityFor(userId, asset) {
  const result = {
    identity: { id: 'identity', label: 'Character identity', state: 'warn', message: 'No scene is linked to this asset.' },
    wardrobe: { id: 'wardrobe', label: 'Wardrobe', state: 'warn', message: 'No scene is linked to this asset.' },
    props: { id: 'props', label: 'Props', state: 'warn', message: 'No scene is linked to this asset.' },
    sceneOrder: { id: 'scene-order', label: 'Scene order', state: 'warn', message: 'No scene is linked to this asset.' },
  };
  if (!asset || !asset.project_id || !asset.scene_id) return Object.values(result);
  const story = storyStore.getStory(userId, asset.project_id);
  if (!story) return Object.values(result);
  const scene = story.scenes.find((item) => item.id === asset.scene_id);
  if (!scene) return Object.values(result);
  const characters = (scene.characterIds || [])
    .map((characterId) => story.characters.find((item) => item.id === characterId))
    .filter(Boolean);

  result.identity = characters.length
    ? {
      id: 'identity',
      label: 'Character identity',
      state: characters.every((character) => character.appearance) ? 'pass' : 'warn',
      message: characters.every((character) => character.appearance)
        ? 'Linked characters have appearance records.'
        : `Appearance missing for: ${characters.filter((character) => !character.appearance).map((character) => character.name).join(', ')}.`,
      sceneId: scene.id,
    }
    : {
      id: 'identity',
      label: 'Character identity',
      state: 'warn',
      message: 'The scene has no linked character bible.',
      sceneId: scene.id,
    };
  result.wardrobe = characters.length
    ? {
      id: 'wardrobe',
      label: 'Wardrobe',
      state: characters.every((character) => character.wardrobe) ? 'pass' : 'warn',
      message: characters.every((character) => character.wardrobe)
        ? 'Linked characters have wardrobe records.'
        : `Wardrobe missing for: ${characters.filter((character) => !character.wardrobe).map((character) => character.name).join(', ')}.`,
      sceneId: scene.id,
    }
    : {
      id: 'wardrobe',
      label: 'Wardrobe',
      state: 'warn',
      message: 'The scene has no linked character bible.',
      sceneId: scene.id,
    };
  result.props = {
    id: 'props',
    label: 'Props',
    state: scene.props ? 'pass' : 'warn',
    message: scene.props ? `Props recorded: ${scene.props}` : 'No props are recorded for this scene.',
    sceneId: scene.id,
  };
  const order = story.scenes.map((item) => item.order);
  const sequential = order.every((value, index) => value === index);
  result.sceneOrder = {
    id: 'scene-order',
    label: 'Scene order',
    state: sequential ? 'pass' : 'warn',
    message: sequential
      ? `Scene ${scene.order + 1} of ${story.scenes.length} is in sequence.`
      : 'Scene order contains a gap or duplicate.',
    sceneId: scene.id,
  };
  return Object.values(result);
}

function addAudit({ userId, assetId, promptDraftId, actor, action, decision, blockers, comparedRevisions, checklist, assetVersionId }) {
  rawDb.prepare(`
    INSERT INTO review_audit
      (id, user_id, asset_id, prompt_draft_id, actor, action, decision,
       blockers_json, checklist_json, compared_revisions_json, asset_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    userId,
    assetId || null,
    promptDraftId || null,
    actor,
    action,
    decision || null,
    JSON.stringify(blockers || []),
    JSON.stringify(checklist || []),
    JSON.stringify(comparedRevisions || []),
    assetVersionId || null,
    now()
  );
}

function publicSummary(userId, assetId) {
  const readiness = publicationReadiness(userId, assetId);
  return {
    decision: readiness.review ? readiness.review.decision : 'NOT REVIEWED',
    status: readiness.status,
    reviewer: readiness.review ? readiness.review.reviewer : null,
    notes: readiness.review ? readiness.review.notes : '',
    createdAt: readiness.review ? readiness.review.createdAt : null,
    publicationReady: readiness.publicationReady,
    publicationDecision: readiness.publication ? readiness.publication.approved : null,
    checklistComplete: readiness.checklistComplete,
    safeCover: Boolean(readiness.safeCover),
    staleReview: Boolean(readiness.review && !readiness.reviewCurrent),
    blockers: readiness.blockers,
  };
}

function getAssetReview(userId, assetId) {
  const asset = assetForUser(userId, assetId);
  if (!asset) return null;
  const readiness = publicationReadiness(userId, assetId);
  return {
    assetId,
    ...readiness,
    history: reviewHistory(userId, assetId, null),
    publications: rawDb.prepare(`
      SELECT * FROM publication_decisions WHERE user_id = ? AND asset_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(userId, assetId).map(toPublication),
    audit: getAudit(userId, assetId, null),
    continuity: continuityFor(userId, asset),
    categories: CATEGORIES,
  };
}

function getAudit(userId, assetId, promptDraftId) {
  const rows = assetId
    ? rawDb.prepare(`
        SELECT * FROM review_audit WHERE user_id = ? AND asset_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(userId, assetId)
    : rawDb.prepare(`
        SELECT * FROM review_audit WHERE user_id = ? AND prompt_draft_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(userId, promptDraftId);
  return rows.map(toAudit);
}

function recordAssetReview(userId, session, assetId, data) {
  const asset = assetForUser(userId, assetId);
  if (!asset) return null;
  const decision = text(data.decision, 40);
  if (!DECISIONS.has(decision)) throw Object.assign(new Error('Invalid review decision.'), { status: 400, code: 'INVALID_DECISION' });
  const notes = text(data.notes, 5000);
  const blockers = array(data.blockers).map((item) => text(item, 500)).filter(Boolean).slice(0, 50);
  const compared = array(data.comparedRevisions).map((item) => text(item, 80)).filter(Boolean).slice(0, 20);
  const id = crypto.randomUUID();
  const reviewer = session.username || 'unknown';
  const created = now();
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare(`
      INSERT INTO review_records
        (id, user_id, asset_id, prompt_draft_id, decision, reviewer, reviewer_user_id,
         notes, blockers_json, compared_revisions_json, asset_version_id, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, assetId, decision, reviewer, userId, notes, JSON.stringify(blockers), JSON.stringify(compared), asset.current_version_id || null, created);
    addAudit({
      userId, assetId, actor: reviewer, action: 'review', decision,
      blockers, comparedRevisions: compared, checklist: checklistFor(userId, assetId),
      assetVersionId: asset.current_version_id || null,
    });
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return getAssetReview(userId, assetId);
}

function saveChecklist(userId, session, assetId, items) {
  const asset = assetForUser(userId, assetId);
  if (!asset) return null;
  if (!Array.isArray(items)) throw Object.assign(new Error('Checklist items must be an array.'), { status: 400 });
  const seen = new Set();
  const cleaned = [];
  for (const item of items) {
    const category = text(item && item.category, 40);
    const state = text(item && item.state, 40);
    if (!CATEGORY_IDS.has(category) || !STATES.has(state) || seen.has(category)) continue;
    seen.add(category);
    cleaned.push({ category, state, notes: text(item.notes, 2000) });
  }
  if (!cleaned.length) throw Object.assign(new Error('Provide at least one valid checklist item.'), { status: 400 });
  rawDb.exec('BEGIN');
  try {
    for (const item of cleaned) {
      rawDb.prepare(`
        INSERT INTO review_checklists (id, user_id, asset_id, category, state, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, asset_id, category) DO UPDATE SET
          state = excluded.state, notes = excluded.notes, updated_at = excluded.updated_at
      `).run(crypto.randomUUID(), userId, assetId, item.category, item.state, item.notes, now());
    }
    addAudit({
      userId, assetId, actor: session.username || 'unknown', action: 'checklist',
      blockers: [], checklist: checklistFor(userId, assetId), comparedRevisions: [],
      assetVersionId: asset.current_version_id || null,
    });
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return getAssetReview(userId, assetId);
}

function setSafeCover(userId, session, assetId, versionId) {
  const asset = assetForUser(userId, assetId);
  if (!asset) return null;
  if (versionId) {
    const version = assetVersion(assetId, versionId);
    if (!version) throw Object.assign(new Error('Safe-cover version not found for this asset.'), { status: 404, code: 'COVER_NOT_FOUND' });
  }
  rawDb.exec('BEGIN');
  try {
    if (versionId) {
      rawDb.prepare(`
        INSERT INTO asset_safe_covers (id, user_id, asset_id, version_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, asset_id) DO UPDATE SET version_id = excluded.version_id, created_at = excluded.created_at
      `).run(crypto.randomUUID(), userId, assetId, versionId, now());
    } else {
      rawDb.prepare('DELETE FROM asset_safe_covers WHERE user_id = ? AND asset_id = ?').run(userId, assetId);
    }
    addAudit({
      userId, assetId, actor: session.username || 'unknown', action: 'safe-cover',
      blockers: [], checklist: [], comparedRevisions: versionId ? [versionId] : [],
      assetVersionId: asset.current_version_id || null,
    });
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return getAssetReview(userId, assetId);
}

function recordPublication(userId, session, assetId, data) {
  const asset = assetForUser(userId, assetId);
  if (!asset) return null;
  const approved = data.approved === true;
  const notes = text(data.notes, 5000);
  const readiness = publicationReadiness(userId, assetId);
  if (approved) {
    const blockers = [];
    if (!readiness.contentApproved) blockers.push('Content review is not APPROVED.');
    if (!readiness.checklistComplete) blockers.push('Checklist is incomplete or has a failed item.');
    if (!readiness.safeCover) blockers.push('No safe cover is designated.');
    if (readiness.blockers.length) blockers.push(...readiness.blockers);
    if (blockers.length) {
      throw Object.assign(new Error('Publication approval is blocked by incomplete evidence.'), {
        status: 409,
        code: 'PUBLICATION_EVIDENCE_INCOMPLETE',
        blockers,
      });
    }
  }
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare(`
      INSERT INTO publication_decisions
        (id, user_id, asset_id, approved, reviewer, reviewer_user_id, notes, asset_version_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), userId, assetId, approved ? 1 : 0,
      session.username || 'unknown', userId, notes, asset.current_version_id || null, now()
    );
    addAudit({
      userId, assetId, actor: session.username || 'unknown', action: 'publication',
      decision: approved ? 'APPROVED' : 'REVISE', blockers: readiness.blockers,
      checklist: readiness.checklist, comparedRevisions: [],
      assetVersionId: asset.current_version_id || null,
    });
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return getAssetReview(userId, assetId);
}

function recordPromptReview(userId, session, promptId, data) {
  const prompt = promptForUser(userId, promptId);
  if (!prompt) return null;
  const decision = text(data.decision, 40);
  if (!DECISIONS.has(decision)) throw Object.assign(new Error('Invalid review decision.'), { status: 400, code: 'INVALID_DECISION' });
  const notes = text(data.notes, 5000);
  const blockers = array(data.blockers).map((item) => text(item, 500)).filter(Boolean).slice(0, 50);
  const compared = array(data.comparedRevisions).map((item) => text(item, 80)).filter(Boolean).slice(0, 20);
  const reviewer = session.username || 'unknown';
  rawDb.exec('BEGIN');
  try {
    rawDb.prepare(`
      INSERT INTO review_records
        (id, user_id, asset_id, prompt_draft_id, decision, reviewer, reviewer_user_id,
         notes, blockers_json, compared_revisions_json, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId, prompt.id, decision, reviewer, userId, notes, JSON.stringify(blockers), JSON.stringify(compared), now());
    addAudit({
      userId, promptDraftId: prompt.id, actor: reviewer, action: 'prompt-review',
      decision, blockers, comparedRevisions: compared, checklist: [],
    });
    rawDb.exec('COMMIT');
  } catch (error) {
    rawDb.exec('ROLLBACK');
    throw error;
  }
  return promptReview(userId, prompt.id);
}

function promptReview(userId, promptId) {
  const prompt = promptForUser(userId, promptId);
  if (!prompt) return null;
  return {
    promptDraftId: prompt.id,
    latest: latestReview(userId, null, prompt.id),
    history: reviewHistory(userId, null, prompt.id),
    audit: getAudit(userId, null, prompt.id),
  };
}

function enrichAssets(userId, assets) {
  for (const asset of assets) {
    const assetId = asset.assetId || asset.id;
    const summary = publicSummary(userId, assetId);
    asset.reviewDecision = summary.decision;
    asset.reviewStatus = summary.status;
    asset.publicationReady = summary.publicationReady;
    asset.publicationDecision = summary.publicationDecision;
    asset.checklistComplete = summary.checklistComplete;
    asset.safeCover = summary.safeCover;
    asset.staleReview = summary.staleReview;
    if (asset.metadata) {
      asset.metadata.reviewDecision = summary.decision === 'NOT REVIEWED' ? null : summary.decision;
      asset.metadata.reviewStatus = summary.status;
      asset.metadata.publicationReady = summary.publicationReady;
      asset.metadata.staleReview = summary.staleReview;
    }
  }
  return assets;
}

function init(database, story, databasePath) {
  rawDb = database;
  storyStore = story;
  dbPath = databasePath;
  const hadTables = Boolean(rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_records'").get());
  if (!hadTables) backupBeforeReviewMigration();
  schema();
  return {
    init,
    getAssetReview,
    recordAssetReview,
    saveChecklist,
    setSafeCover,
    recordPublication,
    recordPromptReview,
    promptReview,
    getAudit,
    continuityFor,
    enrichAssets,
    publicSummary,
    categories: CATEGORIES,
  };
}

module.exports = { init };
