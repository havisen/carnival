'use strict';

// Dependency-free backup of the SQLite database and image tree.
//
// Usage:
//   node scripts/backup-assets.js [destination]
//
// Stop the app first for a fully consistent snapshot if files are being written.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'app.db');
const imagesDir = path.join(dataDir, 'images');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.resolve(process.argv[2] || path.join(dataDir, 'backups', `manual-${stamp}`));

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(destination, { recursive: true });
const snapshotPath = path.join(destination, 'app.db');

const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const escaped = snapshotPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}

if (fs.existsSync(imagesDir)) {
  fs.cpSync(imagesDir, path.join(destination, 'images'), { recursive: true });
}

const dbSha256 = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
let fileCount = 0;
let totalBytes = 0;
const copiedImages = path.join(destination, 'images');
if (fs.existsSync(copiedImages)) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(full).size;
      }
    }
  };
  walk(copiedImages);
}

fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  database: 'app.db',
  databaseSha256: dbSha256,
  images: 'images',
  imageFileCount: fileCount,
  imageBytes: totalBytes,
}, null, 2));

console.log(`Backup written to ${destination}`);
console.log(`Database SHA-256: ${dbSha256}`);
console.log(`Images: ${fileCount} files, ${totalBytes} bytes`);
