'use strict';

// ---------------------------------------------------------------------------
// Reviewer bot persistence
//
// The legacy content_hash column stores a fingerprint of all review inputs:
// field content, relevant context, provider, model, instructions, and criteria.
// Old content-only entries remain stored but cannot match the new fingerprints.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

let rawDb = null;

function now() {
  return new Date().toISOString();
}

function schema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS field_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      box TEXT NOT NULL,
      field_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reviewed', 'failed')),
      summary TEXT NOT NULL DEFAULT '',
      findings_json TEXT NOT NULL DEFAULT '[]',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      reviewed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_field_reviews_lookup
      ON field_reviews(user_id, project_id, box, field_id, content_hash);
  `);
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function toReview(row) {
  if (!row) return null;
  return {
    id: row.field_id,
    status: row.status,
    summary: row.summary,
    findings: parseArray(row.findings_json),
    suggestions: parseArray(row.suggestions_json),
    model: row.model || null,
    reviewedAt: row.reviewed_at,
  };
}

function get(userId, projectId, box, fieldId, contentHash) {
  const row = rawDb.prepare(`
    SELECT * FROM field_reviews
    WHERE user_id = ? AND project_id = ? AND box = ? AND field_id = ? AND content_hash = ?
    ORDER BY reviewed_at DESC, rowid DESC LIMIT 1
  `).get(userId, projectId, box, fieldId, contentHash);
  return toReview(row);
}

function listFor(userId, projectId, box) {
  const rows = rawDb.prepare(`
    SELECT * FROM field_reviews
    WHERE user_id = ? AND project_id = ? AND box = ?
  `).all(userId, projectId, box);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.field_id}|${row.content_hash}`, toReview(row));
  }
  return map;
}

function save(userId, projectId, box, field) {
  const timestamp = field.reviewedAt || now();
  const findings = JSON.stringify(Array.isArray(field.findings) ? field.findings : []);
  const suggestions = JSON.stringify(Array.isArray(field.suggestions) ? field.suggestions : []);
  const existing = rawDb.prepare(`
    SELECT id FROM field_reviews
    WHERE user_id = ? AND project_id = ? AND box = ? AND field_id = ? AND content_hash = ?
  `).get(userId, projectId, box, field.id, field.contentHash);

  if (existing) {
    rawDb.prepare(`
      UPDATE field_reviews
      SET status = ?, summary = ?, findings_json = ?, suggestions_json = ?, model = ?, reviewed_at = ?
      WHERE id = ?
    `).run(
      field.status,
      field.summary || '',
      findings,
      suggestions,
      field.model || null,
      timestamp,
      existing.id
    );
  } else {
    rawDb.prepare(`
      INSERT INTO field_reviews
        (id, user_id, project_id, box, field_id, content_hash, status, summary, findings_json, suggestions_json, model, reviewed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      userId,
      projectId,
      box,
      field.id,
      field.contentHash,
      field.status,
      field.summary || '',
      findings,
      suggestions,
      field.model || null,
      timestamp,
      now()
    );
  }

  return get(userId, projectId, box, field.id, field.contentHash);
}

function init(database) {
  rawDb = database;
  schema();
  return { get, listFor, save };
}

module.exports = { init };
