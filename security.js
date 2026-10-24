'use strict';

// ---------------------------------------------------------------------------
// Password hashing, API-key encryption, sessions, and cookie helpers
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_BYTES = 64;
const SALT_BYTES = 16;

let encryptionKey = null;

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Loads the secret used to encrypt API keys at rest. Prefer an explicit
 * APP_SECRET; otherwise generate one once and keep it next to the database.
 */
function init(dataDir) {
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const file = path.join(dataDir, 'secret.key');
    try {
      secret = fs.readFileSync(file, 'utf8').trim();
    } catch (_) { /* generate below */ }

    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
      console.warn(
        '\n  No APP_SECRET set. Generated %s\n  Set APP_SECRET in production; if it changes, saved API keys must be re-entered.\n',
        file
      );
    }
  }

  if (secret.length < 16) {
    throw new Error('APP_SECRET must be at least 16 characters long.');
  }

  encryptionKey = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('project-workflow'),
      Buffer.from('api-key-encryption-v1'),
      32
    )
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, HASH_BYTES);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

async function verifyPassword(password, saltHex, hashHex) {
  if (typeof saltHex !== 'string' || typeof hashHex !== 'string') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  if (!expected.length || !salt.length) return false;

  const actual = await scryptAsync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Burn the same amount of work as a real check when the username is unknown,
 * so response timing does not reveal which accounts exist.
 */
async function burnPasswordCheck(password) {
  try {
    await scryptAsync(String(password), Buffer.alloc(SALT_BYTES, 7), HASH_BYTES);
  } catch (_) { /* ignore */ }
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function encryptApiKey(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

function decryptApiKey(payload) {
  if (!payload || !encryptionKey) return null;
  try {
    const parts = String(payload).split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

function maskApiKey(key) {
  const value = String(key || '');
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch (_) {
      out[name] = raw;
    }
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

function isSecureRequest(req) {
  return Boolean(req.socket && req.socket.encrypted) ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

module.exports = {
  init,
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  randomToken,
  sha256,
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  parseCookies,
  serializeCookie,
  isSecureRequest,
};
