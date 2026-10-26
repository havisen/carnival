'use strict';

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_history (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', extra_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, PRIMARY KEY(user_id, mode, message_id)
  ); CREATE INDEX IF NOT EXISTS chat_history_order ON chat_history(user_id, mode, created_at);
  CREATE TABLE IF NOT EXISTS chat_images(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(chat_history)').all().some(row => row.name === 'extra_json')) db.exec("ALTER TABLE chat_history ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'");
  const map = row => row ? ({
    id: row.message_id, sequence: row.sequence, role: row.role, content: row.content,
    attachments: JSON.parse(row.attachments_json), createdAt: row.created_at,
    ...JSON.parse(row.extra_json),
  }) : null;
  const list = (userId, mode, before = Number.MAX_SAFE_INTEGER) => db.prepare(`SELECT * FROM (
    SELECT rowid AS sequence, * FROM chat_history WHERE user_id = ? AND mode = ? AND rowid < ?
    ORDER BY rowid DESC LIMIT 200) ORDER BY sequence`).all(userId, mode, before).map(map);
  function append(userId, mode, message) {
    db.prepare(`INSERT OR IGNORE INTO chat_history(user_id,mode,message_id,role,content,attachments_json,extra_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(userId, mode, message.id, message.role, message.content,
      JSON.stringify(message.attachments || []), JSON.stringify(message.extra || {}), new Date().toISOString());
  }
  return { list, append, get: (userId, mode, id) => map(db.prepare('SELECT rowid AS sequence, * FROM chat_history WHERE user_id = ? AND mode = ? AND message_id = ?').get(userId,mode,id)),
    clear: (userId, mode) => db.prepare('DELETE FROM chat_history WHERE user_id = ? AND mode = ?').run(userId, mode),
    imageForUser: (userId, id) => db.prepare('SELECT * FROM chat_images WHERE user_id = ? AND id = ?').get(userId, id),
    addImage: (userId, image) => db.prepare('INSERT INTO chat_images VALUES(?,?,?,?,?,?)').run(image.id, userId, image.file, image.mime, image.name, new Date().toISOString()),
  };
}
module.exports = { init };
