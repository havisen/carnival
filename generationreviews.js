'use strict';

const crypto = require('node:crypto');

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS generation_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_review_active
    ON generation_reviews(user_id, IFNULL(project_id, ''), kind, target)
    WHERE status IN ('running', 'pending');`);
  // A stopped process cannot still be generating. Completed drafts retain their lock.
  db.prepare("UPDATE generation_reviews SET status = 'failed' WHERE status = 'running'").run();

  // Bring the latest pre-existing sheet draft into the same decision flow once.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'character_sheets'").get()) {
    db.exec(`INSERT OR IGNORE INTO generation_reviews
      (id, user_id, project_id, kind, target, status, result_json, created_at)
      SELECT 'legacy-sheet-' || s.id, s.user_id, s.project_id, 'sheet', s.character_id, 'pending',
        json_object('sheet', json_object('id', s.id)), s.created_at
      FROM character_sheets s
      WHERE s.status = 'draft'
        AND s.version = (SELECT MAX(version) FROM character_sheets WHERE character_id = s.character_id AND project_id = s.project_id)
        AND NOT EXISTS (SELECT 1 FROM generation_reviews r WHERE r.user_id = s.user_id AND r.project_id = s.project_id
          AND r.kind = 'sheet' AND r.target = s.character_id)`);
  }

  function decode(row) {
    if (!row) return null;
    return { id: row.id, projectId: row.project_id || '', kind: row.kind, target: row.target,
      status: row.status, result: JSON.parse(row.result_json) };
  }
  function get(userId, id) {
    return decode(db.prepare('SELECT * FROM generation_reviews WHERE user_id = ? AND id = ?').get(userId, id));
  }
  function list(userId) {
    return db.prepare("SELECT * FROM generation_reviews WHERE user_id = ? AND status IN ('running', 'pending') ORDER BY created_at")
      .all(userId).map(decode);
  }
  function begin(userId, projectId, kind, target = '') {
    const existing = list(userId).find((item) => item.projectId === (projectId || '') && item.kind === kind && item.target === target);
    if (existing) throw Object.assign(new Error(existing.status === 'running'
      ? 'Generation is already in progress.' : 'Approve or disapprove the generated result before generating again.'),
      { status: 409, code: 'GENERATION_REVIEW_REQUIRED' });
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO generation_reviews (id, user_id, project_id, kind, target, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, projectId || null, kind, target, 'running', new Date().toISOString());
    return get(userId, id);
  }
  function complete(userId, id, result) {
    db.prepare("UPDATE generation_reviews SET status = 'pending', result_json = ? WHERE id = ? AND user_id = ? AND status = 'running'")
      .run(JSON.stringify(result), id, userId);
    return get(userId, id);
  }
  function fail(userId, id) {
    db.prepare("UPDATE generation_reviews SET status = 'failed' WHERE id = ? AND user_id = ? AND status = 'running'").run(id, userId);
  }
  function decide(userId, id, decision) {
    if (!['approved', 'disapproved'].includes(decision)) throw Object.assign(new Error('Choose approved or disapproved.'), { status: 400 });
    const review = get(userId, id);
    if (!review) throw Object.assign(new Error('Generated result not found.'), { status: 404 });
    if (review.status !== 'pending') throw Object.assign(new Error('This result is not awaiting a decision.'), { status: 409 });
    db.prepare('UPDATE generation_reviews SET status = ?, decided_at = ? WHERE id = ? AND user_id = ?')
      .run(decision, new Date().toISOString(), id, userId);
    return get(userId, id);
  }
  return { get, list, begin, complete, fail, decide };
}

module.exports = { init };
