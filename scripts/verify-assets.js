'use strict';

// Verify that every recorded asset version exists under data/images and that
// the file content still matches its recorded SHA-256.
//
// Usage:
//   node scripts/verify-assets.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'app.db');
const imagesDir = path.join(dataDir, 'images');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT relative_path, sha256 FROM asset_versions ORDER BY relative_path').all();
db.close();

let missing = 0;
let mismatched = 0;
let verified = 0;
for (const row of rows) {
  const full = path.resolve(imagesDir, ...row.relative_path.split('/'));
  const relative = path.relative(imagesDir, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.error(`OUTSIDE ROOT: ${row.relative_path}`);
    mismatched += 1;
    continue;
  }
  if (!fs.existsSync(full)) {
    console.error(`MISSING: ${row.relative_path}`);
    missing += 1;
    continue;
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  if (row.sha256 && sha !== row.sha256) {
    console.error(`MISMATCH: ${row.relative_path}`);
    mismatched += 1;
  } else {
    verified += 1;
  }
}

console.log(`Verified ${verified}; missing ${missing}; mismatched ${mismatched}; total ${rows.length}`);
process.exit(missing || mismatched ? 1 : 0);
