'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const security = require('./security');
const assetStore = require('./assets').init(db.db, db.DATA_DIR, db.DB_PATH);
const storyModule = require('./story');
const { normalizeStoryWorkspace } = storyModule;
const storyStore = storyModule.init(db.db, db.DB_PATH);
const generationStore = require('./generation').init(db.db);
const reviewStore = require('./reviews').init(db.db, storyStore, db.DB_PATH);
const fieldReviewStore = require('./fieldreviews').init(db.db);
const characterStore = require('./characters').init(db.db);
const standaloneStore = require('./standalone').init(db.db);
const { prepareImagePrompt } = require('./imagecomposition');
const { init: initApiUsage, normalizeUsage } = require('./apiusage');
const apiUsageStore = initApiUsage(db.db);
const requestTracker = require('./track').init(db.db);

security.init(db.DATA_DIR);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined;
const APP_VERSION = '4.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHARACTER_SHEET_LAYOUT_REFERENCE_PATH = path.join(
  PUBLIC_DIR,
  'images',
  'character-sheet-layout-reference.png'
);
const DEEPSEEK_ENDPOINT =
  process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const BYTEPLUS_IMAGE_ENDPOINT =
  process.env.BYTEPLUS_IMAGE_ENDPOINT ||
  'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations';
const IMAGE_MODEL_SIZES = new Map([
  ['dola-seedream-5-0-pro-260628', ['1K', '1.5K', '2K']],
]);
const DEFAULT_TEXT_MODEL = 'deepseek-v4-pro';
const configuredImageModel = process.env.BYTEPLUS_IMAGE_MODEL || 'dola-seedream-5-0-pro-260628';
const DEFAULT_IMAGE_MODEL = IMAGE_MODEL_SIZES.has(configuredImageModel)
  ? configuredImageModel
  : 'dola-seedream-5-0-pro-260628';
const TEXT_MODELS = new Set([
  'deepseek-v4-pro',
]);
const CHAT_PROVIDERS = new Set(['deepseek', 'anthropic', 'openai']);
const ANTHROPIC_ENDPOINT =
  process.env.ANTHROPIC_ENDPOINT || 'https://api.anthropic.com/v1/messages';
const OPENAI_DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT_MODEL = process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-20250514';
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini';
const IMAGE_DIR = path.join(db.DATA_DIR, 'images');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const LIBRARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const LIBRARY_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const LIBRARY_HEADER_BYTES = 128 * 1024;
const LIBRARY_HIDDEN = new Set(['Thumbs.db', 'desktop.ini']);
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_COOKIE = 'sid';

const STATUSES = new Set(['Not Started', 'In Progress', 'Done']);
const STAGES = new Set(['Idea Stage', 'Reference Stage', 'Generation Stage']);
const PRIORITIES = new Set(['Low', 'Medium', 'High']);
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// Optional exact public origin, for proxies that rewrite the Host header.
// Example: PUBLIC_ORIGIN=https://app.kontorkjop.com
const PUBLIC_ORIGIN = (() => {
  const value = process.env.PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch (_) {
    console.warn('  Ignoring invalid PUBLIC_ORIGIN (expected e.g. https://app.example.com).');
    return null;
  }
})();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, message, code) {
  throw new HttpError(status, message, code);
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function applyCsp(res) {
  res.setHeader(
    'Content-Security-Policy',
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

function applyCacheHeaders(res, filePath, versioned) {
  const ext = path.extname(filePath).toLowerCase();
  if (versioned && ext !== '.html') {
    // A URL with ?v= is content-addressed, so it can be cached forever.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    // HTML and unversioned assets must be revalidated on every load. Otherwise
    // a deploy can leave a browser running an old app.js that calls endpoints
    // which no longer exist (e.g. the removed /api/generate).
    res.setHeader('Cache-Control', 'no-cache');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      requestTracker.requestChunk(req, chunk);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      requestTracker.requestChunk(req, chunk);
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Image is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      requestTracker.requestBody('[binary body omitted]', req);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', extension: 'webp' };
  }
  return null;
}

async function readJSON(req) {
  const raw = await readBody(req);
  requestTracker.requestBody(raw);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    fail(400, 'Invalid JSON body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(400, 'Invalid JSON body.');
  }
  requestTracker.requestBody(parsed);
  return parsed;
}

/**
 * Basic CSRF defence: state-changing requests must come from this origin.
 * SameSite=Lax on the session cookie is the second layer.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;

    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch (_) {
      return false;
    }
    const forwarded = req.headers['x-forwarded-host'];
    const host = forwarded ? String(forwarded).split(',')[0].trim() : req.headers.host;
    return originHost === host;
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = process.env.NODE_ENV === 'test' && Number(process.env.LOGIN_WINDOW_MS) > 0
  ? Number(process.env.LOGIN_WINDOW_MS)
  : 15 * 60 * 1000;

function loginKey(req, username) {
  return `${req.socket.remoteAddress || 'unknown'}|${String(username || '-').toLowerCase()}`;
}

function isRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function noteLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
  if (loginAttempts.size > 5000) {
    for (const [k, v] of loginAttempts) {
      if (v.resetAt <= now) loginAttempts.delete(k);
    }
  }
}

function currentSession(req) {
  const token = security.parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 200) return null;

  const row = db.getSession(security.sha256(token));
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.deleteSession(row.token_hash);
    return null;
  }
  return row;
}

function requireUser(req) {
  const session = currentSession(req);
  if (!session) fail(401, 'Please sign in.');
  return session;
}

function startSession(req, res, userId) {
  requestTracker.identify(userId);
  db.deleteExpiredSessions();
  const token = security.randomToken();
  db.createSession({
    tokenHash: security.sha256(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  res.setHeader(
    'Set-Cookie',
    security.serializeCookie(SESSION_COOKIE, token, {
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: security.isSecureRequest(req),
    })
  );
}

function endSession(req, res) {
  const token = security.parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.deleteSession(security.sha256(token));

  res.setHeader(
    'Set-Cookie',
    security.serializeCookie(SESSION_COOKIE, '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: security.isSecureRequest(req),
    })
  );
}

function publicUser(row) {
  const id = row.user_id || row.id;
  return {
    id,
    username: row.username,
    hasApiKey: Boolean(row.api_key_enc),
    apiKeyHint: row.api_key_hint || null,
    hasBytePlusKey: Boolean(row.byteplus_api_key_enc),
    byteplusKeyHint: row.byteplus_api_key_hint || null,
    textModel: TEXT_MODELS.has(row.text_model) ? row.text_model : DEFAULT_TEXT_MODEL,
    imageModel: IMAGE_MODEL_SIZES.has(row.image_model) ? row.image_model : DEFAULT_IMAGE_MODEL,
    hasAnthropicKey: Boolean(row.anthropic_api_key_enc),
    anthropicKeyHint: row.anthropic_api_key_hint || null,
    hasOpenAIKey: Boolean(row.openai_api_key_enc),
    openAIKeyHint: row.openai_api_key_hint || null,
    openAIBaseUrl: row.openai_base_url || '',
    guideProvider: CHAT_PROVIDERS.has(row.guide_provider) ? row.guide_provider : 'deepseek',
    guideModel: row.guide_model || '',
    guideContext: row.guide_context || '',
    reviewerProvider: CHAT_PROVIDERS.has(row.reviewer_provider) ? row.reviewer_provider : 'deepseek',
    reviewerModel: row.reviewer_model || '',
    reviewerContext: row.reviewer_context || '',
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async function handleRegister(req, res) {
  const body = await readJSON(req);
  const username = String(body.username || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    fail(400, 'Username must be 3–32 characters: letters, numbers, dot, dash, or underscore.');
  }
  if (password.length < 8 || password.length > 200) {
    fail(400, 'Password must be between 8 and 200 characters.');
  }
  if (db.getUserByUsername(username)) {
    fail(409, 'That username is already taken.');
  }

  const { hash, salt } = await security.hashPassword(password);
  let user;
  try {
    user = db.createUser({
      id: crypto.randomUUID(),
      username,
      passwordHash: hash,
      passwordSalt: salt,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) fail(409, 'That username is already taken.');
    throw err;
  }

  startSession(req, res, user.id);
  return sendJSON(res, 201, { user: publicUser(user) });
}

async function handleLogin(req, res) {
  const body = await readJSON(req);
  const username = String(body.username || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';
  const key = loginKey(req, username);

  if (isRateLimited(key)) {
    fail(429, 'Too many sign-in attempts. Try again in a few minutes.');
  }
  if (!username || !password) {
    fail(400, 'Enter your username and password.');
  }
  if (password.length > 200) {
    fail(401, 'Invalid username or password.');
  }

  const user = db.getUserByUsername(username);
  if (!user) {
    await security.burnPasswordCheck(password);
    noteLoginFailure(key);
    console.warn('  Login failed: no account %s (database: %s).', JSON.stringify(username), db.DB_PATH);
    fail(401, 'Invalid username or password.');
  }

  const ok = await security.verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    noteLoginFailure(key);
    console.warn('  Login failed: wrong password for %s.', JSON.stringify(username));
    fail(401, 'Invalid username or password.');
  }

  loginAttempts.delete(key);
  startSession(req, res, user.id);
  return sendJSON(res, 200, { user: publicUser(user) });
}

function handleLogout(req, res) {
  endSession(req, res);
  return sendJSON(res, 200, { ok: true });
}

function handleMe(req, res) {
  const session = requireUser(req);
  return sendJSON(res, 200, { user: publicUser(session) });
}

async function handleSaveApiKey(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (apiKey.length < 8 || apiKey.length > 512) {
    fail(400, 'Enter a valid DeepSeek API key (8–512 characters).');
  }
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    fail(400, 'API keys cannot contain spaces or control characters.');
  }

  const updated = db.setUserApiKey(
    session.user_id,
    security.encryptApiKey(apiKey),
    security.maskApiKey(apiKey)
  );
  return sendJSON(res, 200, { user: publicUser(updated) });
}

function handleDeleteApiKey(req, res) {
  const session = requireUser(req);
  const updated = db.setUserApiKey(session.user_id, null, null);
  return sendJSON(res, 200, { user: publicUser(updated) });
}

async function handleSaveBytePlusKey(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (apiKey.length < 8 || apiKey.length > 512) {
    fail(400, 'Enter a valid BytePlus API key (8–512 characters).');
  }
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    fail(400, 'API keys cannot contain spaces or control characters.');
  }

  const updated = db.setUserBytePlusKey(
    session.user_id,
    security.encryptApiKey(apiKey),
    security.maskApiKey(apiKey)
  );
  return sendJSON(res, 200, { user: publicUser(updated) });
}

function handleDeleteBytePlusKey(req, res) {
  const session = requireUser(req);
  const updated = db.setUserBytePlusKey(session.user_id, null, null);
  return sendJSON(res, 200, { user: publicUser(updated) });
}

async function handleSaveAISettings(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  const textModel = typeof body.textModel === 'string'
    ? body.textModel.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  const imageModel = typeof body.imageModel === 'string'
    ? body.imageModel.trim()
    : (IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL);

  if (!TEXT_MODELS.has(textModel)) {
    fail(400, 'Unsupported text model. Choose DeepSeek 4 Pro.');
  }
  if (!IMAGE_MODEL_SIZES.has(imageModel)) {
    fail(400, 'Unsupported image model. Choose Seedream 5.0 Pro.');
  }

  const updated = db.setUserAISettings(session.user_id, textModel, imageModel);
  return sendJSON(res, 200, { user: publicUser(updated) });
}

function validProviderKey(value, label) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 512) {
    fail(400, `Enter a valid ${label} API key (8–512 characters).`);
  }
  if (!/^[\x21-\x7E]+$/.test(key)) {
    fail(400, 'API keys cannot contain spaces or control characters.');
  }
  return key;
}

async function handleSaveAnthropicKey(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const apiKey = validProviderKey(body.apiKey, 'Anthropic');
  const updated = db.setUserAnthropicKey(
    session.user_id,
    security.encryptApiKey(apiKey),
    security.maskApiKey(apiKey)
  );
  return sendJSON(res, 200, { user: publicUser(updated) });
}

function handleDeleteAnthropicKey(req, res) {
  const session = requireUser(req);
  const updated = db.setUserAnthropicKey(session.user_id, null, null);
  return sendJSON(res, 200, { user: publicUser(updated) });
}

async function handleSaveOpenAIKey(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const apiKey = validProviderKey(body.apiKey, 'OpenAI-compatible');
  let baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        fail(400, 'The base URL must use http:// or https://.');
      }
      baseUrl = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, ''));
      if (!baseUrl) baseUrl = parsed.origin;
    } catch (_) {
      fail(400, 'Enter a valid base URL (e.g. https://api.openai.com/v1).');
    }
    if (baseUrl.length > 2000) fail(400, 'The base URL is too long.');
  }
  const updated = db.setUserOpenAIKey(
    session.user_id,
    security.encryptApiKey(apiKey),
    security.maskApiKey(apiKey),
    baseUrl
  );
  return sendJSON(res, 200, { user: publicUser(updated) });
}

function handleDeleteOpenAIKey(req, res) {
  const session = requireUser(req);
  const updated = db.setUserOpenAIKey(session.user_id, null, null, '');
  return sendJSON(res, 200, { user: publicUser(updated) });
}

async function handleSaveChatSettings(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  const provider = (value, fallback) => {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return CHAT_PROVIDERS.has(raw) ? raw : fallback;
  };
  const model = (value) => (typeof value === 'string' ? value.trim().slice(0, 100) : '');
  const context = (value) => (typeof value === 'string' ? value.trim().slice(0, 20000) : '');

  const settings = {
    guideProvider: provider(body.guideProvider, 'deepseek'),
    guideModel: model(body.guideModel),
    guideContext: context(body.guideContext),
    reviewerProvider: provider(body.reviewerProvider, 'deepseek'),
    reviewerModel: model(body.reviewerModel),
    reviewerContext: context(body.reviewerContext),
  };

  const updated = db.setUserChatSettings(session.user_id, settings);
  return sendJSON(res, 200, { user: publicUser(updated) });
}

// ---------------------------------------------------------------------------
// Project endpoints
// ---------------------------------------------------------------------------

function normalizeSceneList(value, max = 20) {
  if (!Array.isArray(value)) {
    if (value && Array.isArray(value.scenes)) value = value.scenes;
    else return [];
  }
  return value.slice(0, max).map((raw, index) => {
    const scene = raw && typeof raw === 'object' ? raw : {};
    const id = typeof scene.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(scene.id)
      ? scene.id
      : crypto.randomUUID();
    const characterSource = Array.isArray(scene.characters)
      ? scene.characters
      : typeof scene.characters === 'string'
        ? scene.characters.split(',')
        : [];

    const characterIds = Array.isArray(scene.characterIds)
      ? scene.characterIds
        .map((value) => String(value || '').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 12)
      : [];

    return {
      id,
      order: index,
      title: String(scene.title || `Scene ${index + 1}`).trim().slice(0, 200),
      beat: String(scene.beat || '').trim().slice(0, 2000),
      props: String(scene.props || '').trim().slice(0, 2000),
      action: String(scene.action || '').trim().slice(0, 5000),
      location: String(scene.location || '').trim().slice(0, 200),
      characters: characterSource
        .map((name) => String(name || '').trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 12),
      locationId: typeof scene.locationId === 'string'
        ? scene.locationId.trim().slice(0, 80)
        : '',
      characterIds,
    };
  });
}

function cleanSceneList(value) {
  if (!Array.isArray(value)) fail(400, 'Scenes must be an array.');
  if (value.length > 20) fail(400, 'Too many scenes (max 20).');
  return normalizeSceneList(value);
}

function cleanPromptList(value) {
  if (!Array.isArray(value)) fail(400, 'Generation prompts must be an array.');
  if (value.length > 50) fail(400, 'Too many prompts (max 50).');

  const prompts = [];
  for (const raw of value) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const sceneId = String(item.sceneId || '').trim().slice(0, 64);
    const prompt = String(item.prompt || '').trim().slice(0, 30000);
    if (sceneId && prompt) prompts.push({ sceneId, prompt });
  }
  return prompts;
}

function cleanCharacterReferences(value) {
  if (!Array.isArray(value)) fail(400, 'Character references must be an array.');
  if (value.length > 8) fail(400, 'Too many character references (max 8).');

  return value
    .slice(0, 8)
    .map((raw) => {
      const item = raw && typeof raw === 'object' ? raw : {};
      return {
        name: String(item.name || '').trim().slice(0, 120),
        gender: String(item.gender || '').trim().slice(0, 40),
        referenceMaterial: String(item.referenceMaterial || item.material || '')
          .trim()
          .slice(0, 30000),
      };
    })
    .filter((item) => item.name || item.referenceMaterial);
}

function requireReferenceForGeneration(reference) {
  if (!String(reference || '').trim()) {
    fail(
      409,
      'Generate and save reference material before moving to Generation Stage.',
      'REFERENCE_REQUIRED'
    );
  }
}

function cleanProjectBody(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) fail(400, 'Project title is required.');
    if (title.length > 200) fail(400, 'Project title is too long (max 200 characters).');
    out.title = title;
  }
  if (!partial || body.idea !== undefined) {
    const idea = String(body.idea || '').trim();
    if (idea.length > 5000) fail(400, 'Idea is too long (max 5000 characters).');
    out.idea = idea;
  }
  if (!partial || body.description !== undefined) {
    const description = String(body.description || '').trim();
    if (description.length > 5000) fail(400, 'Description is too long (max 5000 characters).');
    out.description = description;
  }
  if (!partial || body.referenceMaterial !== undefined) {
    const referenceMaterial = String(body.referenceMaterial || '').trim();
    if (referenceMaterial.length > 200000) {
      fail(400, 'Reference material is too long (max 200,000 characters).');
    }
    out.reference_material = referenceMaterial;
  }
  if (!partial || body.scenes !== undefined) {
    out.scenes = cleanSceneList(body.scenes || []);
  }
  if (!partial || body.generationPrompts !== undefined) {
    out.generation_prompts = cleanPromptList(body.generationPrompts || []);
  }
  if (!partial || body.characterReferences !== undefined) {
    out.character_references = cleanCharacterReferences(body.characterReferences || []);
  }
  if (!partial || body.stage !== undefined) {
    const stage = String(body.stage || 'Idea Stage');
    if (!STAGES.has(stage)) {
      fail(400, 'Invalid project stage. Allowed: Idea Stage, Reference Stage, Generation Stage.');
    }
    out.stage = stage;
  }
  if (!partial || body.status !== undefined) {
    let status = String(body.status || 'Not Started');
    if (status === 'Backlog') status = 'Not Started'; // old client / old data alias
    if (!STATUSES.has(status)) {
      fail(400, 'Invalid project status. Allowed: Not Started, In Progress, Done.');
    }
    out.status = status;
  }
  if (!partial || body.priority !== undefined) {
    const priority = String(body.priority || 'Medium');
    if (!PRIORITIES.has(priority)) fail(400, 'Invalid project priority.');
    out.priority = priority;
  }
  if (body.source !== undefined) {
    out.source = body.source === 'idea' ? 'idea' : 'manual';
  }
  return out;
}

function handleListProjects(req, res) {
  const session = requireUser(req);
  return sendJSON(res, 200, { projects: db.listProjects(session.user_id) });
}

async function handleCreateProject(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const data = cleanProjectBody(body);
  if (data.stage === 'Generation Stage') {
    requireReferenceForGeneration(data.reference_material);
  }
  const project = db.createProject(session.user_id, data);
  storyStore.ensureProject(project.id);
  return sendJSON(res, 201, { project });
}

async function handleUpdateProject(req, res, id) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const patch = cleanProjectBody(body, { partial: true });

  if (patch.stage === 'Generation Stage') {
    const existing = db.getProject(session.user_id, id);
    if (!existing) fail(404, 'Project not found.');
    const reference = patch.reference_material !== undefined
      ? patch.reference_material
      : existing.referenceMaterial;
    requireReferenceForGeneration(reference);
  }

  const project = db.updateProject(session.user_id, id, patch);
  if (!project) fail(404, 'Project not found.');
  if (patch.character_references !== undefined) {
    storyStore.importReferenceResult(project.id);
  } else if (patch.scenes !== undefined) {
    storyStore.syncScenes(project.id);
  }
  if (patch.generation_prompts !== undefined) {
    storyStore.importGenerationPrompts(project.id);
  }
  return sendJSON(res, 200, { project: db.getProject(session.user_id, id) });
}

function handleDeleteProject(req, res, id) {
  const session = requireUser(req);
  const project = db.getProject(session.user_id, id);
  if (!project) fail(404, 'Project not found.');

  // Phase 2: project deletion archives assets; source files remain recoverable.
  assetStore.archiveProject(session.user_id, id);
  if (!db.deleteProject(session.user_id, id)) fail(404, 'Project not found.');

  return sendJSON(res, 200, { ok: true });
}

async function handleImportProjects(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  if (!Array.isArray(body.projects)) fail(400, '`projects` must be an array.');

  const imported = db.importProjects(session.user_id, body.projects.slice(0, 500));
  for (const project of db.listProjects(session.user_id)) {
    storyStore.ensureProject(project.id);
  }
  return sendJSON(res, 200, { imported });
}

// ---------------------------------------------------------------------------
// DeepSeek generation (the stored key never leaves the server)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are an expert idea generator and innovation consultant.',
  'Based on the context the user provides, generate the exact number of ideas they requested.',
  'Each idea must be original, specific, and actionable.',
  'Respond with ONLY a valid JSON array of objects. Each object must have exactly two string fields:',
  '"title" (a concise, compelling headline) and "description" (one to two sentences of detail).',
  'Do not include any text before or after the JSON array. Do not wrap it in a code fence.',
].join(' ');

const WORKSPACE_RULES = [
  '"brief" must contain non-empty "title", "logline", "premise", "tone", "genre", "audience", and "setting" strings.',
  '"characters" must be an array with exactly one object per supplied character, in the same order, using the exact supplied name and gender, each with non-empty "name", "gender", "age", "appearance", "wardrobe", and "continuityNotes". Give every adult character an explicit age; never silently change a supplied value.',
  '"locations" must be an array of at least one object, each with non-empty "name", "description", "lighting", and "continuityNotes".',
  '"styles" must be an array of at least one object with non-empty "name", "description", and "guidance", plus an "exclusions" array of strings. Provide photorealistic, grounded style guidance plus useful negative exclusions.',
  '"scenes" must be an array of 6 to 10 chronological scene objects, each with non-empty "title", "beat", "action", and "location", a non-empty "characters" array, and a "props" string listing recurring props. Scene "location" and "characters" values must exactly match names from "locations" and "characters".',
  'Give each character one unambiguous canonical description for identity, hair, wardrobe, and recurring props; never offer alternatives like "tan or denim overalls". Separate immutable traits from gradual or scene-dependent changes.',
  'Write concrete scene beats and props, not blank placeholders. State only factual continuity rules; do not invent unsupported traits.',
  'Do not include any approval, publication, or review fields, and do not claim that anything has been reviewed.',
];

const REFERENCE_SYSTEM_PROMPT = [
  'You are an expert story developer and photorealistic visual-continuity planner.',
  'Build reference material for realistic, casual, everyday scenarios; avoid unnecessary fantasy or spectacle.',
  'Keep character appearances, clothing, locations, lighting, and recurring props visually consistent across every scene.',
  'Return ONLY a valid JSON object (no code fences, no commentary) with exactly four top-level fields: "referenceMaterial", "storyWorkspace", "scenes", and "characterReferences".',
  '"referenceMaterial" must be plain text containing these seven numbered sections in this exact order:',
  '1. Story Overview - premise, tone, and central scenario.',
  '2. Characters - for every character: name, age, gender, height, build, body proportions, facial features, hairstyle, clothing, occupation, and personality.',
  '3. Relationships - character dynamics and motivations.',
  '4. Setting - environment, layout, lighting, and recurring props.',
  '5. Story Progression - 6 to 10 chronological scenes. For each scene give a title, action, location, and characters present.',
  '6. Visual Continuity - consistent character appearances, clothing, locations, and props.',
  '7. Additional Notes - relevant restrictions and details.',
  '"storyWorkspace" must be a structured object with exactly five fields: "brief", "characters", "locations", "styles", and "scenes".',
  ...WORKSPACE_RULES,
  '"scenes" (top level) must describe the same scenes as "storyWorkspace.scenes", as an array of 6 to 10 objects each with "title", "action", "location", and "characters" (an array of character names).',
  '"characterReferences" must be an array with exactly one object per supplied character, in the same order, each with "name", "gender", and a detailed standalone "referenceMaterial" description of that character\'s appearance, clothing, and visual continuity for image generation.',
  'The scenes array must match the Story Progression section. Return valid JSON only; do not wrap it in a code fence or add text outside the JSON.',
].join(' ');

const WORKSPACE_SYSTEM_PROMPT = [
  'You are an expert story developer and photorealistic visual-continuity planner.',
  'From the provided reference material, produce a complete, structured story workspace.',
  'Return ONLY a valid JSON object (no code fences, no commentary) with exactly five fields: "brief", "characters", "locations", "styles", and "scenes".',
  ...WORKSPACE_RULES,
  'Use only the supplied characters, in the supplied order, with their exact names and genders. Return valid JSON only.',
].join(' ');

const GENERATION_SYSTEM_RULES = [
  'You are an expert photorealistic image-prompt writer and visual continuity supervisor.',
  'For each scene, write one detailed image-generation prompt suitable for a photorealistic render.',
  'Each prompt must specify the characters present and their appearance, clothing, action, environment, lighting, and camera framing or lens.',
  'Keep appearances, wardrobe, locations, and props consistent with the reference material.',
  'Prefer realistic, casual, everyday moments and photographic realism.',
  'Do not use code fences, numbering, or commentary outside the JSON.',
].join(' ');
const GENERATION_BUILD_SYSTEM_PROMPT = [
  GENERATION_SYSTEM_RULES,
  'Write one production-ready image prompt per action reference, in the same order.',
  'The same character references and character reference sheets apply to every image, so repeat the exact canonical wording for a character every time that character appears.',
  'Use only the supplied references: never invent characters, wardrobe, props, or locations, and never describe text, logos, or watermarks.',
  'Return ONLY valid JSON in the form {"prompts": ["prompt for image 1", "prompt for image 2", ...]} with exactly one prompt per action reference.',
].join(' ');

const GENERATION_REVIEW_SYSTEM_PROMPT = [
  'You are a meticulous visual-continuity reviewer inside the Carnival project app.',
  'Compare every image prompt against the supplied character references, character reference sheets, action references, and location references.',
  'Report only concrete inconsistencies: a character described differently from their reference, the wrong or missing wardrobe, an action that contradicts its action reference, a location that contradicts its location reference or is missing, characters that are missing or added, or details that break continuity between images.',
  'Return ONLY valid JSON in the form {"flags":[{"promptId":"<image prompt id>","severity":"error"|"warning"|"info","message":"the specific inconsistency"}]}.',
  'Copy each promptId exactly as supplied. Return an empty flags array when every prompt agrees with the references.',
  'Never invent facts that are not in the supplied content, and never claim that a human reviewed or approved anything.',
].join(' ');

const CHAT_SYSTEM_PROMPTS = {
  guide: [
    'You are a concise workflow guide inside the Carnival project app.',
    'Guide the user step by step through the workflow: Idea → Reference Stage → Story Workspace → Generation Stage → Review → Done.',
    'Use the provided project context. Tell the user the next concrete action, and answer their questions directly.',
    'Never claim that any content has been reviewed, approved, or published.',
  ].join(' '),
  reviewer: [
    'You are a review assistant inside the Carnival project app.',
    'Review the provided project content (reference material, story brief, characters, locations, style, scenes, and prompts) for continuity, completeness, consistency, and quality.',
    'Point out concrete gaps, contradictions, and missing approvals with specific examples.',
    'Never claim that content has been approved or published; approval is a separate human action.',
  ].join(' '),
};

const REVIEW_BOXES = new Map([
  ['scene-prompts', {
    label: 'Scene Prompts',
    criteria: 'Every scene prompt must be self-contained and name the characters present, their appearance and wardrobe, the action, environment, lighting, and camera framing. It must agree with the supplied story reference, continuity summaries, and scene outline, and must be specific enough to generate a consistent photorealistic image.',
  }],
  ['scene-outline', {
    label: 'Scene Outline',
    criteria: 'Every scene must have a clear title, action, location, and characters. Scenes must form a coherent chronological story, use only established characters and locations, and contain enough concrete detail to support a prompt.',
  }],
  ['story-brief', {
    label: 'Story Brief',
    criteria: 'Every brief field must be specific and non-empty. The logline, premise, tone, genre, audience, and setting must be consistent with each other and with the reference material, without vague placeholders or contradictions.',
  }],
  ['characters', {
    label: 'Character Bibles',
    criteria: 'Each character bible must define identity, age, gender, appearance, wardrobe, personality, and continuity notes without alternatives or contradictions. Approved status is recorded separately and must not be invented.',
  }],
  ['locations', {
    label: 'Locations',
    criteria: 'Each location must define a concrete, visually usable setting with layout, lighting, and recurring props. It must not contradict the reference material or the scenes that use it.',
  }],
  ['styles', {
    label: 'Style References',
    criteria: 'Each style must define a clear photorealistic visual direction, usable guidance, and negative exclusions. Guidance must be consistent with the story and across all scenes.',
  }],
  ['reference-material', {
    label: 'Reference Material',
    criteria: 'The reference material must cover the story overview, characters, relationships, setting, progression, visual continuity, and additional notes. It must be internally consistent and contain no placeholders or contradictions.',
  }],
  ['project-details', {
    label: 'Project Details',
    criteria: 'The project title, idea, and description must be specific, coherent, and consistent with the saved reference material.',
  }],
]);

const REVIEW_BATCH_SYSTEM_PROMPT = [
  'You are a meticulous content reviewer inside the Carnival project app.',
  'You review a batch of fields from one section, using the supplied project context to judge completeness, internal consistency, continuity, and fitness for image generation.',
  'Return ONLY valid JSON with this exact shape:',
  '{"reviews":[{"id":"<field id>","verdict":"pass"|"fail","summary":"one or two sentences","findings":[{"severity":"error"|"warning"|"info","message":"specific issue"}],"suggestions":["specific improvement"]}, ...]}',
  'Return exactly one entry per supplied field id, in the same order. Copy each field id exactly as supplied.',
  'Use "pass" only when a field is complete and consistent enough to use as-is. Use "fail" when it needs a correction.',
  'Treat approval and publication status as out of scope: never fail a field only because a linked character, location, or style is unapproved.',
  'Be concrete and concise. Do not invent facts that are not in the supplied content.',
  'Review each field independently against the shared context. Other fields in the batch are not authoritative references. Context excerpts can omit details; state gaps rather than claiming to have checked omitted material.',
  'Never claim that anything was reviewed, approved, or published by a human; this is an automated check, not an approval.',
].join(' ');

const REVIEW_CONTEXT_MAX_CHARS = 24000;
const REVIEW_FIELD_MAX_CHARS = 16000;
const REVIEW_BATCH_MAX_CHARS = 40000;
const REVIEW_BATCH_MAX_FIELDS = 8;
const reviewsInFlight = new Map();

const CHARACTER_SHEET_TEMPLATE = 'Use the same character-sheet layout for every character: one wide canvas with exactly three evenly spaced, equal-size, full-body standing poses in a single horizontal row, ordered left to right as front view, three-quarter view, and side profile. Show head to toe in every pose at the same scale, with consistent margins and clear space between poses; no cropping or overlapping. Use a seamless light gray studio background and the same soft, even lighting throughout. Treat the attached reference image only as a guide to the three-view composition, pose order, spacing, and background; replace its generic mannequin with the requested character and canonical wardrobe, and do not copy the mannequin or its outfit. Keep the character identity, appearance, canonical outfit, and distinguishing details identical across all three views. Character-specific visual guidance may affect the character, but must not change this background, framing, pose count, pose order, or spacing.';

function buildCharacterSheetPrompt(character, reference) {
  const parts = [];
  parts.push(`Photorealistic full-body character reference sheet of ${character.name}.`);
  parts.push(`Character reference: ${reference}`);
  parts.push(CHARACTER_SHEET_TEMPLATE, 'Photographic realism.');
  parts.push('Avoid: text, watermark, extra limbs, distorted face.');
  return parts.join('\n').slice(0, 30000);
}

// Single-image alternative for the Character maker tab. No layout reference is
// attached: this is one portrait, not the three-view sheet.
function buildCharacterPortraitPrompt(character, reference) {
  const parts = [];
  parts.push(`Photorealistic single-subject character reference portrait of ${character.name}.`);
  parts.push(`Character reference: ${reference}`);
  parts.push('Exactly one person, framed from the head to about mid-thigh, standing and facing the camera, relaxed neutral expression, looking at the lens.');
  parts.push('Seamless light gray studio background, soft even lighting, sharp focus on the face, natural skin texture, realistic fabric detail.');
  parts.push('Photographic realism, casting-photo framing.');
  parts.push('Avoid: text, watermark, extra limbs, duplicate people, distorted face, cartoon or illustration style.');
  return parts.join('\n').slice(0, 30000);
}

function buildChatContext(userId, project) {
  const lines = [
    `Title: ${project.title}`,
    `Stage: ${project.stage} · Status: ${project.status} · Priority: ${project.priority}`,
  ];
  if (project.idea) lines.push(`Idea: ${project.idea}`);
  if (project.description) lines.push(`Description: ${project.description}`);
  if (project.referenceMaterial) lines.push(`Reference material:\n${String(project.referenceMaterial).slice(0, 12000)}`);
  const characters = Array.isArray(project.characterReferences) ? project.characterReferences : [];
  if (characters.length) {
    lines.push(`Character references: ${characters.map((item) => `${item.name || '?'} (${item.gender || ''})`).join(', ')}`);
  }
  if (Array.isArray(project.scenes) && project.scenes.length) lines.push(`Scenes: ${project.scenes.length}`);
  if (Array.isArray(project.generationPrompts) && project.generationPrompts.length) {
    lines.push(`Generation prompts: ${project.generationPrompts.length}`);
  }
  if (Array.isArray(project.sceneImages) && project.sceneImages.length) {
    lines.push(`Images: ${project.sceneImages.length}`);
  }

  const story = storyStore.getStory(userId, project.id);
  if (story) {
    if (story.brief) {
      const summary = [story.brief.logline, story.brief.tone, story.brief.genre, story.brief.audience]
        .filter(Boolean)
        .join(' · ');
      if (summary) lines.push(`Story brief: ${summary}`);
    }
    if (story.characters && story.characters.length) {
      lines.push(`Characters: ${story.characters.map((item) => `${item.name}${item.approved ? '' : ' (unapproved)'}`).join(', ')}`);
    }
    if (story.locations && story.locations.length) {
      lines.push(`Locations: ${story.locations.map((item) => item.name).join(', ')}`);
    }
    if (story.styles && story.styles.length) {
      lines.push(`Style: ${story.styles.map((item) => item.name).join(', ')}`);
    }
    if (story.warnings && story.warnings.length) {
      lines.push(`Continuity warnings (${story.warnings.length}): ${story.warnings.slice(0, 15).map((item) => item.message).join(' | ')}`);
    }
  }
  return lines.join('\n').slice(0, 30000);
}

// ---------------------------------------------------------------------------
// Reviewer bot: bounded batches with persistent results for unchanged inputs
// ---------------------------------------------------------------------------

function reviewValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => reviewValue(item)).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).trim();
}

function reviewRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  const skip = new Set([
    'id', 'projectId', 'sceneId', 'characterId', 'locationId', 'styleId',
    'approved', 'approvedAt', 'createdAt', 'updatedAt', 'version', 'source',
  ]);
  return Object.entries(record)
    .filter(([key, value]) => !skip.has(key) && reviewValue(value))
    .map(([key, value]) => `${humanizeReferenceKey(key)}: ${reviewValue(value)}`)
    .join('\n');
}

function reviewerFieldsFor(userId, project, boxId) {
  const box = REVIEW_BOXES.get(boxId);
  if (!box) return null;

  const story = storyStore.getStory(userId, project.id) || {};
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const fields = [];
  const add = (id, label, content) => {
    fields.push({ id, label, content: String(content || '') });
  };

  if (boxId === 'scene-prompts') {
    const prompts = new Map(
      (Array.isArray(project.generationPrompts) ? project.generationPrompts : [])
        .map((item) => [item.sceneId, item])
    );
    scenes.forEach((scene, index) => {
      const entry = prompts.get(scene.id);
      add(
        `scene-prompt:${scene.id}`,
        `Scene ${index + 1} · ${scene.title || 'Untitled'}`,
        entry ? entry.prompt : ''
      );
    });
  } else if (boxId === 'scene-outline') {
    scenes.forEach((scene, index) => {
      add(
        `scene:${scene.id}`,
        `Scene ${index + 1} · ${scene.title || 'Untitled'}`,
        reviewRecordText({
          title: scene.title,
          beat: scene.beat,
          action: scene.action,
          location: scene.location,
          characters: scene.characters,
          props: scene.props,
          order: scene.order,
        })
      );
    });
  } else if (boxId === 'story-brief') {
    const brief = story.brief || {};
    [
      ['title', 'Story title'],
      ['logline', 'Logline'],
      ['premise', 'Premise'],
      ['tone', 'Tone'],
      ['genre', 'Genre'],
      ['audience', 'Audience'],
      ['setting', 'Setting summary'],
    ].forEach(([key, label]) => add(`brief:${key}`, label, brief[key] || ''));
  } else if (boxId === 'characters') {
    (story.characters || []).forEach((character, index) => {
      add(
        `character:${character.id}`,
        character.name || `Character ${index + 1}`,
        reviewRecordText(character)
      );
    });
  } else if (boxId === 'locations') {
    (story.locations || []).forEach((location, index) => {
      add(
        `location:${location.id}`,
        location.name || `Location ${index + 1}`,
        reviewRecordText(location)
      );
    });
  } else if (boxId === 'styles') {
    (story.styles || []).forEach((style, index) => {
      add(
        `style:${style.id}`,
        style.name || `Style ${index + 1}`,
        reviewRecordText(style)
      );
    });
  } else if (boxId === 'reference-material') {
    add('reference-material', 'Reference Material', project.referenceMaterial || '');
  } else if (boxId === 'project-details') {
    add('project:title', 'Project title', project.title || '');
    add('project:idea', 'Idea', project.idea || '');
    add('project:description', 'Description', project.description || '');
  }

  return fields.slice(0, 60);
}

function buildReviewerContext(project, story, boxId) {
  const excerpt = (value, limit) => {
    const text = reviewValue(value);
    return text.length > limit ? `${text.slice(0, limit)} [excerpt]` : text;
  };
  const summary = (record, keys, limit) => excerpt(Object.fromEntries(
    keys.filter((key) => reviewValue(record[key])).map((key) => [key, record[key]])
  ), limit);
  const lines = [
    `Project title: ${project.title}`,
  ];
  if (project.idea) lines.push(`Idea:\n${excerpt(project.idea, 1000)}`);
  if (project.description) lines.push(`Description:\n${excerpt(project.description, 1500)}`);
  if (project.referenceMaterial && boxId !== 'reference-material') {
    lines.push(`Reference material excerpt:\n${excerpt(project.referenceMaterial, 4000)}`);
  }

  if (story.brief) {
    lines.push(`Story brief:\n${excerpt(reviewRecordText(story.brief), 2500)}`);
  }
  const sceneReview = boxId === 'scene-prompts' || boxId === 'scene-outline';
  if (sceneReview && Array.isArray(story.characters) && story.characters.length) {
    lines.push(`Character continuity summaries:\n${excerpt(story.characters.map((character) => (
      summary(character, ['name', 'age', 'gender', 'appearance', 'wardrobe', 'continuityNotes'], 700)
    )).join('\n'), 4000)}`);
  }
  if (sceneReview && Array.isArray(story.locations) && story.locations.length) {
    lines.push(`Location summaries:\n${excerpt(story.locations.map((location) => (
      summary(location, ['name', 'description', 'layout', 'lighting', 'props'], 400)
    )).join('\n'), 1800)}`);
  }
  if (sceneReview && Array.isArray(story.styles) && story.styles.length) {
    lines.push(`Style summaries:\n${excerpt(story.styles.map((style) => (
      summary(style, ['name', 'description', 'guidance', 'exclusions'], 500)
    )).join('\n'), 1800)}`);
  }

  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  if ((sceneReview || boxId === 'locations') && scenes.length) {
    lines.push(`Scene order:\n${excerpt(scenes.map((scene, index) => (
      `Scene ${index + 1}: ${summary(scene, ['title', 'location', 'characters', 'action'], 350)}`
    )).join('\n'), 4000)}`);
  }

  return lines.join('\n\n').slice(0, REVIEW_CONTEXT_MAX_CHARS);
}

function normalizeReviewFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (typeof item === 'string') {
      return { severity: 'warning', message: item.trim().slice(0, 2000) };
    }
    if (!item || typeof item !== 'object') return null;
    const message = reviewValue(item.message || item.issue || item.detail || item.text).slice(0, 2000);
    if (!message) return null;
    const rawSeverity = reviewValue(item.severity || item.level).toLowerCase();
    const severity = ['error', 'warning', 'info'].includes(rawSeverity) ? rawSeverity : 'warning';
    return { severity, message };
  }).filter(Boolean);
}

function normalizeReviewSuggestions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : reviewValue(item && (item.message || item.text))))
    .map((item) => item.trim().slice(0, 2000))
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeReviewEntry(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      status: 'failed',
      summary: 'The reviewer returned an unreadable result. Try the review again.',
      findings: [{ severity: 'error', message: 'The AI response was not valid JSON.' }],
      suggestions: [],
    };
  }

  const findings = normalizeReviewFindings(data.findings || data.issues || data.problems);
  const suggestions = normalizeReviewSuggestions(data.suggestions || data.recommendations);
  const rawVerdict = reviewValue(data.verdict || data.status || data.result).toLowerCase();
  let verdict = null;
  if (['pass', 'passed', 'ok', 'approved', 'reviewed'].includes(rawVerdict)) verdict = 'pass';
  else if (['fail', 'failed', 'reject', 'rejected', 'revise', 'needs-work', 'needs_work'].includes(rawVerdict)) verdict = 'fail';
  else if (typeof data.passed === 'boolean') verdict = data.passed ? 'pass' : 'fail';

  let summary = reviewValue(data.summary || data.reason || data.detail || data.notes).slice(0, 2000);
  if (!verdict) {
    return {
      status: 'failed',
      summary: summary || 'The reviewer did not return a clear verdict. Try the review again.',
      findings: findings.length
        ? findings
        : [{ severity: 'error', message: 'No pass/fail verdict was returned.' }],
      suggestions,
    };
  }

  if (verdict === 'pass' && findings.some((finding) => finding.severity === 'error')) {
    verdict = 'fail';
  }
  if (!summary) summary = verdict === 'pass' ? 'No blocking issues found.' : 'This field needs changes.';
  return {
    status: verdict === 'pass' ? 'reviewed' : 'failed',
    summary,
    findings,
    suggestions,
  };
}

function parseFieldReviewBatchResult(text, fields) {
  const data = parseJsonPayload(text);
  const list = data && Array.isArray(data.reviews)
    ? data.reviews
    : Array.isArray(data)
      ? data
      : null;

  const invalid = () => fail(502, 'The reviewer returned incomplete or invalid results. Try again.', 'INVALID_REVIEW_RESPONSE');
  if (!list || list.length !== fields.length) invalid();
  const expected = new Set(fields.map((field) => field.id));
  const byId = new Map();
  const verdicts = new Set(['pass', 'passed', 'ok', 'approved', 'reviewed', 'fail', 'failed', 'reject', 'rejected', 'revise', 'needs-work', 'needs_work']);
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const id = reviewValue(item.id || item.fieldId);
    if (!expected.has(id) || byId.has(id)) invalid();
    if (!verdicts.has(reviewValue(item.verdict || item.status || item.result).toLowerCase())
      && typeof item.passed !== 'boolean') invalid();
    byId.set(id, normalizeReviewEntry(item));
  }
  return fields.map((field) => ({ id: field.id, ...byId.get(field.id) }));
}

function reviewContextFingerprint(project, story, boxId) {
  const sceneReview = boxId === 'scene-prompts' || boxId === 'scene-outline';
  // Hash full relevant sources locally even when the model sees only an excerpt.
  return crypto.createHash('sha256').update(JSON.stringify({
    title: project.title, idea: project.idea, description: project.description,
    referenceMaterial: project.referenceMaterial, brief: reviewRecordText(story.brief),
    characters: sceneReview ? (story.characters || []).map(reviewRecordText) : [],
    locations: sceneReview ? (story.locations || []).map(reviewRecordText) : [],
    styles: sceneReview ? (story.styles || []).map(reviewRecordText) : [],
    scenes: sceneReview || boxId === 'locations' ? (project.scenes || []).map(reviewRecordText) : [],
  })).digest('hex');
}

function reviewFieldContentHash(field, target, context, box, contextFingerprint) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 2, id: field.id, label: field.label, content: field.content,
    provider: target.provider, endpoint: target.endpoint, model: target.model,
    instructions: target.configuredContext, system: REVIEW_BATCH_SYSTEM_PROMPT,
    criteria: box.criteria, context, contextFingerprint,
  })).digest('hex');
}

function chunkReviewFields(fields, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const field of fields) {
    const content = String(field.content || '').slice(0, REVIEW_FIELD_MAX_CHARS);
    if (current.length && (size + content.length > maxChars || current.length >= REVIEW_BATCH_MAX_FIELDS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ ...field, content });
    size += content.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function reviewFieldsBatch(target, context, box, fields, telemetry) {
  const fieldsBlock = fields.map((field) => (
    `Field id: ${field.id}\nField label: ${field.label}\nField content:\n"""\n${field.content}\n"""`
  )).join('\n\n---\n\n');

  const userContent = [
    `Project context:\n${context}`,
    `Section: ${box.label}`,
    `Review criteria:\n${box.criteria}`,
    `Fields to review (${fields.length}):\n\n${fieldsBlock}`,
    'Return a JSON object with a "reviews" array containing exactly one entry per field id, in the same order.',
  ].join('\n\n');

  const result = await callChatUpstream({
    ...target,
    system: [
      REVIEW_BATCH_SYSTEM_PROMPT,
      ...(target.configuredContext ? [target.configuredContext] : []),
    ].join('\n\n'),
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.2,
    maxTokens: Math.min(8000, 300 + fields.length * 1000),
    telemetry,
  });

  return parseFieldReviewBatchResult(result.content, fields).map((review) => ({
    ...review,
    model: result.model,
  }));
}

function resolveChatTarget(user, mode, requireKey = true) {
  const reviewer = mode === 'reviewer';
  const provider = CHAT_PROVIDERS.has(reviewer ? user.reviewer_provider : user.guide_provider)
    ? (reviewer ? user.reviewer_provider : user.guide_provider)
    : 'deepseek';
  const configuredModel = (reviewer ? user.reviewer_model : user.guide_model) || '';
  const configuredContext = (reviewer ? user.reviewer_context : user.guide_context) || '';

  let apiKey = null;
  let endpoint = DEEPSEEK_ENDPOINT;
  let model = configuredModel.trim();
  if (provider === 'anthropic') {
    if (requireKey && !user.anthropic_api_key_enc) {
      fail(409, 'No Anthropic API key is saved for your account. Add one in Settings.', 'NO_ANTHROPIC_KEY');
    }
    if (requireKey) apiKey = security.decryptApiKey(user.anthropic_api_key_enc);
    endpoint = ANTHROPIC_ENDPOINT;
    if (!model) model = ANTHROPIC_DEFAULT_MODEL;
  } else if (provider === 'openai') {
    if (requireKey && !user.openai_api_key_enc) {
      fail(409, 'No OpenAI-compatible API key is saved for your account. Add one in Settings.', 'NO_OPENAI_KEY');
    }
    if (requireKey) apiKey = security.decryptApiKey(user.openai_api_key_enc);
    const baseUrl = (user.openai_base_url || '').trim() || OPENAI_DEFAULT_BASE_URL;
    endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    if (!model) model = OPENAI_DEFAULT_MODEL;
  } else {
    if (requireKey && !user.api_key_enc) {
      fail(409, 'No DeepSeek API key is saved for your account. Add one in Settings.', 'NO_API_KEY');
    }
    if (requireKey) apiKey = security.decryptApiKey(user.api_key_enc);
    if (!model) model = DEFAULT_TEXT_MODEL;
  }

  if (requireKey && !apiKey) {
    fail(500, 'Your saved API key could not be read. Please save it again.', 'KEY_UNREADABLE');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');
  return { provider, endpoint, apiKey, model, configuredContext };
}

function handleReviewerFields(req, res, url) {
  const session = requireUser(req);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const boxId = String(url.searchParams.get('box') || '').trim();
  const project = projectId ? db.getProject(session.user_id, projectId) : null;
  if (!project) fail(404, 'Project not found.');
  const box = REVIEW_BOXES.get(boxId);
  if (!box) fail(400, 'Unknown review section.');
  const fields = reviewerFieldsFor(session.user_id, project, boxId);
  const user = db.getUserById(session.user_id);
  const target = resolveChatTarget(user, 'reviewer', false);
  const story = storyStore.getStory(session.user_id, project.id) || {};
  const context = buildReviewerContext(project, story, boxId);
  const contextFingerprint = reviewContextFingerprint(project, story, boxId);
  const cached = fieldReviewStore.listFor(session.user_id, project.id, boxId);
  return sendJSON(res, 200, {
    project: {
      id: project.id,
      title: project.title,
      stage: project.stage,
      status: project.status,
    },
    box: { id: boxId, label: box.label },
    fields: fields.map((field) => {
      const contentHash = reviewFieldContentHash(field, target, context, box, contextFingerprint);
      return {
        id: field.id,
        label: field.label,
        hasContent: Boolean(field.content.trim()),
        contentHash,
        review: cached.get(`${field.id}|${contentHash}`) || null,
      };
    }),
  });
}

async function handleReviewerReview(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const projectId = String(body.projectId || '').trim();
  const boxId = String(body.box || '').trim();
  const project = projectId ? db.getProject(session.user_id, projectId) : null;
  if (!project) fail(404, 'Project not found.');
  const box = REVIEW_BOXES.get(boxId);
  if (!box) fail(400, 'Unknown review section.');

  const fields = reviewerFieldsFor(session.user_id, project, boxId);
  const user = db.getUserById(session.user_id);
  if (!user) fail(401, 'Please sign in.');
  const target = resolveChatTarget(user, 'reviewer', false);
  const story = storyStore.getStory(session.user_id, project.id) || {};
  const context = buildReviewerContext(project, story, boxId);
  const contextFingerprint = reviewContextFingerprint(project, story, boxId);
  const snapshot = fields.map((field) => ({ ...field, contentHash: reviewFieldContentHash(field, target, context, box, contextFingerprint) }));
  const key = JSON.stringify([session.user_id, project.id, boxId, snapshot.map((field) => field.contentHash)]);
  let pending = reviewsInFlight.get(key);
  if (!pending) {
    pending = Promise.resolve().then(() => reviewSnapshot(session, project, boxId, box, snapshot, context, body.force === true, user));
    reviewsInFlight.set(key, pending);
  }
  try {
    return sendJSON(res, 200, await pending);
  } finally {
    if (reviewsInFlight.get(key) === pending) reviewsInFlight.delete(key);
  }
}

async function reviewSnapshot(session, project, boxId, box, fields, context, force, user) {
  const reviewedAt = new Date().toISOString();
  const results = new Map();
  const toReview = [];

  for (const field of fields) {
    const contentHash = field.contentHash;
    if (!field.content.trim()) {
      results.set(field.id, {
        id: field.id,
        label: field.label,
        status: 'failed',
        summary: 'This field is empty. Add content before reviewing it.',
        findings: [{ severity: 'error', message: 'No content was found in this field.' }],
        suggestions: ['Fill in this field, then run the review again.'],
        model: null,
        reviewedAt,
      });
      continue;
    }
    if (field.content.length > REVIEW_FIELD_MAX_CHARS) {
      results.set(field.id, {
        id: field.id, label: field.label, status: 'failed',
        summary: `This field exceeds the ${REVIEW_FIELD_MAX_CHARS}-character review limit. Shorten or split it before reviewing.`,
        findings: [], suggestions: [], model: null, reviewedAt,
      });
      continue;
    }
    const cached = !force && fieldReviewStore.get(session.user_id, project.id, boxId, field.id, contentHash);
    if (cached) {
      results.set(field.id, { id: field.id, label: field.label, ...cached, cached: true });
      continue;
    }
    toReview.push({ ...field, contentHash });
  }

  if (toReview.length) {
    const target = resolveChatTarget(user, 'reviewer');
    for (const chunk of chunkReviewFields(toReview, REVIEW_BATCH_MAX_CHARS)) {
      const aiResults = await reviewFieldsBatch(target, context, box, chunk, {
        userId: session.user_id, projectId: project.id, operation: 'field-review',
      });
      for (const review of aiResults) {
        const field = fields.find((item) => item.id === review.id);
        const stored = fieldReviewStore.save(session.user_id, project.id, boxId, {
          id: review.id,
          contentHash: field.contentHash,
          status: review.status,
          summary: review.summary,
          findings: review.findings,
          suggestions: review.suggestions,
          model: review.model,
          reviewedAt,
        });
        results.set(review.id, {
          id: review.id,
          label: field ? field.label : review.id,
          ...stored,
        });
      }
    }
  }

  return {
    reviews: fields.map((field) => (
      results.get(field.id) || {
        id: field.id,
        label: field.label,
        status: 'failed',
        summary: 'The reviewer returned no result for this field.',
        findings: [{ severity: 'error', message: 'No result was returned for this field.' }],
        suggestions: [],
        model: null,
        reviewedAt,
      }
    )),
  };
}

function stripFences(text) {
  let out = text.trim();
  out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  return out.trim();
}

function extractIdeasFromValue(value) {
  let arr = value;
  if (!Array.isArray(value)) {
    if (value && Array.isArray(value.ideas)) arr = value.ideas;
    else if (value && Array.isArray(value.results)) arr = value.results;
    else if (value && Array.isArray(value.ideasList)) arr = value.ideasList;
    else return [];
  }

  const ideas = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const title = item.trim();
      if (title) ideas.push({ title, description: '' });
    } else if (item && typeof item === 'object') {
      const title = (item.title || item.name || item.idea || item.headline || item.text || '').toString().trim();
      const description = (item.description || item.detail || item.details || item.summary || '').toString().trim();
      if (title) ideas.push({ title, description });
    }
  }
  return ideas;
}

function parseNumberedList(text) {
  const ideas = [];
  const re = /^\s*(?:\d+[\.\)]|[-*•–])\s*(.+?)\s*$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(re);
    if (m && m[1]) {
      ideas.push({ title: m[1].trim(), description: '' });
    }
  }
  return ideas;
}

function parseIdeas(text) {
  const cleaned = stripFences(text);

  try {
    const ideas = extractIdeasFromValue(JSON.parse(cleaned));
    if (ideas.length) return ideas;
  } catch (_) { /* continue */ }

  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const ideas = extractIdeasFromValue(JSON.parse(arrMatch[0]));
      if (ideas.length) return ideas;
    } catch (_) { /* continue */ }
  }

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const ideas = extractIdeasFromValue(JSON.parse(objMatch[0]));
      if (ideas.length) return ideas;
    } catch (_) { /* continue */ }
  }

  const list = parseNumberedList(cleaned);
  if (list.length) return list;

  return cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((title) => ({ title, description: '' }));
}

function normalizeMessageContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

function parseJsonPayload(text) {
  const cleaned = stripFences(String(text || ''));
  try {
    return JSON.parse(cleaned);
  } catch (_) { /* continue */ }

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) { /* continue */ }
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) { /* continue */ }
  }

  return null;
}

function humanizeReferenceKey(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function referenceValueToText(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (depth > 4) return '';

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (depth < 2 && /^[\[{]/.test(trimmed)) {
      try {
        return referenceValueToText(JSON.parse(trimmed), depth + 1);
      } catch (_) { /* keep the string as-is */ }
    }
    return trimmed;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        const text = referenceValueToText(item, depth + 1);
        if (!text) return '';
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const heading = item.title || item.heading || item.section || item.name;
          if (heading && !text.toLowerCase().includes(String(heading).toLowerCase())) {
            return `${index + 1}. ${heading}\n${text}`;
          }
        }
        return text;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  if (typeof value === 'object') {
    for (const key of ['referenceMaterial', 'reference_material', 'reference', 'material', 'text', 'content']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const nested = referenceValueToText(value[key], depth + 1);
        if (nested) return nested;
      }
    }

    return Object.entries(value)
      .map(([key, item], index) => {
        const text = referenceValueToText(item, depth + 1);
        if (!text) return '';
        const heading = humanizeReferenceKey(key);
        const prefix = /^\d+[\.\)]/.test(heading) ? heading : `${index + 1}. ${heading}`;
        return `${prefix}\n${text}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  return '';
}

function unpackReferencePayload(value) {
  let data = value;

  if (Array.isArray(data) && data.length) data = data[0];
  if (typeof data === 'string') {
    data = { referenceMaterial: data };
  }
  if (!data || typeof data !== 'object') {
    return { data, referenceMaterial: '', scenes: [], characterReferences: [] };
  }

  for (const key of ['data', 'result', 'output', 'response']) {
    if (
      data[key] &&
      typeof data[key] === 'object' &&
      !Array.isArray(data[key]) &&
      data.referenceMaterial === undefined &&
      data.reference_material === undefined
    ) {
      data = data[key];
    }
  }

  const referenceCandidates = [
    data.referenceMaterial,
    data.reference_material,
    data.reference,
    data.material,
    data.text,
    data.content,
  ];
  let referenceMaterial = '';
  for (const candidate of referenceCandidates) {
    const text = referenceValueToText(candidate).trim();
    if (text) {
      referenceMaterial = text;
      break;
    }
  }

  const sceneCandidates = [
    data.scenes,
    data.sceneOutline,
    data.scene_outline,
    data.outline,
    data.storyProgression,
  ];
  let scenes = [];
  for (const candidate of sceneCandidates) {
    scenes = normalizeSceneList(candidate, 10);
    if (scenes.length) break;
  }

  const characterCandidates = [
    data.characterReferences,
    data.character_references,
    data.characters,
  ];
  let characterReferences = [];
  for (const candidate of characterCandidates) {
    if (Array.isArray(candidate) && candidate.length) {
      characterReferences = candidate;
      break;
    }
  }

  const workspaceCandidates = [
    data.storyWorkspace,
    data.story_workspace,
    data.workspace,
    data.structuredWorkspace,
  ];
  let storyWorkspace = null;
  for (const candidate of workspaceCandidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      storyWorkspace = candidate;
      break;
    }
  }

  return {
    data,
    referenceMaterial,
    scenes,
    characterReferences,
    storyWorkspace,
  };
}

async function callDeepSeek(apiKey, requestBody) {
  let upstream;
  try {
    upstream = await requestTracker.fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120000),
    }, { provider: 'deepseek' });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      fail(504, 'DeepSeek did not respond in time. Try again.', 'UPSTREAM_TIMEOUT');
    }
    fail(502, `Could not reach the DeepSeek API: ${err.message}`, 'UPSTREAM_UNREACHABLE');
  }

  const upstreamText = await upstream.text();

  if (!upstream.ok) {
    let detail = upstreamText;
    try {
      const j = JSON.parse(upstreamText);
      detail = (j.error && (j.error.message || j.error.code)) || upstreamText;
    } catch (_) { /* keep raw text */ }
    detail = String(detail).slice(0, 500);

    if (upstream.status === 401) {
      fail(502, 'Your saved DeepSeek API key was rejected (401). Update it in Settings.', 'INVALID_API_KEY');
    }
    if (upstream.status === 402) {
      fail(502, 'Your DeepSeek balance is insufficient (402).', 'INSUFFICIENT_BALANCE');
    }
    if (upstream.status === 429) {
      fail(502, 'DeepSeek rate limit reached (429). Try again shortly.', 'RATE_LIMITED');
    }
    fail(502, `DeepSeek API error (${upstream.status}). ${detail}`.trim(), 'UPSTREAM_ERROR');
  }

  let parsed;
  try {
    parsed = JSON.parse(upstreamText);
  } catch (_) {
    fail(502, 'DeepSeek returned an unreadable response.', 'UPSTREAM_BAD_JSON');
  }

  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : {};
  const result = {
    content: normalizeMessageContent(message.content),
    reasoningContent: normalizeMessageContent(message.reasoning_content),
    finishReason: choice ? choice.finish_reason || null : null,
    model: parsed && parsed.model ? parsed.model : requestBody.model,
    usage: parsed && parsed.usage ? parsed.usage : null,
  };

  if (!result.content) {
    console.warn(
      '  DeepSeek returned empty content (model=%s, finish_reason=%s, reasoning_chars=%d).',
      result.model,
      result.finishReason,
      result.reasoningContent.length
    );
  }

  return result;
}

async function callDeepSeekJson(apiKey, requestBody) {
  const completion = await callDeepSeek(apiKey, requestBody);
  const data = parseJsonPayload(completion.content);
  return { completion, data, model: requestBody.model, fallback: false };
}

async function handleGenerate(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.api_key_enc) {
    fail(409, 'No DeepSeek API key is saved for your account. Add one in Settings.', 'NO_API_KEY');
  }

  const apiKey = security.decryptApiKey(session.api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved API key could not be read. Please save it again.', 'KEY_UNREADABLE');
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  const rawN = parseInt(body.numIdeas, 10);

  if (!TEXT_MODELS.has(model)) {
    fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');
  if (!context) fail(400, 'Please provide context (paste text or upload a .txt file).');
  if (context.length > 200000) fail(400, 'Context is too large (max 200,000 characters).');

  const numIdeas = Math.min(Math.max(Number.isFinite(rawN) ? rawN : 5, 1), 50);
  const ideaContext = `${context}\n\nDescribe Characters and Setting.`;

  const userContent =
    `Generate exactly ${numIdeas} distinct ideas based on the following context.\n\n` +
    `Context:\n"""\n${ideaContext}\n"""\n\n` +
    `Return a JSON array with exactly ${numIdeas} objects, each with "title" and "description" fields.`;

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.9,
    max_tokens: 4000,
  };
  const completion = await callDeepSeek(apiKey, requestBody);

  const ideas = parseIdeas(completion.content || '');
  if (!ideas.length) {
    fail(502, 'DeepSeek returned no parseable ideas.', 'NO_IDEAS');
  }

  return sendJSON(res, 200, { ideas, model, count: ideas.length });
}

async function callChatUpstream(request) {
  const started = Date.now();
  let result;
  let failure;
  try {
    result = await requestChatUpstream(request);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    apiUsageStore.record({
      ...request.telemetry, provider: request.provider, model: result?.model || request.model,
      status: failure ? 'error' : 'success', errorCode: failure?.code || null,
      durationMs: Date.now() - started, usage: result?.usage || failure?.usage || null,
    });
  }
}

async function requestChatUpstream({ provider, endpoint, apiKey, model, system, messages, temperature, maxTokens }) {
  let upstreamBody;
  let headers;
  if (provider === 'anthropic') {
    upstreamBody = { model, max_tokens: maxTokens, system, messages };
    if (temperature !== null) upstreamBody.temperature = temperature;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  } else {
    upstreamBody = {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature,
      max_tokens: maxTokens,
    };
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  let upstream;
  try {
    upstream = await requestTracker.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(120000),
    }, { provider });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      fail(504, 'The chat model did not respond in time. Try again.', 'UPSTREAM_TIMEOUT');
    }
    fail(502, `Could not reach the chat model: ${err.message}`, 'UPSTREAM_UNREACHABLE');
  }

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    let detail = upstreamText;
    try {
      const parsed = JSON.parse(upstreamText);
      detail = (parsed.error && (parsed.error.message || parsed.error.code)) || upstreamText;
    } catch (_) { /* keep raw text */ }
    detail = String(detail).slice(0, 500);
    if (upstream.status === 401) {
      fail(502, 'The chat provider rejected your API key (401). Check it in Settings.', 'INVALID_API_KEY');
    }
    if (upstream.status === 402) {
      fail(502, 'The chat provider reports insufficient balance (402).', 'INSUFFICIENT_BALANCE');
    }
    if (upstream.status === 429) {
      fail(502, 'The chat provider rate limit was reached (429). Try again shortly.', 'RATE_LIMITED');
    }
    fail(502, `Chat provider error (${upstream.status}). ${detail}`.trim(), 'UPSTREAM_ERROR');
  }

  let parsed;
  try {
    parsed = JSON.parse(upstreamText);
  } catch (_) {
    fail(502, 'The chat model returned an unreadable response.', 'UPSTREAM_BAD_JSON');
  }

  let content = '';
  if (provider === 'anthropic') {
    const blocks = parsed && Array.isArray(parsed.content) ? parsed.content : [];
    content = blocks.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('');
  } else {
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    content = normalizeMessageContent(message.content);
  }

  const usage = normalizeUsage(parsed?.usage, provider);
  if (!content || !content.trim()) {
    throw Object.assign(new HttpError(502, 'The chat model returned an empty reply. Try again.', 'NO_CHAT_REPLY'), { usage });
  }
  return { content: content.trim(), model: parsed && parsed.model ? parsed.model : model, usage };
}

// Each module scopes the Guide: the same assistant answers differently in Story
// Studio than in Generate Images. This is guidance for the chat, never a
// replacement for the context the user saved in Settings.
const MODULE_GUIDANCE = {
  'story-studio': 'The user is working in Story Studio, where one story moves through the steps Idea, References, Characters & Locations, Scenes, Generate, and Review, in that order. Keep every answer about that story, and say which step an answer belongs to.',
  'generate-images': 'The user is working in Generate Images, which holds the Character Maker and the Standalone image generator. Those tools belong to no story unless the user is reusing one.',
};

async function handleChat(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  const mode = body.mode === 'reviewer' ? 'reviewer' : 'guide';
  const moduleId = typeof body.module === 'string' && MODULE_GUIDANCE[body.module] ? body.module : '';
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const history = rawMessages
    .slice(-20)
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        role: source.role === 'assistant' ? 'assistant' : 'user',
        content: String(source.content || '').slice(0, 20000),
      };
    })
    .filter((item) => item.content.trim());

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  let projectContext = '';
  if (projectId) {
    const project = db.getProject(session.user_id, projectId);
    if (project) projectContext = buildChatContext(session.user_id, project);
  }

  const user = db.getUserById(session.user_id);
  if (!user) fail(401, 'Please sign in.');
  const target = resolveChatTarget(user, mode);

  const system = [
    CHAT_SYSTEM_PROMPTS[mode],
    ...(target.configuredContext ? [target.configuredContext] : []),
    ...(moduleId ? [MODULE_GUIDANCE[moduleId]] : []),
    ...(projectContext ? [`Project context:\n${projectContext}`] : []),
  ].join('\n\n');

  const result = await callChatUpstream({
    ...target,
    system,
    messages: history,
    temperature: 0.7,
    maxTokens: 2000,
    telemetry: { userId: session.user_id, projectId: projectId || null, operation: `${mode}-chat` },
  });

  return sendJSON(res, 200, { reply: result.content.slice(0, 20000), model: result.model, usage: result.usage });
}

async function handleReference(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.api_key_enc) {
    fail(409, 'No DeepSeek API key is saved for your account. Add one in Settings.', 'NO_API_KEY');
  }

  const apiKey = security.decryptApiKey(session.api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved API key could not be read. Please save it again.', 'KEY_UNREADABLE');
  }

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) fail(400, 'Choose a project in Reference Stage.');

  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  const setting = typeof body.setting === 'string' ? body.setting.trim() : '';

  if (!TEXT_MODELS.has(model)) {
    fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');
  if (context.length > 20000) fail(400, 'Context is too large (max 20,000 characters).');
  if (setting.length > 2000) fail(400, 'Setting is too long (max 2,000 characters).');

  if (!Array.isArray(body.characters) || body.characters.length < 1 || body.characters.length > 4) {
    fail(400, 'Choose between 1 and 4 characters.');
  }

  const characters = body.characters.map((character) => {
    const source = character && typeof character === 'object' ? character : {};
    const name = String(source.name || '').trim().slice(0, 120);
    if (!name) fail(400, 'Enter a name for each character.');

    const rawGender = String(source.gender || '').trim();
    const genderKey = rawGender.toLowerCase();
    let gender = 'Male';
    if (genderKey === 'female') gender = 'Female';
    else if (genderKey && genderKey !== 'male') {
      fail(400, 'Gender must be Male or Female.');
    }

    return { name, gender };
  });

  const hasCharacterDetails = characters.some((c) => c.name);
  if (!context && !setting && !hasCharacterDetails) {
    fail(400, 'Add a context, setting, or character details before generating.');
  }

  // A regeneration must never silently overwrite structured records the user
  // has already edited or approved. Check before calling DeepSeek so the client
  // can surface the replacement choice without burning an upstream request.
  const replaceWorkspace = body.replaceWorkspace === true;
  if (storyStore.workspaceExists(session.user_id, projectId) && !replaceWorkspace) {
    fail(
      409,
      'Structured Story Workspace drafts already exist for this project. Confirm that you want to replace them before regenerating.',
      'WORKSPACE_REPLACE_REQUIRED'
    );
  }

  const characterText = characters
    .map(
      (character, index) =>
        `${index + 1}. Name: ${character.name}\n` +
        `   Gender: ${character.gender}`
    )
    .join('\n');

  const userContent = [
    `Project: ${project.title}`,
    `Project description / context:\n${context || '(none provided)'}`,
    `Setting:\n${setting || '(unspecified)'}`,
    `Characters:\n${characterText}`,
    'Write the structured reference material and scene outline now. Use realistic, casual, everyday scenarios and photorealistic continuity.',
  ].join('\n\n');

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: REFERENCE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.8,
    max_tokens: 20000,
  };

  let structured = await callDeepSeekJson(apiKey, requestBody);
  let parsed = unpackReferencePayload(structured.data);
  const usedFallback = structured.fallback;

  const data = parsed.data;

  if (!data || typeof data !== 'object') {
    const finish = structured.completion.finishReason
      ? ` (finish reason: ${structured.completion.finishReason})`
      : '';
    fail(
      502,
      `DeepSeek returned an unreadable reference response${finish}. Regenerate to try again.`,
      'NO_REFERENCE'
    );
  }

  const referenceMaterial = parsed.referenceMaterial.trim();
  if (!referenceMaterial) {
    const keys = Object.keys(data).slice(0, 10).join(', ') || 'empty object';
    const finish = structured.completion.finishReason
      ? ` (finish reason: ${structured.completion.finishReason})`
      : '';
    fail(
      502,
      `DeepSeek returned reference material without usable text${finish} (received: ${keys}). Try regenerate.`,
      'NO_REFERENCE'
    );
  }
  if (referenceMaterial.length > 200000) {
    fail(400, 'Reference material is too long (max 200,000 characters).', 'REFERENCE_TOO_LARGE');
  }

  const scenes = parsed.scenes;
  if (!scenes.length) {
    fail(502, 'DeepSeek returned no scene outline for this reference.', 'NO_SCENES');
  }

  const rawCharacterReferences = parsed.characterReferences;
  const referencesByName = new Map(
    rawCharacterReferences
      .filter((item) => item && typeof item === 'object' && item.name)
      .map((item) => [String(item.name).trim().toLowerCase(), item])
  );

  const characterReferences = characters.map((character, index) => {
    const indexed = rawCharacterReferences[index];
    const indexedMatches = indexed && (
      !indexed.name ||
      String(indexed.name).trim().toLowerCase() === character.name.toLowerCase()
    );
    const candidate = indexedMatches
      ? indexed
      : referencesByName.get(character.name.toLowerCase()) || indexed;
    const material = candidate && typeof candidate.referenceMaterial === 'string'
      ? candidate.referenceMaterial.trim()
      : candidate && typeof candidate.reference_material === 'string'
        ? candidate.reference_material.trim()
        : candidate && typeof candidate.material === 'string'
          ? candidate.material.trim()
          : '';
    if (!material) {
      fail(
        502,
        `DeepSeek returned no character reference material for "${character.name}". Try regenerating.`,
        'NO_CHARACTER_REFERENCES'
      );
    }
    return {
      name: character.name,
      gender: character.gender,
      referenceMaterial: material.slice(0, 30000),
    };
  });

  // Validate and normalize the structured workspace before touching anything.
  let workspace;
  try {
    workspace = normalizeStoryWorkspace(parsed.storyWorkspace, characters);
  } catch (err) {
    fail(err.status || 502, err.message, err.code || 'INVALID_WORKSPACE');
  }

  const updated = db.updateProject(session.user_id, projectId, {
    reference_material: referenceMaterial,
    scenes,
    character_references: characterReferences,
  });
  if (!updated) fail(404, 'Project not found.');

  const imported = storyStore.importWorkspace(session.user_id, projectId, workspace, {
    replace: replaceWorkspace,
    characterReferences,
  });
  storyStore.setWorksheetSetting(session.user_id, projectId, setting);
  const current = db.getProject(session.user_id, projectId);

  return sendJSON(res, 200, {
    referenceMaterial: current.referenceMaterial,
    scenes: current.scenes,
    characterReferences: current.characterReferences,
    project: current,
    model: structured.model,
    fallback: usedFallback || structured.fallback,
    workspace: {
      imported: true,
      replaced: Boolean(imported && imported.replaced),
      characters: imported ? imported.characters : 0,
      locations: imported ? imported.locations : 0,
      styles: imported ? imported.styles : 0,
      scenes: imported ? imported.scenes : 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Generation Stage: image prompts, per-prompt approval, project review, images
// ---------------------------------------------------------------------------

function generationProject(req, projectIdValue, { requireStage = false } = {}) {
  const session = requireUser(req);
  const projectId = typeof projectIdValue === 'string' ? projectIdValue.trim() : '';
  if (!projectId) fail(400, 'Choose a Generation Stage project.');
  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');
  if (requireStage && project.stage !== 'Generation Stage') {
    fail(409, 'Only a project in Generation Stage can do this.', 'WRONG_STAGE');
  }
  return { session, project };
}

/**
 * Assemble the reference material the Generation Stage builds from:
 * the shared character references, the final character reference sheets,
 * the action references, and the location references. The same bundle feeds
 * prompt building, the project review, and the image run, so all three steps
 * judge the exact same inputs.
 */
function generationReferenceBundle(userId, project) {
  const story = storyStore.getStory(userId, project.id) || {};
  const worksheet = story.worksheet || { actions: [], locations: [] };
  const actions = (Array.isArray(worksheet.actions) ? worksheet.actions : [])
    .map((item, index) => ({
      index,
      action: String((item && item.action) || '').trim(),
      locationSentence: String((item && item.locationSentence) || '').trim(),
      characters: Array.isArray(item && item.characters)
        ? item.characters.map((name) => String(name || '').trim()).filter(Boolean)
        : [],
    }))
    .filter((item) => item.action);
  const locations = (Array.isArray(worksheet.locations) ? worksheet.locations : []).map((item, index) => ({
    index,
    name: String((item && item.name) || '').trim(),
    description: String((item && item.description) || '').trim(),
  }));

  const finalSheets = new Map();
  for (const sheet of Array.isArray(story.characterSheets) ? story.characterSheets : []) {
    if (sheet.status !== 'final') continue;
    const current = finalSheets.get(sheet.characterId);
    if (!current || (sheet.version || 0) > (current.version || 0)) finalSheets.set(sheet.characterId, sheet);
  }

  const legacy = new Map((project.characterReferences || [])
    .filter((item) => item && item.name)
    .map((item) => [String(item.name).toLowerCase(), item]));
  const candidates = [];
  const pushCharacter = (name, gender, referenceMaterial, approved, sheet) => {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return;
    candidates.push({
      key,
      name: String(name),
      gender: gender || '',
      referenceMaterial: String(referenceMaterial || '').trim(),
      approved: Boolean(approved),
      sheet: sheet || null,
    });
  };
  for (const character of story.characters || []) {
    const source = legacy.get(String(character.name).toLowerCase());
    pushCharacter(
      character.name,
      character.gender,
      (source && source.referenceMaterial)
        || character.legacyMaterial
        || [character.appearance, character.wardrobe, character.continuityNotes].filter(Boolean).join('. '),
      character.approved,
      finalSheets.get(character.id) || null
    );
  }
  for (const item of project.characterReferences || []) {
    if (!item || !item.name) continue;
    pushCharacter(item.name, item.gender, item.referenceMaterial, false, null);
  }

  // A name can appear twice when a project migrated a legacy character
  // reference as well as a Story Workspace character. The entry that actually
  // carries a final reference sheet is the one the images must use.
  const preferred = new Map();
  for (const candidate of candidates) {
    const current = preferred.get(candidate.key);
    if (!current) {
      preferred.set(candidate.key, candidate);
      continue;
    }
    const candidateWins = (!current.sheet && candidate.sheet)
      || (Boolean(current.sheet) === Boolean(candidate.sheet) && !current.approved && candidate.approved);
    if (candidateWins) {
      if (!candidate.referenceMaterial) candidate.referenceMaterial = current.referenceMaterial;
      preferred.set(candidate.key, candidate);
    } else if (!current.referenceMaterial && candidate.referenceMaterial) {
      current.referenceMaterial = candidate.referenceMaterial;
    }
  }
  const characters = Array.from(preferred.values()).map((character) => ({
    id: '',
    name: character.name,
    gender: character.gender,
    referenceMaterial: character.referenceMaterial,
    approved: character.approved,
    sheet: character.sheet
      ? {
        id: character.sheet.id,
        file: character.sheet.file,
        version: character.sheet.version,
        mime: character.sheet.mime || 'image/png',
      }
      : null,
  }));

  const blockers = [];
  if (!String(project.referenceMaterial || '').trim()) {
    blockers.push({ code: 'referenceMaterial', step: 'build', message: 'Reference material is missing. Generate it in Reference Stage first.' });
  }
  if (!characters.length) {
    blockers.push({ code: 'characterReferences', step: 'build', message: 'Character references are missing. Generate them in Reference Stage first.' });
  }
  if (!actions.length) {
    blockers.push({ code: 'actionReferences', step: 'build', message: 'Action references are missing. Generate and save them in the Story Workspace first.' });
  }
  if (!locations.length || locations.length !== actions.length) {
    blockers.push({ code: 'locationReferences', step: 'build', message: 'Location references are missing or do not match the action references. Generate and save them in the Story Workspace first.' });
  }
  const byName = new Map(characters.map((character) => [String(character.name).toLowerCase(), character]));
  for (const action of actions) {
    for (const name of action.characters) {
      const key = String(name).toLowerCase();
      const character = byName.get(key);
      if (character && character.sheet) continue;
      const code = `characterSheet:${key}`;
      if (blockers.some((item) => item.code === code)) continue;
      blockers.push({
        code,
        step: 'images',
        message: `"${name}" has no final character reference sheet. Add one in the Story Workspace so it can be used for every image.`,
      });
    }
  }

  return {
    referenceMaterial: String(project.referenceMaterial || '').trim(),
    characters,
    actions,
    locations,
    sheetCount: characters.filter((character) => character.sheet).length,
    blockers,
    ready: {
      build: !blockers.some((item) => item.step === 'build'),
      images: !blockers.length,
    },
  };
}

/** The final character reference sheets that belong to one image prompt. */
function generationReferenceImages(project, references, prompt) {
  const byName = new Map(references.characters.map((character) => [String(character.name).toLowerCase(), character]));
  const images = [];
  for (const name of prompt.characters || []) {
    const character = byName.get(String(name).toLowerCase());
    const sheet = character && character.sheet;
    if (!sheet) continue;
    try {
      const data = fs.readFileSync(path.join(IMAGE_DIR, project.id, sheet.file));
      images.push(`data:${sheet.mime || 'image/png'};base64,${data.toString('base64')}`);
    } catch (_) { /* a sheet file that is gone is simply not attached */ }
  }
  return images.slice(0, 10);
}

function generationPromptList(value, count) {
  const list = Array.isArray(value)
    ? value
    : value && Array.isArray(value.prompts)
      ? value.prompts
      : null;
  if (!list) fail(502, 'The image-prompt response was unreadable. Build the prompts again.', 'NO_PROMPTS');
  if (list.length !== count) {
    fail(502, `The build returned ${list.length} prompt(s) for ${count} image(s). Build the prompts again.`, 'PROMPT_COUNT_MISMATCH');
  }
  return list.map((item, index) => {
    const prompt = typeof item === 'string'
      ? item.trim()
      : item && typeof item.prompt === 'string'
        ? item.prompt.trim()
        : '';
    if (!prompt) fail(502, `The build returned an empty prompt for image ${index + 1}.`, 'NO_PROMPTS');
    return prompt.slice(0, generationStore.MAX_PROMPT_CHARS);
  });
}

function handleGenerationState(req, res, projectId) {
  const { session, project } = generationProject(req, projectId);
  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  return sendJSON(res, 200, {
    project: { id: project.id, title: project.title, stage: project.stage, status: project.status },
    references: generationReferenceBundle(session.user_id, project),
    task: generationStore.getTask(session.user_id, project.id),
    imageModel,
    imageSizes: IMAGE_MODEL_SIZES.get(imageModel) || ['2K'],
  });
}

async function handleGenerationBuild(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.api_key_enc) {
    fail(409, 'No DeepSeek API key is saved for your account. Add one in Settings.', 'NO_API_KEY');
  }
  const apiKey = security.decryptApiKey(session.api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved API key could not be read. Please save it again.', 'KEY_UNREADABLE');
  }

  const { project } = generationProject(req, body.projectId, { requireStage: true });
  const references = generationReferenceBundle(session.user_id, project);
  if (!references.ready.build) {
    const blocker = references.blockers.find((item) => item.step === 'build');
    fail(409, blocker.message, 'GENERATION_REFERENCES_MISSING');
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  if (!TEXT_MODELS.has(model)) {
    fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');

  const userContent = [
    `Reference material:\n${references.referenceMaterial}`,
    `Character references (JSON, identical for every image):\n${JSON.stringify(
      references.characters.map((character) => ({
        name: character.name,
        gender: character.gender,
        referenceMaterial: character.referenceMaterial,
      })), null, 2)}`,
    `Character reference sheets (JSON, one final sheet per character, already used as the visual reference for every image):\n${JSON.stringify(
      references.characters.map((character) => ({
        name: character.name,
        sheetVersion: character.sheet ? character.sheet.version : null,
      })), null, 2)}`,
    `Action references (JSON, one image each, in order):\n${JSON.stringify(references.actions, null, 2)}`,
    `Location references (JSON, in the same order as the action references):\n${JSON.stringify(references.locations, null, 2)}`,
    `Write exactly ${references.actions.length} image prompts, one per action reference, in this order. Return {"prompts":[...]} as JSON only.`,
  ].join('\n\n');

  const structured = await callDeepSeekJson(apiKey, {
    model,
    messages: [
      { role: 'system', content: GENERATION_BUILD_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });
  if (structured.completion.finishReason === 'length') {
    fail(502, 'DeepSeek reached the output limit before finishing the image prompts. Try building again.', 'PROMPT_OUTPUT_LIMIT');
  }

  const prompts = generationPromptList(structured.data, references.actions.length).map((prompt, index) => {
    const action = references.actions[index];
    const location = references.locations[index] || { name: '', description: '' };
    return {
      index,
      action: action.action,
      locationSentence: action.locationSentence,
      characters: action.characters,
      locationName: location.name || '',
      locationDescription: location.description || '',
      prompt,
    };
  });

  return sendJSON(res, 200, { prompts, model: structured.model, fallback: structured.fallback });
}

async function handleGenerationSave(req, res, projectId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const { project } = generationProject(req, projectId, { requireStage: true });

  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const incoming = Array.isArray(body.prompts) ? body.prompts : [];
  // Action references map onto scenes one to one, so a saved prompt keeps the
  // scene it was built for as its provenance.
  const prompts = incoming.map((prompt, index) => {
    const scene = scenes[index];
    if (!scene || !scene.id || (prompt && prompt.sceneId)) return prompt;
    return { ...prompt, sceneId: scene.id };
  });

  let task;
  try {
    task = generationStore.savePrompts(session.user_id, project.id, prompts);
  } catch (err) {
    fail(err.status || 500, err.message, err.code);
  }
  if (!task) fail(404, 'Project not found.');
  return sendJSON(res, 200, { task, project: db.getProject(session.user_id, project.id) });
}

async function handleGenerationPromptUpdate(req, res, projectId, promptId) {
  const { session, project } = generationProject(req, projectId);
  const body = await readJSON(req);
  let task;
  try {
    task = generationStore.updatePrompt(session.user_id, project.id, promptId, body.prompt);
  } catch (err) {
    fail(err.status || 500, err.message, err.code);
  }
  if (!task) fail(404, 'Image prompt not found.');
  return sendJSON(res, 200, { task });
}

async function handleGenerationApproval(req, res, projectId, promptId) {
  const { session, project } = generationProject(req, projectId);
  const body = await readJSON(req);
  const task = generationStore.setPromptApproval(session.user_id, project.id, promptId, body.approved === true);
  if (!task) fail(404, 'Image prompt not found.');
  return sendJSON(res, 200, { task });
}

async function handleGenerationReview(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const { project } = generationProject(req, body.projectId, { requireStage: true });

  const task = generationStore.getTask(session.user_id, project.id);
  if (!task || !task.prompts.length) {
    fail(409, 'Build and save the image prompts first.', 'PROMPTS_REQUIRED');
  }
  if (!task.state.approvals) {
    fail(409, 'Approve every image prompt before reviewing the project.', 'APPROVALS_REQUIRED');
  }

  const user = db.getUserById(session.user_id);
  if (!user) fail(401, 'Please sign in.');
  const target = resolveChatTarget(user, 'reviewer');
  const references = generationReferenceBundle(session.user_id, project);

  const userContent = [
    `Reference material:\n${references.referenceMaterial}`,
    `Character references (JSON):\n${JSON.stringify(
      references.characters.map((character) => ({
        name: character.name,
        gender: character.gender,
        referenceMaterial: character.referenceMaterial,
      })), null, 2)}`,
    `Character reference sheets (JSON):\n${JSON.stringify(
      references.characters.map((character) => ({
        name: character.name,
        sheetVersion: character.sheet ? character.sheet.version : null,
      })), null, 2)}`,
    `Action references (JSON):\n${JSON.stringify(references.actions, null, 2)}`,
    `Location references (JSON):\n${JSON.stringify(references.locations, null, 2)}`,
    `Image prompts to review (JSON, one per image, in order):\n${JSON.stringify(
      task.prompts.map((prompt) => ({
        promptId: prompt.id,
        action: prompt.action,
        location: prompt.locationName,
        characters: prompt.characters,
        prompt: prompt.prompt,
      })), null, 2)}`,
    'Compare every image prompt with the references. Return {"flags":[...]} as JSON only.',
  ].join('\n\n');

  const result = await callChatUpstream({
    ...target,
    system: [
      GENERATION_REVIEW_SYSTEM_PROMPT,
      ...(target.configuredContext ? [target.configuredContext] : []),
    ].join('\n\n'),
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.2,
    maxTokens: 8000,
    telemetry: { userId: session.user_id, projectId: project.id, operation: 'generation-review' },
  });

  const data = parseJsonPayload(result.content);
  const list = data && Array.isArray(data.flags) ? data.flags : Array.isArray(data) ? data : null;
  if (!list) {
    fail(502, 'The reviewer returned an unreadable result. Try the review again.', 'INVALID_REVIEW_RESPONSE');
  }

  const known = new Set(task.prompts.map((prompt) => prompt.id));
  const findings = [];
  for (const raw of list) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const promptId = String(item.promptId || item.prompt_id || item.id || '').trim();
    const message = String(item.message || item.issue || item.detail || '').trim();
    if (!known.has(promptId) || !message) continue;
    const severity = String(item.severity || item.level || '').toLowerCase();
    findings.push({
      promptId,
      severity: ['error', 'warning', 'info'].includes(severity) ? severity : 'warning',
      message: message.slice(0, 2000),
    });
  }

  const updated = generationStore.setReviewFlags(session.user_id, project.id, findings, result.model);
  return sendJSON(res, 200, {
    task: updated,
    review: { model: result.model, flagCount: updated.state.openFlagCount },
  });
}

async function handleGenerationFlag(req, res, projectId, promptId, flagId) {
  const { session, project } = generationProject(req, projectId);
  const body = await readJSON(req);
  let task;
  try {
    task = generationStore.resolveFlag(session.user_id, project.id, promptId, flagId, String(body.status || '').trim());
  } catch (err) {
    fail(err.status || 500, err.message, err.code);
  }
  if (!task) fail(404, 'Review flag not found.');
  return sendJSON(res, 200, { task });
}

async function handleGenerationImageOne(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.byteplus_api_key_enc) {
    fail(409, 'No BytePlus API key is saved for your account. Add one in Settings.', 'NO_IMAGEGEN_KEY');
  }
  const apiKey = security.decryptApiKey(session.byteplus_api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved BytePlus API key could not be read. Please save it again.', 'IMAGEGEN_KEY_UNREADABLE');
  }

  const { project } = generationProject(req, body.projectId, { requireStage: true });
  const promptId = typeof body.promptId === 'string' ? body.promptId.trim() : '';
  if (!promptId) fail(400, 'Choose an image prompt to generate.');

  const task = generationStore.getTask(session.user_id, project.id);
  const prompt = task && task.prompts.find((item) => item.id === promptId);
  if (!prompt) fail(404, 'Image prompt not found.');
  if (!task.state.review) {
    fail(
      409,
      'Approve every image prompt and finish the project review before generating images.',
      'REVIEW_REQUIRED'
    );
  }
  if (!prompt.prompt.trim()) fail(400, 'This image prompt is empty.');

  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel);
  const defaultSize = allowedSizes.includes('2K') ? '2K' : allowedSizes[0];
  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : defaultSize;
  if (!allowedSizes.includes(size)) {
    fail(400, `Invalid image size for this model. Choose ${allowedSizes.join(', ')}.`);
  }

  const references = generationReferenceBundle(session.user_id, project);
  const referenceImages = generationReferenceImages(project, references, prompt);
  if (!referenceImages.length) {
    fail(
      409,
      'No character reference sheet is available for this image. Add final character reference sheets in the Story Workspace first.',
      'REFERENCE_IMAGES_REQUIRED'
    );
  }

  const image = await storeGeneratedImage({
    session,
    project,
    apiKey,
    imageModel,
    size,
    prompt: prompt.prompt,
    referenceImages,
    sceneId: prompt.sceneId || prompt.id,
    title: prompt.action || `Image ${prompt.index + 1}`,
  });

  const updated = generationStore.recordImage(session.user_id, project.id, promptId, {
    file: image.file,
    mime: image.mime,
    size: image.size,
    model: image.model,
    prompt: prompt.prompt,
    createdAt: image.createdAt,
    assetId: image.assetId,
    versionId: image.versionId,
    revision: image.revision,
    promptDraftId: image.promptDraftId,
  });
  if (!updated) fail(404, 'Image prompt not found.');

  return sendJSON(res, 201, {
    task: updated,
    image,
    project: db.getProject(session.user_id, project.id),
  });
}
async function generateImageBuffer(apiKey, imageModel, size, prompt, referenceImages = []) {
  const images = (Array.isArray(referenceImages) ? referenceImages : [referenceImages])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 10);
  let upstream;
  try {
    upstream = await requestTracker.fetch(BYTEPLUS_IMAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        ...(images.length ? { image: images } : {}),
        size,
        response_format: 'b64_json',
        output_format: 'png',
        watermark: false,
      }),
      signal: AbortSignal.timeout(180000),
    }, { provider: 'byteplus' });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      fail(504, 'BytePlus image generation timed out. Try again.', 'IMAGEGEN_TIMEOUT');
    }
    fail(502, `Could not reach BytePlus: ${err.message}`, 'IMAGEGEN_UNREACHABLE');
  }

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    let detail = upstreamText;
    try {
      const data = JSON.parse(upstreamText);
      detail = (data.error && (data.error.message || data.error.code)) || upstreamText;
    } catch (_) { /* keep raw text */ }
    detail = String(detail).slice(0, 500);
    if (upstream.status === 401) {
      fail(502, 'Your BytePlus API key was rejected. Update it in Settings.', 'INVALID_IMAGEGEN_KEY');
    }
    if (upstream.status === 403) {
      fail(
        502,
        'BytePlus rejected the image request (403). Check that your key is valid and the selected Seedream model is activated.',
        'IMAGEGEN_FORBIDDEN'
      );
    }
    if (upstream.status === 429) {
      fail(502, 'BytePlus rate limit reached. Try again shortly.', 'IMAGEGEN_RATE_LIMITED');
    }
    fail(502, `BytePlus image generation failed (${upstream.status}). ${detail}`.trim(), 'IMAGEGEN_ERROR');
  }

  let payload;
  try {
    payload = JSON.parse(upstreamText);
  } catch (_) {
    fail(502, 'BytePlus returned an unreadable image response.', 'IMAGEGEN_BAD_JSON');
  }

  const first = payload && Array.isArray(payload.data) ? payload.data[0] : null;
  if (!first) {
    fail(502, 'BytePlus returned no image data.', 'IMAGEGEN_NO_DATA');
  }

  let buffer;
  let mime = 'image/png';
  let extension = 'png';

  try {
    if (typeof first.b64_json === 'string' && first.b64_json.trim()) {
      const raw = first.b64_json.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
      buffer = Buffer.from(raw, 'base64');
      if (typeof first.output_format === 'string' && first.output_format.toLowerCase() === 'jpeg') {
        mime = 'image/jpeg';
        extension = 'jpg';
      }
    } else if (typeof first.url === 'string' && first.url) {
      const imageResponse = await requestTracker.fetch(first.url, { signal: AbortSignal.timeout(60000) }, { provider: 'image-download' });
      if (!imageResponse.ok) {
        fail(502, `Could not download the generated image (${imageResponse.status}).`, 'IMAGEGEN_DOWNLOAD_FAILED');
      }
      const contentType = imageResponse.headers.get('content-type') || 'image/png';
      mime = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/png';
      extension = mime === 'image/jpeg' ? 'jpg' : 'png';
      buffer = Buffer.from(await imageResponse.arrayBuffer());
    } else {
      fail(502, 'BytePlus returned an image without data or URL.', 'IMAGEGEN_NO_DATA');
    }
  } catch (err) {
    if (err && err.status) throw err;
    fail(502, `Could not read the generated image: ${err.message}`, 'IMAGEGEN_DECODE_FAILED');
  }

  if (!buffer || buffer.length === 0) {
    fail(502, 'BytePlus returned an empty image.', 'IMAGEGEN_EMPTY');
  }
  if (buffer.length > 50 * 1024 * 1024) {
    fail(502, 'The generated image is too large to store.', 'IMAGEGEN_TOO_LARGE');
  }

  return { buffer, mime, extension, size: typeof first.size === 'string' ? first.size : size };
}

/**
 * Render one image and file it into the project and the asset Library.
 * `referenceImages` are data URLs; when present they are sent to the image
 * model as visual references so a scene image can reuse a canonical character
 * reference sheet.
 */
async function storeGeneratedImage({
  session,
  project,
  apiKey,
  imageModel,
  size,
  prompt,
  referenceImages = [],
  sceneId,
  title,
  promptDraftId,
}) {
  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt, referenceImages);
  const file = `${crypto.randomUUID()}.${generated.extension}`;
  const directory = path.join(IMAGE_DIR, project.id);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), generated.buffer);
  } catch (err) {
    fail(500, `Could not save the generated image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  const image = {
    sceneId,
    file,
    mime: generated.mime,
    size: generated.size,
    prompt,
    model: imageModel,
    source: 'generated',
    createdAt: new Date().toISOString(),
  };

  let recorded;
  try {
    recorded = assetStore.recordImage({
      userId: session.user_id,
      projectId: project.id,
      sceneId,
      relativePath: `${project.id}/${file}`,
      source: 'generated',
      model: imageModel,
      prompt,
      promptDraftId,
      title,
    });
  } catch (err) {
    fail(500, `Could not record the generated asset: ${err.message}`, 'ASSET_RECORD_FAILED');
  }

  return {
    ...image,
    assetId: recorded.assetId,
    versionId: recorded.versionId,
    revision: recorded.revision,
    promptDraftId: recorded.promptDraftId || null,
    url: `/api/image/${encodeURIComponent(project.id)}/${encodeURIComponent(file)}`,
  };
}

async function handleGenerateImage(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.byteplus_api_key_enc) {
    fail(409, 'No BytePlus API key is saved for your account. Add one in Settings.', 'NO_IMAGEGEN_KEY');
  }

  const apiKey = security.decryptApiKey(session.byteplus_api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved BytePlus API key could not be read. Please save it again.', 'IMAGEGEN_KEY_UNREADABLE');
  }

  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model)
    ? session.image_model
    : DEFAULT_IMAGE_MODEL;
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel);
  const defaultSize = allowedSizes.includes('2K') ? '2K' : allowedSizes[0];

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  const sceneId = typeof body.sceneId === 'string' ? body.sceneId.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : defaultSize;

  if (!projectId) fail(400, 'Choose a Generation Stage project.');
  if (!sceneId) fail(400, 'Choose a scene to illustrate.');
  if (!prompt) fail(400, 'Generate or enter a scene prompt first.');
  if (prompt.length > 30000) fail(400, 'Image prompt is too long (max 30,000 characters).');
  if (!allowedSizes.includes(size)) {
    fail(400, `Invalid image size for this model. Choose ${allowedSizes.join(', ')}.`);
  }

  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');
  if (!project.scenes.some((scene) => scene.id === sceneId)) {
    fail(404, 'Scene not found.');
  }
  const latestDraft = storyStore.latestDraft(session.user_id, projectId, sceneId);
  const promptDraftId = latestDraft && latestDraft.text === prompt ? latestDraft.id : null;

  const image = await storeGeneratedImage({
    session,
    project,
    apiKey,
    imageModel,
    size,
    prompt,
    sceneId,
    promptDraftId,
  });

  const updated = db.getProject(session.user_id, projectId);
  if (!updated) fail(404, 'Project not found.');

  return sendJSON(res, 200, { image, project: updated });
}

async function handleUploadImage(req, res) {
  const session = requireUser(req);
  const requestUrl = new URL(req.url, 'http://localhost');
  const projectId = (requestUrl.searchParams.get('projectId') || '').trim();
  const sceneId = (requestUrl.searchParams.get('sceneId') || '').trim();

  if (!projectId) fail(400, 'Choose a Generation Stage project.');
  if (!sceneId) fail(400, 'Choose a scene for this image.');

  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');
  if (!project.scenes.some((scene) => scene.id === sceneId)) {
    fail(404, 'Scene not found.');
  }

  const buffer = await readBinary(req, MAX_UPLOAD_BYTES);
  if (!buffer || !buffer.length) fail(400, 'The uploaded image is empty.');

  const type = detectImageType(buffer);
  if (!type) {
    fail(400, 'Upload a PNG, JPEG, or WebP image.');
  }

  const file = `${crypto.randomUUID()}.${type.extension}`;
  const directory = path.join(IMAGE_DIR, projectId);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), buffer);
  } catch (err) {
    fail(500, `Could not save the uploaded image: ${err.message}`, 'IMAGE_UPLOAD_SAVE_FAILED');
  }

  const image = {
    sceneId,
    file,
    mime: type.mime,
    size: '',
    bytes: buffer.length,
    prompt: '',
    model: 'upload',
    source: 'upload',
    createdAt: new Date().toISOString(),
  };

  let recorded;
  try {
    recorded = assetStore.recordImage({
      userId: session.user_id,
      projectId,
      sceneId,
      relativePath: `${projectId}/${file}`,
      source: 'upload',
      model: 'upload',
      prompt: '',
    });
  } catch (err) {
    fail(500, `Could not record the uploaded asset: ${err.message}`, 'ASSET_RECORD_FAILED');
  }

  const updated = db.getProject(session.user_id, projectId);
  if (!updated) fail(404, 'Project not found.');

  return sendJSON(res, 200, {
    image: {
      ...image,
      assetId: recorded.assetId,
      versionId: recorded.versionId,
      revision: recorded.revision,
      promptDraftId: recorded.promptDraftId || null,
      url: `/api/image/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`,
    },
    project: updated,
  });
}

async function handleServeImage(req, res, projectId, file) {
  const session = requireUser(req);
  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Image not found.');

  const image = (project.sceneImages || []).find((item) => item.file === file);
  if (!image) fail(404, 'Image not found.');

  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|webp)$/i.test(file)) {
    fail(404, 'Image not found.');
  }

  const fullPath = path.join(IMAGE_DIR, projectId, file);
  let data;
  try {
    data = await fs.promises.readFile(fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': image.mime || 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Library image discovery
// ---------------------------------------------------------------------------

function isUuidSegment(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function hasForeignUuidSegment(relativePath, ownedProjectIds) {
  return relativePath
    .split('/')
    .some((segment) => isUuidSegment(segment) && !ownedProjectIds.has(segment));
}

function isLibraryHidden(name) {
  return !name || name.startsWith('.') || name === '__MACOSX' || LIBRARY_HIDDEN.has(name);
}

function detectLibraryImageType(buffer) {
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

function libraryExtensionMatches(buffer, extension) {
  const detected = detectLibraryImageType(buffer);
  if (!detected) return false;
  if (extension === 'jpg' || extension === 'jpeg') return detected.extension === 'jpg';
  return detected.extension === extension;
}

async function readFileHeader(filePath, maxBytes = LIBRARY_HEADER_BYTES) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function normalizeLibraryRelativePath(input) {
  if (typeof input !== 'string') return null;
  if (!input || input.length > 2000) return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return null;

  const normalized = path.posix.normalize(input);
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function resolveLibraryFile(userId, input) {
  const relativePath = normalizeLibraryRelativePath(input);
  if (!relativePath) fail(400, 'Invalid image path.');
  if (relativePath.split('/').some((segment) => isLibraryHidden(segment))) {
    fail(404, 'Image not found.');
  }

  const extension = path.posix.extname(relativePath).slice(1).toLowerCase();
  if (!LIBRARY_EXTENSIONS.has(extension)) fail(404, 'Image not found.');

  const ownedProjectIds = new Set((db.listProjects(userId) || []).map((project) => project.id));
  const ownedAssetPath = assetStore.canReadPath(userId, relativePath);
  if (!ownedAssetPath && hasForeignUuidSegment(relativePath, ownedProjectIds)) {
    fail(404, 'Image not found.');
  }

  let rootReal;
  try {
    rootReal = await fs.promises.realpath(IMAGE_DIR);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  const target = path.resolve(rootReal, ...relativePath.split('/'));
  const relativeTarget = path.relative(rootReal, target);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    fail(404, 'Image not found.');
  }

  let targetReal;
  let stat;
  try {
    targetReal = await fs.promises.realpath(target);
    const realRelative = path.relative(rootReal, targetReal);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      fail(404, 'Image not found.');
    }
    const realSegments = realRelative.split(path.sep).filter(Boolean);
    if (realSegments.some((segment) => isLibraryHidden(segment))) fail(404, 'Image not found.');
    if (!ownedAssetPath && hasForeignUuidSegment(realSegments.join('/'), ownedProjectIds)) {
      fail(404, 'Image not found.');
    }
    if (ownedAssetPath && realSegments.join('/') !== relativePath &&
        hasForeignUuidSegment(realSegments.join('/'), ownedProjectIds)) {
      fail(404, 'Image not found.');
    }
    stat = await fs.promises.stat(targetReal);
    if (!stat.isFile()) fail(404, 'Image not found.');
  } catch (err) {
    if (err && err.status) throw err;
    fail(404, 'Image not found.');
  }

  let header;
  try {
    header = await readFileHeader(targetReal);
  } catch (_) {
    fail(404, 'Image not found.');
  }
  if (!header || !libraryExtensionMatches(header, extension)) fail(404, 'Image not found.');

  return {
    fullPath: targetReal,
    mime: LIBRARY_MIME[extension],
    size: stat.size,
  };
}

async function handleLibraryList(req, res) {
  const session = requireUser(req);
  const images = reviewStore.enrichAssets(session.user_id, assetStore.listLibraryImages(session.user_id));
  res.setHeader('Cache-Control', 'no-store');
  return sendJSON(res, 200, { images });
}

async function handleLibraryFile(req, res, requestUrl) {
  const session = requireUser(req);
  const relativePath = requestUrl.searchParams.get('path') || '';
  const file = await resolveLibraryFile(session.user_id, relativePath);

  let data;
  try {
    data = await fs.promises.readFile(file.fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Asset registry APIs
// ---------------------------------------------------------------------------

function assetFilters(requestUrl) {
  return {
    projectId: requestUrl.searchParams.get('projectId') || '',
    episodeId: requestUrl.searchParams.get('episodeId') || '',
    collectionId: requestUrl.searchParams.get('collectionId') || '',
    tag: requestUrl.searchParams.get('tag') || '',
    type: requestUrl.searchParams.get('type') || '',
    status: requestUrl.searchParams.get('status') || '',
    q: requestUrl.searchParams.get('q') || '',
    duplicate: requestUrl.searchParams.get('duplicate') || '',
    missing: requestUrl.searchParams.get('missing') || '',
    unassigned: requestUrl.searchParams.get('unassigned') || '',
  };
}

function handleAssetList(req, res, requestUrl) {
  const session = requireUser(req);
  const assets = reviewStore.enrichAssets(session.user_id, assetStore.listAssets(session.user_id, assetFilters(requestUrl)));
  res.setHeader('Cache-Control', 'no-store');
  return sendJSON(res, 200, { assets });
}

function handleAssetDetail(req, res, assetId) {
  const session = requireUser(req);
  const asset = assetStore.getAsset(session.user_id, assetId);
  if (!asset) fail(404, 'Asset not found.');
  reviewStore.enrichAssets(session.user_id, [asset]);
  return sendJSON(res, 200, { asset });
}

async function handleEpisodeCollection(req, res, projectId) {
  const session = requireUser(req);
  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');
  if (req.method === 'GET') {
    return sendJSON(res, 200, { episodes: assetStore.listEpisodes(session.user_id, projectId) });
  }
  const body = await readJSON(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) fail(400, 'Episode title is required.');
  if (title.length > 200) fail(400, 'Episode title is too long.');
  const episode = assetStore.createEpisode(session.user_id, projectId, title);
  if (!episode) fail(404, 'Project not found.');
  return sendJSON(res, 201, { episode });
}

function handleEpisodeDelete(req, res, episodeId) {
  const session = requireUser(req);
  if (!assetStore.deleteEpisode(session.user_id, episodeId)) fail(404, 'Episode not found.');
  return sendJSON(res, 200, { ok: true });
}

async function handleEpisodeUpdate(req, res, episodeId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) fail(400, 'Episode title is required.');
  if (title.length > 200) fail(400, 'Episode title is too long.');
  const episode = assetStore.updateEpisode(session.user_id, episodeId, title);
  if (!episode) fail(404, 'Episode not found.');
  return sendJSON(res, 200, { episode });
}

async function handleCollections(req, res) {
  const session = requireUser(req);
  if (req.method === 'GET') {
    return sendJSON(res, 200, { collections: assetStore.listCollections(session.user_id) });
  }
  const body = await readJSON(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) fail(400, 'Collection name is required.');
  if (name.length > 200) fail(400, 'Collection name is too long.');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : '';
  return sendJSON(res, 201, { collection: assetStore.createCollection(session.user_id, name, description) });
}

function handleCollectionDelete(req, res, collectionId) {
  const session = requireUser(req);
  if (!assetStore.deleteCollection(session.user_id, collectionId)) fail(404, 'Collection not found.');
  return sendJSON(res, 200, { ok: true });
}

async function handleCollectionUpdate(req, res, collectionId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) fail(400, 'Collection name is required.');
  if (name.length > 200) fail(400, 'Collection name is too long.');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : '';
  const collection = assetStore.updateCollection(session.user_id, collectionId, name, description);
  if (!collection) fail(404, 'Collection not found.');
  return sendJSON(res, 200, { collection });
}

async function handleCollectionAsset(req, res, collectionId, assetId) {
  const session = requireUser(req);
  if (req.method === 'POST') {
    const asset = assetStore.getAsset(session.user_id, assetId);
    if (!asset) fail(404, 'Asset not found.');
    if (!assetStore.addAssetToCollection(session.user_id, collectionId, assetId)) {
      fail(404, 'Collection not found.');
    }
    return sendJSON(res, 200, { ok: true });
  }
  if (!assetStore.removeAssetFromCollection(session.user_id, collectionId, assetId)) {
    fail(404, 'Collection not found.');
  }
  return sendJSON(res, 200, { ok: true });
}

async function handleTags(req, res) {
  const session = requireUser(req);
  if (req.method === 'GET') {
    return sendJSON(res, 200, { tags: assetStore.listTags(session.user_id) });
  }
  const body = await readJSON(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) fail(400, 'Tag name is required.');
  if (name.length > 80) fail(400, 'Tag name is too long.');
  return sendJSON(res, 201, { tag: assetStore.createTag(session.user_id, name) });
}

function handleTagDelete(req, res, tagId) {
  const session = requireUser(req);
  if (!assetStore.deleteTag(session.user_id, tagId)) fail(404, 'Tag not found.');
  return sendJSON(res, 200, { ok: true });
}

async function handleTagUpdate(req, res, tagId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) fail(400, 'Tag name is required.');
  if (name.length > 80) fail(400, 'Tag name is too long.');
  const tag = assetStore.updateTag(session.user_id, tagId, name);
  if (!tag) fail(404, 'Tag not found.');
  return sendJSON(res, 200, { tag });
}

async function handleAssetTag(req, res, assetId, tagId) {
  const session = requireUser(req);
  if (!assetStore.getAsset(session.user_id, assetId)) fail(404, 'Asset not found.');
  if (req.method === 'POST') {
    const body = await readJSON(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) fail(400, 'Tag name is required.');
    const tag = assetStore.addAssetTag(session.user_id, assetId, name);
    if (!tag) fail(400, 'Could not add tag.');
    return sendJSON(res, 200, { tag });
  }
  if (!assetStore.removeAssetTag(session.user_id, assetId, tagId)) fail(404, 'Tag not found.');
  return sendJSON(res, 200, { ok: true });
}

async function handleAssetUpdate(req, res, assetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  let asset;
  try {
    asset = assetStore.updateAsset(session.user_id, assetId, body);
  } catch (err) {
    fail(400, err.message);
  }
  if (!asset) fail(404, 'Asset not found.');
  return sendJSON(res, 200, { asset });
}

function handleAssetReviewGet(req, res, assetId) {
  const session = requireUser(req);
  const review = reviewStore.getAssetReview(session.user_id, assetId);
  if (!review) fail(404, 'Asset not found.');
  return sendJSON(res, 200, { review });
}

async function handleAssetReviewCreate(req, res, assetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const review = reviewStore.recordAssetReview(session.user_id, session, assetId, body);
    if (!review) fail(404, 'Asset not found.');
    return sendJSON(res, 201, { review });
  } catch (err) {
    if (err && err.status) fail(err.status, err.message, err.code);
    throw err;
  }
}

async function handleAssetChecklist(req, res, assetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const review = reviewStore.saveChecklist(session.user_id, session, assetId, body.items);
    if (!review) fail(404, 'Asset not found.');
    return sendJSON(res, 200, { review });
  } catch (err) {
    if (err && err.status) fail(err.status, err.message, err.code);
    throw err;
  }
}

async function handleAssetSafeCover(req, res, assetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const review = reviewStore.setSafeCover(session.user_id, session, assetId, typeof body.versionId === 'string' ? body.versionId : '');
    if (!review) fail(404, 'Asset not found.');
    return sendJSON(res, 200, { review });
  } catch (err) {
    if (err && err.status) fail(err.status, err.message, err.code);
    throw err;
  }
}

async function handleAssetPublication(req, res, assetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const review = reviewStore.recordPublication(session.user_id, session, assetId, body);
    if (!review) fail(404, 'Asset not found.');
    return sendJSON(res, 201, { review });
  } catch (err) {
    if (err && err.blockers) {
      return sendJSON(res, 409, {
        error: err.message,
        code: err.code || 'PUBLICATION_EVIDENCE_INCOMPLETE',
        blockers: err.blockers,
      });
    }
    if (err && err.status) fail(err.status, err.message, err.code);
    throw err;
  }
}

function handleAssetAudit(req, res, assetId) {
  const session = requireUser(req);
  const review = reviewStore.getAssetReview(session.user_id, assetId);
  if (!review) fail(404, 'Asset not found.');
  return sendJSON(res, 200, { audit: review.audit });
}

async function handlePromptReviewCreate(req, res, promptId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const review = reviewStore.recordPromptReview(session.user_id, session, promptId, body);
    if (!review) fail(404, 'Prompt draft not found.');
    return sendJSON(res, 201, { review });
  } catch (err) {
    if (err && err.status) fail(err.status, err.message, err.code);
    throw err;
  }
}

function handlePromptReviewGet(req, res, promptId) {
  const session = requireUser(req);
  const review = reviewStore.promptReview(session.user_id, promptId);
  if (!review) fail(404, 'Prompt draft not found.');
  return sendJSON(res, 200, { review });
}

function handleDuplicateGroups(req, res) {
  const session = requireUser(req);
  return sendJSON(res, 200, { groups: assetStore.listDuplicateGroups(session.user_id) });
}

function handleAssetSync(req, res) {
  requireUser(req);
  assetStore.syncFilesystem();
  return sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Story workspace APIs
// ---------------------------------------------------------------------------

function storyFail(err) {
  if (err && err.status) fail(err.status, err.message, err.code);
  fail(500, 'Could not update the story workspace.');
}

function storyProjectId(value) {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId) fail(400, 'Choose a project.');
  return projectId;
}

function storyTextField(value, label, max, { required = false } = {}) {
  const output = String(value === undefined || value === null ? '' : value).trim();
  if (required && !output) fail(400, `${label} is required.`);
  if (output.length > max) fail(400, `${label} is too long (max ${max} characters).`);
  return output;
}

function storyExclusions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(400, 'Exclusions must be an array.');
  if (value.length > 30) fail(400, 'Too many exclusions (max 30).');
  return value.map((item) => String(item || '').trim().slice(0, 300)).filter(Boolean);
}

function storyReferenceRoles(value) {
  const source = value && typeof value === 'object' ? value : {};
  const characterIds = Array.isArray(source.characterIds)
    ? source.characterIds.map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12)
    : [];
  return {
    characterIds,
    locationId: typeof source.locationId === 'string' ? source.locationId.trim().slice(0, 80) : '',
    styleId: typeof source.styleId === 'string' ? source.styleId.trim().slice(0, 80) : '',
  };
}

function handleStoryGet(req, res, projectId) {
  const session = requireUser(req);
  const story = storyStore.getStory(session.user_id, storyProjectId(projectId));
  if (!story) fail(404, 'Project not found.');
  const project = db.getProject(session.user_id, projectId);
  story.referenceSource = {
    name: project.title, idea: project.idea, characters: (project.characterReferences || []).map((item) => item.name),
    setting: story.worksheet.setting || story.brief.setting || '',
    referenceMaterial: project.referenceMaterial, characterReferences: project.characterReferences || [],
  };
  return sendJSON(res, 200, { story });
}

async function handleStoryBrief(req, res, projectId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const brief = storyStore.updateBrief(session.user_id, storyProjectId(projectId), {
      title: storyTextField(body.title, 'Story title', 200, { required: true }),
      logline: storyTextField(body.logline, 'Logline', 500),
      premise: storyTextField(body.premise, 'Premise', 5000),
      tone: storyTextField(body.tone, 'Tone', 200),
      genre: storyTextField(body.genre, 'Genre', 200),
      audience: storyTextField(body.audience, 'Audience', 200),
      setting: storyTextField(body.setting, 'Setting summary', 3000),
    });
    if (!brief) fail(404, 'Project not found.');
    return sendJSON(res, 200, { brief });
  } catch (err) {
    storyFail(err);
  }
}

function handleStoryCharacterCreate(req, res, projectId) {
  const session = requireUser(req);
  return readJSON(req).then((body) => {
    try {
      const character = storyStore.createCharacter(session.user_id, storyProjectId(projectId), {
        name: storyTextField(body.name, 'Character name', 120, { required: true }),
        gender: storyTextField(body.gender, 'Gender', 40),
        age: storyTextField(body.age, 'Age', 80),
        appearance: storyTextField(body.appearance, 'Appearance', 5000),
        wardrobe: storyTextField(body.wardrobe, 'Wardrobe', 5000),
        continuityNotes: storyTextField(body.continuityNotes, 'Continuity notes', 5000),
        approved: body.approved === true,
      });
      if (!character) fail(404, 'Project not found.');
      return sendJSON(res, 201, { character });
    } catch (err) {
      storyFail(err);
    }
  });
}

async function handleStoryCharacterUpdate(req, res, characterId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const character = storyStore.updateCharacter(session.user_id, characterId, {
      name: body.name !== undefined ? storyTextField(body.name, 'Character name', 120, { required: true }) : undefined,
      gender: body.gender !== undefined ? storyTextField(body.gender, 'Gender', 40) : undefined,
      age: body.age !== undefined ? storyTextField(body.age, 'Age', 80) : undefined,
      appearance: body.appearance !== undefined ? storyTextField(body.appearance, 'Appearance', 5000) : undefined,
      wardrobe: body.wardrobe !== undefined ? storyTextField(body.wardrobe, 'Wardrobe', 5000) : undefined,
      continuityNotes: body.continuityNotes !== undefined ? storyTextField(body.continuityNotes, 'Continuity notes', 5000) : undefined,
      approved: body.approved !== undefined ? body.approved === true : undefined,
    });
    if (!character) fail(404, 'Character not found.');
    return sendJSON(res, 200, { character });
  } catch (err) {
    storyFail(err);
  }
}

function handleStoryCharacterDelete(req, res, characterId) {
  const session = requireUser(req);
  if (!storyStore.deleteCharacter(session.user_id, characterId)) fail(404, 'Character not found.');
  return sendJSON(res, 200, { ok: true });
}

function handleStoryLocationCreate(req, res, projectId) {
  const session = requireUser(req);
  return readJSON(req).then((body) => {
    try {
      const location = storyStore.createLocation(session.user_id, storyProjectId(projectId), {
        name: storyTextField(body.name, 'Location name', 200, { required: true }),
        description: storyTextField(body.description, 'Description', 5000),
        lighting: storyTextField(body.lighting, 'Lighting', 2000),
        continuityNotes: storyTextField(body.continuityNotes, 'Continuity notes', 5000),
        approved: body.approved === true,
      });
      if (!location) fail(404, 'Project not found.');
      return sendJSON(res, 201, { location });
    } catch (err) {
      storyFail(err);
    }
  });
}

async function handleStoryLocationUpdate(req, res, locationId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const location = storyStore.updateLocation(session.user_id, locationId, {
      name: body.name !== undefined ? storyTextField(body.name, 'Location name', 200, { required: true }) : undefined,
      description: body.description !== undefined ? storyTextField(body.description, 'Description', 5000) : undefined,
      lighting: body.lighting !== undefined ? storyTextField(body.lighting, 'Lighting', 2000) : undefined,
      continuityNotes: body.continuityNotes !== undefined ? storyTextField(body.continuityNotes, 'Continuity notes', 5000) : undefined,
      approved: body.approved !== undefined ? body.approved === true : undefined,
    });
    if (!location) fail(404, 'Location not found.');
    return sendJSON(res, 200, { location });
  } catch (err) {
    storyFail(err);
  }
}

function handleStoryLocationDelete(req, res, locationId) {
  const session = requireUser(req);
  if (!storyStore.deleteLocation(session.user_id, locationId)) fail(404, 'Location not found.');
  return sendJSON(res, 200, { ok: true });
}

function handleStoryStyleCreate(req, res, projectId) {
  const session = requireUser(req);
  return readJSON(req).then((body) => {
    try {
      const style = storyStore.createStyle(session.user_id, storyProjectId(projectId), {
        name: storyTextField(body.name, 'Style name', 200, { required: true }),
        description: storyTextField(body.description, 'Description', 5000),
        guidance: storyTextField(body.guidance, 'Visual guidance', 5000),
        exclusions: storyExclusions(body.exclusions),
        approved: body.approved === true,
      });
      if (!style) fail(404, 'Project not found.');
      return sendJSON(res, 201, { style });
    } catch (err) {
      storyFail(err);
    }
  });
}

async function handleStoryStyleUpdate(req, res, styleId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const style = storyStore.updateStyle(session.user_id, styleId, {
      name: body.name !== undefined ? storyTextField(body.name, 'Style name', 200, { required: true }) : undefined,
      description: body.description !== undefined ? storyTextField(body.description, 'Description', 5000) : undefined,
      guidance: body.guidance !== undefined ? storyTextField(body.guidance, 'Visual guidance', 5000) : undefined,
      exclusions: body.exclusions !== undefined ? storyExclusions(body.exclusions) : undefined,
      approved: body.approved !== undefined ? body.approved === true : undefined,
    });
    if (!style) fail(404, 'Style not found.');
    return sendJSON(res, 200, { style });
  } catch (err) {
    storyFail(err);
  }
}

function handleStoryStyleDelete(req, res, styleId) {
  const session = requireUser(req);
  if (!storyStore.deleteStyle(session.user_id, styleId)) fail(404, 'Style not found.');
  return sendJSON(res, 200, { ok: true });
}

async function handleStoryScenes(req, res, projectId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const scenes = storyStore.saveScenes(session.user_id, storyProjectId(projectId), body.scenes);
    if (!scenes) fail(404, 'Project not found.');
    return sendJSON(res, 200, { scenes });
  } catch (err) {
    storyFail(err);
  }
}

async function handleStoryPromptCreate(req, res, projectId, sceneId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const textModel = body.textModel === undefined
    ? (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL)
    : String(body.textModel || '').trim();
  const imageModel = body.imageModel === undefined
    ? (IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL)
    : String(body.imageModel || '').trim();
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel) || IMAGE_MODEL_SIZES.get(DEFAULT_IMAGE_MODEL);
  const imageSize = body.imageSize === undefined ? allowedSizes[0] : String(body.imageSize || '').trim();
  const temperature = body.temperature === undefined || body.temperature === '' ? null : Number(body.temperature);
  const maxTokens = body.maxTokens === undefined || body.maxTokens === '' ? null : Number(body.maxTokens);

  if (!TEXT_MODELS.has(textModel)) fail(400, 'Unsupported DeepSeek model.');
  if (!IMAGE_MODEL_SIZES.has(imageModel)) fail(400, 'Unsupported image model.');
  if (!allowedSizes.includes(imageSize)) fail(400, 'Invalid image size for this model.');
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    fail(400, 'Temperature must be between 0 and 2.');
  }
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 100000)) {
    fail(400, 'Max tokens must be an integer between 1 and 100,000.');
  }

  try {
    const prompt = storyStore.createPrompt(
      session.user_id,
      storyProjectId(projectId),
      sceneId,
      {
        text: storyTextField(body.text, 'Prompt text', 30000, { required: true }),
        exclusions: storyExclusions(body.exclusions),
        referenceRoles: storyReferenceRoles(body.referenceRoles),
        textModel,
        temperature,
        maxTokens,
        imageModel,
        imageSize,
        source: 'manual',
      }
    );
    if (!prompt) fail(404, 'Project not found.');
    return sendJSON(res, 201, { prompt });
  } catch (err) {
    storyFail(err);
  }
}

function handleStoryPromptPromote(req, res, promptId) {
  const session = requireUser(req);
  try {
    const prompt = storyStore.updatePromptStatus(session.user_id, promptId, 'final');
    if (!prompt) fail(404, 'Prompt draft not found.');
    return sendJSON(res, 200, { prompt });
  } catch (err) {
    storyFail(err);
  }
}

async function handleStorySheetGenerate(req, res, projectId, characterId) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.byteplus_api_key_enc) {
    fail(409, 'No BytePlus API key is saved for your account. Add one in Settings.', 'NO_IMAGEGEN_KEY');
  }
  const apiKey = security.decryptApiKey(session.byteplus_api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved BytePlus API key could not be read. Please save it again.', 'IMAGEGEN_KEY_UNREADABLE');
  }

  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel);
  const defaultSize = allowedSizes.includes('2K') ? '2K' : allowedSizes[0];
  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : defaultSize;
  if (!allowedSizes.includes(size)) {
    fail(400, `Invalid image size for this model. Choose ${allowedSizes.join(', ')}.`);
  }

  const project = db.getProject(session.user_id, storyProjectId(projectId));
  if (!project) fail(404, 'Project not found.');

  const story = storyStore.getStory(session.user_id, project.id);
  if (!story) fail(404, 'Project not found.');
  const character = (story.characters || []).find((item) => item.id === characterId);
  if (!character) fail(404, 'Character not found.');
  const source = (project.characterReferences || []).find((item) => item.name === character.name);
  const reference = source && String(source.referenceMaterial || '').trim();
  if (!reference) fail(409, 'This character needs a saved Character Reference in Reference Stage.', 'CHARACTER_REFERENCE_REQUIRED');
  const prompt = buildCharacterSheetPrompt(character, reference);
  let referenceImage;
  try {
    referenceImage = `data:image/png;base64,${fs.readFileSync(CHARACTER_SHEET_LAYOUT_REFERENCE_PATH).toString('base64')}`;
  } catch (err) {
    fail(500, `Could not load the character sheet layout reference: ${err.message}`, 'IMAGEGEN_REFERENCE_MISSING');
  }
  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt, referenceImage);

  const file = `${crypto.randomUUID()}.${generated.extension}`;
  const directory = path.join(IMAGE_DIR, project.id);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), generated.buffer);
  } catch (err) {
    fail(500, `Could not save the character sheet image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  const sheet = storyStore.createCharacterSheet(session.user_id, project.id, characterId, {
    file,
    mime: generated.mime,
    size: generated.size,
    prompt,
    imageModel,
    imageSize: size,
    source: 'generated',
  });

  return sendJSON(res, 201, {
    sheet,
    story: storyStore.getStory(session.user_id, project.id),
    url: `/api/story/sheet-image/${encodeURIComponent(project.id)}/${encodeURIComponent(file)}`,
  });
}

async function handleStorySheetImage(req, res, projectId, file) {
  const session = requireUser(req);
  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Image not found.');
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|webp)$/i.test(file)) fail(404, 'Image not found.');
  const sheet = storyStore.characterSheetByFile(projectId, file);
  if (!sheet) fail(404, 'Image not found.');

  const fullPath = path.join(IMAGE_DIR, projectId, file);
  let data;
  try {
    data = await fs.promises.readFile(fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': sheet.mime || 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function handleStorySheetPromote(req, res, sheetId) {
  const session = requireUser(req);
  try {
    const sheet = storyStore.updateCharacterSheetStatus(session.user_id, sheetId, 'final');
    if (!sheet) fail(404, 'Character sheet not found.');
    return sendJSON(res, 200, { sheet });
  } catch (err) {
    storyFail(err);
  }
}

// ---------------------------------------------------------------------------
// Character maker
//
// Standalone characters owned by one user and attached to no project. Each
// generation appends a version; promoting one is this user's own choice and
// never marks anything reviewed or publication-ready.
// ---------------------------------------------------------------------------
const CHARACTER_IMAGE_SUBDIR = 'characters';

function characterFail(err) {
  if (err && err.status) fail(err.status, err.message, err.code);
  fail(500, 'Could not update this character.');
}

function characterImageUrl(characterId, file) {
  return `/api/characters/${encodeURIComponent(characterId)}/image/${encodeURIComponent(file)}`;
}

function withCharacterUrls(character) {
  if (!character) return character;
  return {
    ...character,
    versions: (character.versions || []).map((version) => ({
      ...version,
      url: characterImageUrl(character.id, version.file),
    })),
  };
}

function characterPayload(userId, projectId = '') {
  return { characters: characterStore.list(userId, projectId).map(withCharacterUrls) };
}

// A project scope is optional: no projectId means the standalone Character
// maker tab, and a projectId is only accepted when this user owns it.
function characterProjectScope(session, projectId) {
  const scoped = String(projectId === undefined || projectId === null ? '' : projectId).trim();
  if (!scoped) return '';
  if (!db.getProject(session.user_id, scoped)) fail(404, 'Project not found.');
  return scoped;
}

function handleCharacterList(req, res) {
  const session = requireUser(req);
  const params = new URL(req.url, 'http://localhost').searchParams;
  const projectId = characterProjectScope(session, params.get('projectId'));
  return sendJSON(res, 200, characterPayload(session.user_id, projectId));
}

async function handleCharacterCreate(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const projectId = characterProjectScope(session, body && body.projectId);
    const character = characterStore.create(session.user_id, { ...body, projectId });
    return sendJSON(res, 201, { character: withCharacterUrls(character) });
  } catch (err) {
    characterFail(err);
  }
}

async function handleCharacterUpdate(req, res, characterId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const character = characterStore.update(session.user_id, characterId, body);
    if (!character) fail(404, 'Character not found.');
    return sendJSON(res, 200, { character: withCharacterUrls(character) });
  } catch (err) {
    characterFail(err);
  }
}

function handleCharacterDelete(req, res, characterId) {
  const session = requireUser(req);
  const removed = characterStore.remove(session.user_id, characterId);
  if (!removed) fail(404, 'Character not found.');
  const directory = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, removed.id);
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (err) {
    console.error(`  Could not remove character images for ${removed.id}: ${err.message}`);
  }
  // Answer with the list for the scope the deleted character belonged to, so
  // the caller never receives the other tab's characters.
  return sendJSON(res, 200, { removed: removed.id, ...characterPayload(session.user_id, removed.projectId) });
}

async function handleCharacterGenerate(req, res, characterId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const mode = body && body.mode === 'sheet' ? 'sheet' : body && body.mode === 'portrait' ? 'portrait' : '';
  if (!mode) fail(400, 'Choose a portrait or a character sheet.');
  const character = characterStore.get(session.user_id, characterId);
  if (!character) fail(404, 'Character not found.');

  if (!session.byteplus_api_key_enc) {
    fail(409, 'No BytePlus API key is saved for your account. Add one in Settings.', 'NO_IMAGEGEN_KEY');
  }
  const apiKey = security.decryptApiKey(session.byteplus_api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved BytePlus API key could not be read. Please save it again.', 'IMAGEGEN_KEY_UNREADABLE');
  }

  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel);
  const defaultSize = allowedSizes.includes('2K') ? '2K' : allowedSizes[0];
  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : defaultSize;
  if (!allowedSizes.includes(size)) {
    fail(400, `Invalid image size for this model. Choose ${allowedSizes.join(', ')}.`);
  }

  const description = String(character.description || '').trim();
  if (!description) {
    fail(409, 'Describe this character before generating an image.', 'CHARACTER_DESCRIPTION_REQUIRED');
  }

  const referenceImages = [];
  let prompt;
  if (mode === 'sheet') {
    prompt = buildCharacterSheetPrompt(character, description);
    try {
      referenceImages.push(
        `data:image/png;base64,${fs.readFileSync(CHARACTER_SHEET_LAYOUT_REFERENCE_PATH).toString('base64')}`
      );
    } catch (err) {
      fail(500, `Could not load the character sheet layout reference: ${err.message}`, 'IMAGEGEN_REFERENCE_MISSING');
    }
  } else {
    prompt = buildCharacterPortraitPrompt(character, description);
  }

  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt, referenceImages);

  const file = `${crypto.randomUUID()}.${generated.extension}`;
  const directory = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, character.id);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), generated.buffer);
  } catch (err) {
    fail(500, `Could not save the character image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  let version;
  try {
    version = characterStore.addVersion(session.user_id, character.id, {
      mode,
      file,
      mime: generated.mime,
      size: generated.size,
      prompt,
      imageModel,
      imageSize: size,
    });
  } catch (err) {
    characterFail(err);
  }
  const updated = characterStore.get(session.user_id, character.id);
  return sendJSON(res, 201, {
    character: withCharacterUrls(updated),
    version: { ...version, url: characterImageUrl(character.id, version.file) },
  });
}

function handleCharacterVersionPromote(req, res, characterId, versionId) {
  const session = requireUser(req);
  const character = characterStore.promoteVersion(session.user_id, characterId, versionId);
  if (!character) fail(404, 'Character or version not found.');
  return sendJSON(res, 200, { character: withCharacterUrls(character) });
}

// Copy an existing version (usually a standalone Character maker final) into
// another character as a new version, and mark it final. The bytes are copied,
// so the two characters never share a file and deleting either is safe.
async function handleCharacterVersionImport(req, res, characterId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  const fromVersionId = String((body && body.fromVersionId) || '').trim();
  if (!fromVersionId) fail(400, 'Choose a version to copy.');

  const target = characterStore.get(session.user_id, characterId);
  if (!target) fail(404, 'Character not found.');
  const source = characterStore.versionForUser(session.user_id, fromVersionId);
  if (!source) fail(404, 'Version not found.');

  const sourcePath = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, source.characterId, source.file);
  let data;
  try {
    data = await fs.promises.readFile(sourcePath);
  } catch (_) {
    fail(404, 'The stored image for that version could not be read.');
  }

  const extension = path.extname(source.file).replace('.', '') || 'png';
  const file = `${crypto.randomUUID()}.${extension}`;
  const directory = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, target.id);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), data);
  } catch (err) {
    fail(500, `Could not save the copied image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  try {
    const created = characterStore.addVersion(session.user_id, target.id, {
      mode: source.mode,
      file,
      mime: source.mime,
      size: source.size,
      prompt: source.prompt,
      imageModel: source.imageModel,
      imageSize: source.imageSize,
    });
    characterStore.promoteVersion(session.user_id, target.id, created.id);
  } catch (err) {
    characterFail(err);
  }

  const updated = characterStore.get(session.user_id, target.id);
  const copied = (updated.versions || []).find((item) => item.file === file);
  return sendJSON(res, 201, {
    character: withCharacterUrls(updated),
    version: copied ? { ...copied, url: characterImageUrl(target.id, copied.file) } : null,
  });
}

async function handleCharacterImage(req, res, characterId, file) {
  const session = requireUser(req);
  const version = characterStore.versionByFile(session.user_id, characterId, file);
  if (!version) fail(404, 'Image not found.');

  const fullPath = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, characterId, file);
  let data;
  try {
    data = await fs.promises.readFile(fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': version.mime || 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Standalone image generator
//
// Images belong to no project. Each generated image is also registered in the
// Library as a project-less asset, so it gets the normal review checklist and
// can be filed into a project later from the Library.
// ---------------------------------------------------------------------------
const GENERATION_IMAGE_SUBDIR = 'generations';
const GENERATION_REFERENCE_SUBDIR = 'generations/references';
const MAX_GENERATION_REFERENCES = 10;
const MAX_REFERENCE_TOTAL_BYTES = 24 * 1024 * 1024;

function generationFail(err) {
  if (err && err.status) fail(err.status, err.message, err.code);
  fail(500, 'Could not update this generation.');
}

function generationImageUrl(generationId, file) {
  return `/api/generations/${encodeURIComponent(generationId)}/image/${encodeURIComponent(file)}`;
}

function withGenerationUrl(generation) {
  if (!generation) return generation;
  return { ...generation, url: generationImageUrl(generation.id, generation.file) };
}

function generationReferenceUrl(reference) {
  return `/api/generation-references/${encodeURIComponent(reference.id)}/image`;
}

function withReferenceUrl(reference) {
  return reference ? { ...reference, url: generationReferenceUrl(reference) } : reference;
}

function generationPayload(userId) {
  return {
    generations: standaloneStore.list(userId).map(withGenerationUrl),
    presets: standaloneStore.listPresets(userId),
    references: standaloneStore.listReferences(userId).map(withReferenceUrl),
    limits: { maxReferences: MAX_GENERATION_REFERENCES },
  };
}

// A Library asset title from the prompt's first line, so the Library entry is
// recognisable without opening it.
function generationTitle(prompt) {
  const firstLine = String(prompt || '').split('\n')[0].trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
}

// Turn the client's reference descriptors into the data URLs BytePlus accepts.
// Ownership is re-checked for every source here, so a client can never name an
// image it does not own.
async function resolveGenerationReferences(session, input) {
  const list = Array.isArray(input) ? input.slice(0, MAX_GENERATION_REFERENCES) : [];
  const images = [];
  const saved = [];
  let total = 0;

  for (const item of list) {
    const kind = String((item && item.kind) || '');
    let fullPath = '';
    let mime = '';
    let label = '';

    if (kind === 'library') {
      const relativePath = String((item && item.path) || '');
      if (!relativePath) continue;
      const resolved = await resolveLibraryFile(session.user_id, relativePath);
      fullPath = resolved.fullPath;
      mime = resolved.mime || 'image/png';
      label = relativePath.split('/').pop();
      saved.push({ kind, path: relativePath, name: label });
    } else if (kind === 'character') {
      const characterId = String((item && item.characterId) || '');
      const file = String((item && item.file) || '');
      const version = characterId && file
        ? characterStore.versionByFile(session.user_id, characterId, file)
        : null;
      if (!version) fail(404, 'Character image not found.');
      const character = characterStore.get(session.user_id, characterId);
      fullPath = path.join(IMAGE_DIR, CHARACTER_IMAGE_SUBDIR, characterId, file);
      mime = version.mime || 'image/png';
      label = `${(character && character.name) || 'Character'} (${version.mode === 'sheet' ? 'sheet' : 'portrait'})`;
      saved.push({ kind, characterId, file, name: label });
    } else if (kind === 'upload') {
      const reference = standaloneStore.referenceForUser(session.user_id, String((item && item.id) || ''));
      if (!reference) fail(404, 'Reference image not found.');
      fullPath = path.join(IMAGE_DIR, GENERATION_REFERENCE_SUBDIR, reference.id, reference.file);
      mime = reference.mime || 'image/png';
      label = reference.name || reference.file;
      saved.push({ kind, id: reference.id, name: label });
    } else {
      continue;
    }

    let data;
    try {
      data = await fs.promises.readFile(fullPath);
    } catch (_) {
      fail(404, `Reference image could not be read: ${label || 'unknown'}.`);
    }
    total += data.length;
    if (total > MAX_REFERENCE_TOTAL_BYTES) {
      fail(400, 'Those reference images are too large together. Use fewer or smaller images.');
    }
    images.push(`data:${mime};base64,${data.toString('base64')}`);
    if (saved.length && saved[saved.length - 1].name !== label) saved[saved.length - 1].name = label;
  }

  return { images, saved };
}

function handleGenerationList(req, res) {
  const session = requireUser(req);
  res.setHeader('Cache-Control', 'no-store');
  return sendJSON(res, 200, generationPayload(session.user_id));
}

async function handleGenerationCreate(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.byteplus_api_key_enc) {
    fail(409, 'No BytePlus API key is saved for your account. Add one in Settings.', 'NO_IMAGEGEN_KEY');
  }
  const apiKey = security.decryptApiKey(session.byteplus_api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved BytePlus API key could not be read. Please save it again.', 'IMAGEGEN_KEY_UNREADABLE');
  }

  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  const allowedSizes = IMAGE_MODEL_SIZES.get(imageModel);
  const defaultSize = allowedSizes.includes('2K') ? '2K' : allowedSizes[0];

  let prompt;
  let composition;
  try {
    ({ prompt, composition } = prepareImagePrompt(body.prompt, body.composition));
  } catch (err) {
    generationFail(err);
  }
  const size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : defaultSize;
  if (!allowedSizes.includes(size)) {
    fail(400, `Invalid image size for this model. Choose ${allowedSizes.join(', ')}.`);
  }

  const { images, saved } = await resolveGenerationReferences(session, body.references);
  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt, images);

  const generationId = crypto.randomUUID();
  const file = `${crypto.randomUUID()}.${generated.extension}`;
  const relativePath = `${GENERATION_IMAGE_SUBDIR}/${generationId}/${file}`;
  const directory = path.join(IMAGE_DIR, GENERATION_IMAGE_SUBDIR, generationId);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), generated.buffer);
  } catch (err) {
    fail(500, `Could not save the generated image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  // Register the image in the Library as a project-less asset.
  let recorded = null;
  try {
    recorded = assetStore.recordImage({
      userId: session.user_id,
      projectId: null,
      sceneId: null,
      relativePath,
      source: 'generated',
      model: imageModel,
      prompt,
      title: generationTitle(composition ? composition.panels[0] : prompt),
    });
  } catch (_) {
    recorded = null;
  }

  let generation;
  try {
    generation = standaloneStore.create(session.user_id, {
      id: generationId,
      prompt,
      imageModel,
      imageSize: size,
      file,
      mime: generated.mime,
      bytes: generated.buffer.length,
      assetId: recorded ? recorded.assetId : '',
      assetVersionId: recorded ? recorded.versionId : '',
      references: saved,
      composition,
    });
  } catch (err) {
    generationFail(err);
  }

  return sendJSON(res, 201, {
    generation: withGenerationUrl(generation),
    libraryWarning: recorded
      ? ''
      : 'The image was generated, but it could not be added to the Library. It is still saved in this tab.',
  });
}

function handleGenerationDelete(req, res, generationId) {
  const session = requireUser(req);
  const generation = standaloneStore.get(session.user_id, generationId);
  if (!generation) fail(404, 'Generation not found.');

  // Never destroy review work or a project's asset from here.
  if (generation.assetId) {
    const asset = assetStore.getAsset(session.user_id, generation.assetId);
    if (asset && asset.metadata && asset.metadata.projectId) {
      fail(409, 'This image has been filed into a project. Delete it from the Library instead.', 'ASSET_IN_PROJECT');
    }
    const review = reviewStore.getAssetReview(session.user_id, generation.assetId);
    if (review && (review.review || review.publication)) {
      fail(409, 'This image has been reviewed in the Library. Clear its review there before deleting it.', 'REVIEWED_ASSET');
    }
  }

  const removed = standaloneStore.remove(session.user_id, generation.id);
  try {
    fs.rmSync(path.join(IMAGE_DIR, GENERATION_IMAGE_SUBDIR, generation.id), { recursive: true, force: true });
  } catch (_) {
    // The record is gone; a leftover file is harmless and stays out of the Library.
  }
  if (generation.assetId) {
    try {
      assetStore.removeAsset(session.user_id, generation.assetId);
    } catch (_) {
      // The generation is already removed; a stale Library row is not fatal.
    }
  }

  return sendJSON(res, 200, { removed: removed.id, ...generationPayload(session.user_id) });
}

async function handleGenerationImage(req, res, generationId, file) {
  const session = requireUser(req);
  const generation = standaloneStore.get(session.user_id, generationId);
  if (!generation || generation.file !== file) fail(404, 'Image not found.');

  const fullPath = path.join(IMAGE_DIR, GENERATION_IMAGE_SUBDIR, generation.id, generation.file);
  let data;
  try {
    data = await fs.promises.readFile(fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': generation.mime || 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// Uploaded reference images live under a UUID folder, which the Library
// filesystem scan skips, so they never become assets of their own.
async function handleGenerationReferenceUpload(req, res) {
  const session = requireUser(req);
  const requestUrl = new URL(req.url, 'http://localhost');
  const name = String(requestUrl.searchParams.get('name') || '').trim().slice(0, 200);

  const buffer = await readBinary(req, MAX_UPLOAD_BYTES);
  if (!buffer || !buffer.length) fail(400, 'The uploaded image is empty.');
  const type = detectImageType(buffer);
  if (!type) fail(400, 'Upload a PNG, JPEG, or WebP image.');

  const referenceId = crypto.randomUUID();
  const file = `${crypto.randomUUID()}.${type.extension}`;
  const directory = path.join(IMAGE_DIR, GENERATION_REFERENCE_SUBDIR, referenceId);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), buffer);
  } catch (err) {
    fail(500, `Could not save the reference image: ${err.message}`, 'IMAGE_UPLOAD_SAVE_FAILED');
  }

  let reference;
  try {
    reference = standaloneStore.addReference(session.user_id, {
      id: referenceId,
      file,
      mime: type.mime,
      bytes: buffer.length,
      name: name || `Reference ${new Date().toISOString().slice(0, 10)}`,
    });
  } catch (err) {
    generationFail(err);
  }
  return sendJSON(res, 201, { reference: withReferenceUrl(reference) });
}

function handleGenerationReferenceImage(req, res, referenceId) {
  const session = requireUser(req);
  const reference = standaloneStore.referenceForUser(session.user_id, referenceId);
  if (!reference) fail(404, 'Image not found.');

  const fullPath = path.join(IMAGE_DIR, GENERATION_REFERENCE_SUBDIR, reference.id, reference.file);
  let data;
  try {
    data = fs.readFileSync(fullPath);
  } catch (_) {
    fail(404, 'Image not found.');
  }

  res.writeHead(200, {
    'Content-Type': reference.mime || 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function handleGenerationReferenceDelete(req, res, referenceId) {
  const session = requireUser(req);
  const removed = standaloneStore.removeReference(session.user_id, referenceId);
  if (!removed) fail(404, 'Reference image not found.');
  try {
    fs.rmSync(path.join(IMAGE_DIR, GENERATION_REFERENCE_SUBDIR, removed.id), { recursive: true, force: true });
  } catch (_) {
    // Nothing else refers to this file once the row is gone.
  }
  return sendJSON(res, 200, { removed: removed.id, ...generationPayload(session.user_id) });
}

function handleGenerationPresetList(req, res) {
  const session = requireUser(req);
  return sendJSON(res, 200, { presets: standaloneStore.listPresets(session.user_id) });
}

async function handleGenerationPresetCreate(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const preset = standaloneStore.createPreset(session.user_id, body);
    return sendJSON(res, 201, { preset });
  } catch (err) {
    generationFail(err);
  }
}

async function handleGenerationPresetUpdate(req, res, presetId) {
  const session = requireUser(req);
  const body = await readJSON(req);
  try {
    const preset = standaloneStore.updatePreset(session.user_id, presetId, body);
    if (!preset) fail(404, 'Preset not found.');
    return sendJSON(res, 200, { preset });
  } catch (err) {
    generationFail(err);
  }
}

function handleGenerationPresetDelete(req, res, presetId) {
  const session = requireUser(req);
  const removed = standaloneStore.removePreset(session.user_id, presetId);
  if (!removed) fail(404, 'Preset not found.');
  return sendJSON(res, 200, { removed: removed.id, presets: standaloneStore.listPresets(session.user_id) });
}

// ---------------------------------------------------------------------------
// Story Studio progress
//
// One overview for one story: what is finished, what is waiting for a human
// decision, and what the next action is. The six steps mirror the Story Studio
// navigation, and each status is derived from the data that screen edits — the
// progress is never a separately stored flag that could drift from the work.
// ---------------------------------------------------------------------------
const STUDIO_STEP_LABELS = {
  idea: 'Idea',
  references: 'References',
  cast: 'Characters & Locations',
  scenes: 'Scenes',
  generate: 'Generate',
  review: 'Review',
};

const STUDIO_STEP_SCREENS = {
  idea: 'studio-idea',
  references: 'studio-references',
  cast: 'studio-cast',
  scenes: 'studio-scenes',
  generate: 'studio-generate',
  review: 'studio-review',
};

function studioStep(id, status, detail, action) {
  return {
    id,
    label: STUDIO_STEP_LABELS[id],
    screen: STUDIO_STEP_SCREENS[id],
    status,          // 'done' | 'attention' (a decision is waiting) | 'todo'
    detail,
    action,
  };
}

function handleStudioProgress(req, res, projectIdValue) {
  const session = requireUser(req);
  const projectId = storyProjectId(projectIdValue);
  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.', 'PROJECT_NOT_FOUND');

  const story = storyStore.getStory(session.user_id, projectId) || {};
  const brief = story.brief || {};
  const characters = Array.isArray(story.characters) ? story.characters : [];
  const locations = Array.isArray(story.locations) ? story.locations : [];
  const styles = Array.isArray(story.styles) ? story.styles : [];
  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const drafts = Array.isArray(story.prompts) ? story.prompts : [];
  const warnings = Array.isArray(story.warnings) ? story.warnings : [];

  const task = generationStore.getTask(session.user_id, projectId);
  const taskState = task && task.state ? task.state : {};
  const promptCount = taskState.promptCount || 0;
  const approvedCount = taskState.approvedCount || 0;
  const imageCount = taskState.imageCount || 0;
  const openFlagCount = taskState.openFlagCount || 0;

  const assets = reviewStore.enrichAssets(session.user_id, assetStore.listAssets(session.user_id, { projectId }));
  // enrichAssets reports 'NOT REVIEWED' rather than null when there is no review
  // record, so an unreviewed asset is one whose decision is that placeholder.
  const hasReview = (asset) => Boolean(asset.reviewDecision) && asset.reviewDecision !== 'NOT REVIEWED';
  const reviewedAssets = assets.filter(hasReview).length;
  const approvedAssets = assets.filter((asset) => asset.reviewDecision === 'APPROVED').length;
  const publishedAssets = assets.filter((asset) => asset.publicationDecision === true).length;

  const steps = [];
  const push = (id, status, detail, action) => steps.push(studioStep(id, status, detail, action));

  // 1 · Idea — the idea and the brief the whole story grows from.
  const hasIdea = Boolean(String(project.idea || '').trim() || String(project.description || '').trim());
  const briefFilled = Boolean(String(brief.title || '').trim() && String(brief.premise || '').trim());
  push(
    'idea',
    hasIdea || briefFilled ? 'done' : 'todo',
    hasIdea || briefFilled
      ? (briefFilled ? 'Idea and brief written' : 'Idea written, the brief is still empty')
      : 'No idea written yet',
    'Write the idea and the brief for this story'
  );

  // 2 · References — the shared material every image prompt is built from.
  const hasMaterial = Boolean(String(project.referenceMaterial || '').trim());
  const characterReferences = Array.isArray(project.characterReferences) ? project.characterReferences.length : 0;
  push(
    'references',
    hasMaterial && characterReferences > 0 ? 'done' : 'todo',
    `Reference material ${hasMaterial ? 'saved' : 'missing'} · ${characterReferences} character reference${characterReferences === 1 ? '' : 's'}`,
    hasMaterial
      ? 'Add the character references on the Reference screen'
      : 'Generate the reference material on the Reference screen'
  );

  // 3 · Characters & Locations — the cast and the places, each approved by hand.
  const unapprovedCast = characters.filter((item) => !item.approved).length
    + locations.filter((item) => !item.approved).length
    + styles.filter((item) => !item.approved).length;
  push(
    'cast',
    unapprovedCast > 0 ? 'attention' : (characters.length && locations.length ? 'done' : 'todo'),
    `${characters.length} character${characters.length === 1 ? '' : 's'} · ${locations.length} location${locations.length === 1 ? '' : 's'} · ${styles.length} style${styles.length === 1 ? '' : 's'}`
      + (unapprovedCast ? ` · ${unapprovedCast} waiting for approval` : ''),
    unapprovedCast
      ? `Approve ${unapprovedCast} character, location, or style${unapprovedCast === 1 ? '' : 's'}`
      : 'Add the characters, locations, and style references'
  );

  // 4 · Scenes — the scene outline, its links, and the prompt drafts.
  const unlinkedScenes = scenes.filter((scene) => !scene.locationId || !(scene.characterIds || []).length).length;
  const draftPrompts = drafts.filter((prompt) => prompt.status !== 'final').length;
  push(
    'scenes',
    draftPrompts > 0 ? 'attention' : (scenes.length && !unlinkedScenes ? 'done' : 'todo'),
    `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`
      + (unlinkedScenes ? ` · ${unlinkedScenes} without an approved location and cast` : '')
      + (draftPrompts ? ` · ${draftPrompts} prompt draft${draftPrompts === 1 ? '' : 's'} not final` : '')
      + (warnings.length ? ` · ${warnings.length} continuity warning${warnings.length === 1 ? '' : 's'}` : ''),
    draftPrompts
      ? `Promote ${draftPrompts} prompt draft${draftPrompts === 1 ? '' : 's'} to final`
      : 'Write the scenes and link each one to an approved location and cast'
  );

  // 5 · Generate — the image prompts, then the images themselves.
  const allApproved = promptCount > 0 && approvedCount >= promptCount;
  push(
    'generate',
    promptCount > 0 && !allApproved ? 'attention' : (taskState.images ? 'done' : 'todo'),
    promptCount === 0
      ? 'No image prompts built yet'
      : `${promptCount} prompt${promptCount === 1 ? '' : 's'} · ${approvedCount} approved · ${imageCount} image${imageCount === 1 ? '' : 's'} rendered`,
    promptCount === 0
      ? 'Build the image prompts'
      : !allApproved
        ? `Approve ${promptCount - approvedCount} image prompt${promptCount - approvedCount === 1 ? '' : 's'}`
        : 'Run image generation for the remaining images'
  );

  // 6 · Review — the prompt review and the review state of this story's images.
  const unreviewedAssets = assets.length - reviewedAssets;
  const reviewAttention = openFlagCount + unreviewedAssets;
  push(
    'review',
    reviewAttention > 0 ? 'attention' : (assets.length && reviewedAssets === assets.length && taskState.review ? 'done' : 'todo'),
    assets.length === 0
      ? (promptCount ? `${openFlagCount} open prompt flag${openFlagCount === 1 ? '' : 's'} · no images filed into this story yet` : 'Nothing to review yet')
      : `${reviewedAssets} of ${assets.length} images reviewed · ${approvedAssets} approved · ${publishedAssets} publication ready`
        + (openFlagCount ? ` · ${openFlagCount} open prompt flag${openFlagCount === 1 ? '' : 's'}` : ''),
    openFlagCount
      ? `Resolve ${openFlagCount} open prompt flag${openFlagCount === 1 ? '' : 's'}`
      : unreviewedAssets
        ? `Review ${unreviewedAssets} image${unreviewedAssets === 1 ? '' : 's'} in the Library`
        : 'Review every image prompt and file its decision'
  );

  const counts = {
    done: steps.filter((step) => step.status === 'done').length,
    attention: steps.filter((step) => step.status === 'attention').length,
    todo: steps.filter((step) => step.status === 'todo').length,
    total: steps.length,
  };
  const nextStep = steps.find((step) => step.status !== 'done') || null;

  return sendJSON(res, 200, {
    project: { id: project.id, title: project.title, stage: project.stage, status: project.status },
    steps,
    counts,
    // The next action is the first step that is not finished, in workflow order:
    // a later step cannot be the next action while an earlier one is open.
    next: nextStep
      ? { stepId: nextStep.id, label: nextStep.label, screen: nextStep.screen, detail: nextStep.detail, action: nextStep.action }
      : null,
  });
}

function handleStoryValidate(req, res, projectId) {
  const session = requireUser(req);
  const warnings = storyStore.validate(session.user_id, storyProjectId(projectId));
  if (!warnings) fail(404, 'Project not found.');
  return sendJSON(res, 200, {
    warnings,
    counts: {
      total: warnings.length,
      errors: warnings.filter((item) => item.severity === 'error').length,
      warnings: warnings.filter((item) => item.severity === 'warning').length,
    },
  });
}

function worksheetProject(req, projectId) {
  const session = requireUser(req);
  const project = db.getProject(session.user_id, storyProjectId(projectId));
  if (!project) fail(404, 'Project not found.');
  return { session, project };
}

function worksheetKey(session) {
  if (!session.api_key_enc) fail(409, 'Save a DeepSeek API key in Settings first.', 'NO_API_KEY');
  const key = security.decryptApiKey(session.api_key_enc);
  if (!key) fail(500, 'Your saved API key could not be read. Save it again.', 'KEY_UNREADABLE');
  return key;
}

function worksheetActions(value, names, count) {
  if (!Array.isArray(value) || value.length !== count) fail(502, `DeepSeek must return exactly ${count} action references.`, 'INVALID_WORKSHEET');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') fail(502, 'Invalid action reference.', 'INVALID_WORKSHEET');
    const action = storyTextField(item.action, `Action ${index + 1}`, 4500, { required: true });
    const locationSentence = storyTextField(item.locationSentence, `Location sentence ${index + 1}`, 500, { required: true });
    if (!/[.!?]$/.test(locationSentence)) fail(502, 'Each location sentence must end in punctuation.', 'INVALID_WORKSHEET');
    if (/[.!?]\s+\S/.test(locationSentence)) fail(502, 'Each location ending must be one sentence.', 'INVALID_WORKSHEET');
    const characters = Array.isArray(item.characters) ? item.characters.map((name) => String(name).trim()) : [];
    if (characters.some((name) => !names.includes(name))) fail(502, 'Action references must use only supplied character names.', 'INVALID_WORKSHEET');
    return { action, locationSentence, characters };
  });
}

function worksheetLocations(value, count) {
  if (!Array.isArray(value) || value.length !== count) fail(502, `DeepSeek must return exactly ${count} location references.`, 'INVALID_WORKSHEET');
  return value.map((item, index) => ({
    name: storyTextField(item && item.name, `Location ${index + 1} name`, 200, { required: true }),
    description: storyTextField(item && item.description, `Location ${index + 1} description`, 5000, { required: true }),
  }));
}

async function handleWorksheetGenerate(req, res, projectId, type) {
  const { session, project } = worksheetProject(req, projectId);
  const body = await readJSON(req);
  const key = worksheetKey(session);
  const worksheet = storyStore.getStory(session.user_id, project.id).worksheet;
  let content;
  let system;
  let count;
  if (type === 'actions') {
    count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) fail(400, 'Choose 1 to 20 pictures.');
    if (!String(project.referenceMaterial || '').trim()) fail(409, 'Save Reference Material first.');
    const names = (project.characterReferences || []).map((item) => item.name).filter(Boolean);
    system = `Return only JSON {"actions":[{"action":"...","locationSentence":"One final sentence describing where this action takes place.","characters":["name"]}]}. Exactly ${count} numbered-in-order actions, one per picture. Use only the supplied Reference Material as narrative context. Refer to characters only by the supplied names, never invent names or character details. Every action must end with the separate, single locationSentence. Do not put character names in locationSentence.`;
    content = `Reference Material:\n${project.referenceMaterial}\n\nAllowed character names (names only): ${JSON.stringify(names)}`;
  } else {
    if (!worksheet.actions.length) fail(409, 'Save action references first.');
    count = worksheet.actions.length;
    system = `Return only JSON {"locations":[{"name":"...","description":"..."}]}. Exactly ${count} descriptions in the same order as the location sentences. Use only the supplied setting and the final location sentence of each action. No plot, character, or other reference material.`;
    content = `Setting: ${worksheet.setting || '(not specified)'}\n\nLocation sentences: ${JSON.stringify(worksheet.actions.map((item) => item.locationSentence))}`;
  }
  const response = await callDeepSeekJson(key, {
    model: TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    temperature: 0.7, max_tokens: 12000,
  });
  const data = response.data || {};
  const items = type === 'actions'
    ? worksheetActions(data.actions, (project.characterReferences || []).map((item) => item.name), count)
    : worksheetLocations(data.locations, count);
  return sendJSON(res, 200, { [type]: items });
}

async function handleWorksheetSave(req, res, projectId, type) {
  const { session, project } = worksheetProject(req, projectId);
  const body = await readJSON(req);
  const items = type === 'actions'
    ? worksheetActions(body.actions, (project.characterReferences || []).map((item) => item.name),
      Array.isArray(body.actions) ? body.actions.length : -1)
    : worksheetLocations(body.locations, storyStore.getStory(session.user_id, project.id).worksheet.actions.length);
  if (type === 'actions' && (!items.length || items.length > 20)) fail(400, 'Save 1 to 20 actions.');
  const worksheet = type === 'actions'
    ? storyStore.saveWorksheetActions(session.user_id, project.id, items)
    : storyStore.saveWorksheetLocations(session.user_id, project.id, items);
  return sendJSON(res, 200, { worksheet });
}

async function handleStoryWorkspaceGenerate(req, res, projectId) {
  const session = requireUser(req);
  const body = await readJSON(req);

  if (!session.api_key_enc) {
    fail(409, 'No DeepSeek API key is saved for your account. Add one in Settings.', 'NO_API_KEY');
  }
  const apiKey = security.decryptApiKey(session.api_key_enc);
  if (!apiKey) {
    fail(500, 'Your saved API key could not be read. Please save it again.', 'KEY_UNREADABLE');
  }

  const project = db.getProject(session.user_id, storyProjectId(projectId));
  if (!project) fail(404, 'Project not found.');

  const reference = (project.referenceMaterial || '').trim();
  if (!reference) {
    fail(409, 'This project has no saved reference material. Generate it in Reference Stage first.', 'REFERENCE_REQUIRED');
  }

  const supplied = (project.characterReferences || [])
    .filter((item) => item && item.name)
    .map((item) => ({ name: item.name, gender: item.gender || '' }));
  if (!supplied.length) {
    fail(409, 'This project has no character references to build a workspace from. Generate reference material with characters first.', 'NO_CHARACTERS');
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  if (!TEXT_MODELS.has(model)) fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  if (model.length > 100) fail(400, 'Model name is too long.');

  const replace = body.replace === true;
  if (storyStore.workspaceExists(session.user_id, project.id) && !replace) {
    fail(
      409,
      'Structured Story Workspace records already exist for this project. Confirm that you want to replace them first.',
      'WORKSPACE_REPLACE_REQUIRED'
    );
  }

  const characterText = supplied
    .map((character, index) => `${index + 1}. Name: ${character.name}\n   Gender: ${character.gender}`)
    .join('\n');
  const userContent = [
    `Project: ${project.title}`,
    `Reference material:\n${reference}`,
    `Characters:\n${characterText}`,
    'Produce the structured story workspace now.',
  ].join('\n\n');

  const structured = await callDeepSeekJson(apiKey, {
    model,
    messages: [
      { role: 'system', content: WORKSPACE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 12000,
  });

  const rawWorkspace = structured.data && typeof structured.data === 'object' && !Array.isArray(structured.data)
    ? (structured.data.storyWorkspace || structured.data.workspace || structured.data)
    : null;
  let workspace;
  try {
    workspace = normalizeStoryWorkspace(rawWorkspace, supplied);
  } catch (err) {
    fail(err.status || 502, err.message, err.code || 'INVALID_WORKSPACE');
  }

  const imported = storyStore.importWorkspace(session.user_id, project.id, workspace, {
    replace,
    characterReferences: project.characterReferences || [],
  });

  return sendJSON(res, 200, {
    story: storyStore.getStory(session.user_id, project.id),
    workspace: {
      imported: true,
      replaced: Boolean(imported && imported.replaced),
      characters: imported ? imported.characters : 0,
      locations: imported ? imported.locations : 0,
      styles: imported ? imported.styles : 0,
      scenes: imported ? imported.scenes : 0,
    },
    model: structured.model,
  });
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/health') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return sendJSON(res, 200, {
      ok: true,
      service: 'project-workflow-app',
      version: APP_VERSION,
      auth: true,
      time: new Date().toISOString(),
    });
  }

  // Every mutating call must come from our own origin (CSRF).
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    fail(403, 'Cross-origin request blocked.');
  }

  if (pathname === '/api/track' || pathname.startsWith('/api/track/')) {
    const session = requireUser(req);
    if (method !== 'GET') fail(405, 'Method not allowed.');
    if (pathname === '/api/track') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      return sendJSON(res, 200, requestTracker.list(session.user_id, params));
    }
    const entry = requestTracker.get(session.user_id, pathname.slice('/api/track/'.length));
    if (!entry) fail(404, 'Request not found.');
    return sendJSON(res, 200, { request: entry });
  }

  if (pathname === '/api/auth/register') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleRegister(req, res);
  }
  if (pathname === '/api/auth/login') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleLogin(req, res);
  }
  if (pathname === '/api/auth/logout') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleLogout(req, res);
  }
  if (pathname === '/api/auth/me') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleMe(req, res);
  }

  if (pathname === '/api/me/api-key') {
    if (method === 'PUT') return handleSaveApiKey(req, res);
    if (method === 'DELETE') return handleDeleteApiKey(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/me/byteplus-key') {
    if (method === 'PUT') return handleSaveBytePlusKey(req, res);
    if (method === 'DELETE') return handleDeleteBytePlusKey(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/me/ai-settings') {
    if (method === 'PUT') return handleSaveAISettings(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/me/anthropic-key') {
    if (method === 'PUT') return handleSaveAnthropicKey(req, res);
    if (method === 'DELETE') return handleDeleteAnthropicKey(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/me/openai-key') {
    if (method === 'PUT') return handleSaveOpenAIKey(req, res);
    if (method === 'DELETE') return handleDeleteOpenAIKey(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/me/chat-settings') {
    if (method === 'PUT') return handleSaveChatSettings(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/projects/import') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleImportProjects(req, res);
  }
  if (pathname === '/api/projects') {
    if (method === 'GET') return handleListProjects(req, res);
    if (method === 'POST') return handleCreateProject(req, res);
    fail(405, 'Method not allowed.');
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})$/);
  if (projectMatch) {
    if (method === 'PUT') return handleUpdateProject(req, res, projectMatch[1]);
    if (method === 'DELETE') return handleDeleteProject(req, res, projectMatch[1]);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/generate') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerate(req, res);
  }

  if (pathname === '/api/chat') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleChat(req, res);
  }

  if (pathname === '/api/reviewer/fields') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleReviewerFields(req, res, new URL(req.url, 'http://localhost'));
  }

  if (pathname === '/api/reviewer/review') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleReviewerReview(req, res);
  }

  if (pathname === '/api/reference') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleReference(req, res);
  }

  if (pathname === '/api/generation/build') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationBuild(req, res);
  }

  if (pathname === '/api/generation/review') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationReview(req, res);
  }

  if (pathname === '/api/generation/images/one') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationImageOne(req, res);
  }

  const generationFlagMatch = pathname.match(
    /^\/api\/generation\/([A-Za-z0-9_-]{1,64})\/prompts\/([A-Za-z0-9_-]{1,80})\/flags\/([A-Za-z0-9_-]{1,80})$/
  );
  if (generationFlagMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationFlag(req, res, generationFlagMatch[1], generationFlagMatch[2], generationFlagMatch[3]);
  }

  const generationApprovalMatch = pathname.match(
    /^\/api\/generation\/([A-Za-z0-9_-]{1,64})\/prompts\/([A-Za-z0-9_-]{1,80})\/approval$/
  );
  if (generationApprovalMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationApproval(req, res, generationApprovalMatch[1], generationApprovalMatch[2]);
  }

  const generationPromptMatch = pathname.match(
    /^\/api\/generation\/([A-Za-z0-9_-]{1,64})\/prompts\/([A-Za-z0-9_-]{1,80})$/
  );
  if (generationPromptMatch) {
    if (method !== 'PUT') fail(405, 'Method not allowed.');
    return handleGenerationPromptUpdate(req, res, generationPromptMatch[1], generationPromptMatch[2]);
  }

  const generationPromptsMatch = pathname.match(/^\/api\/generation\/([A-Za-z0-9_-]{1,64})\/prompts$/);
  if (generationPromptsMatch) {
    if (method !== 'PUT') fail(405, 'Method not allowed.');
    return handleGenerationSave(req, res, generationPromptsMatch[1]);
  }

  const generationMatch = pathname.match(/^\/api\/generation\/([A-Za-z0-9_-]{1,64})$/);
  if (generationMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleGenerationState(req, res, generationMatch[1]);
  }

  const studioProgressMatch = pathname.match(/^\/api\/studio\/([A-Za-z0-9_-]{1,64})\/progress$/);
  if (studioProgressMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleStudioProgress(req, res, studioProgressMatch[1]);
  }

  if (pathname === '/api/images/generate') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerateImage(req, res);
  }

  if (pathname === '/api/library') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleLibraryList(req, res);
  }

  if (pathname === '/api/library/file') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleLibraryFile(req, res, new URL(req.url, 'http://localhost'));
  }

  if (pathname === '/api/assets') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleAssetList(req, res, new URL(req.url, 'http://localhost'));
  }

  if (pathname === '/api/assets/duplicates') {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleDuplicateGroups(req, res);
  }

  if (pathname === '/api/assets/sync') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleAssetSync(req, res);
  }

  const assetTagMatch = pathname.match(/^\/api\/assets\/([A-Za-z0-9_-]{1,64})\/tags(?:\/([A-Za-z0-9_-]{1,64}))?$/);
  if (assetTagMatch) {
    if (assetTagMatch[2]) {
      if (method !== 'DELETE') fail(405, 'Method not allowed.');
      return handleAssetTag(req, res, assetTagMatch[1], assetTagMatch[2]);
    }
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleAssetTag(req, res, assetTagMatch[1], null);
  }

  const assetMatch = pathname.match(/^\/api\/assets\/([A-Za-z0-9_-]{1,64})$/);
  if (assetMatch) {
    if (method === 'GET') return handleAssetDetail(req, res, assetMatch[1]);
    if (method === 'PUT') return handleAssetUpdate(req, res, assetMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const assetReviewMatch = pathname.match(/^\/api\/assets\/([A-Za-z0-9_-]{1,64})\/(review|reviews|checklist|safe-cover|publication|audit)$/);
  if (assetReviewMatch) {
    const assetId = assetReviewMatch[1];
    const action = assetReviewMatch[2];
    if (action === 'review' || action === 'audit') {
      if (method !== 'GET') fail(405, 'Method not allowed.');
      return action === 'review' ? handleAssetReviewGet(req, res, assetId) : handleAssetAudit(req, res, assetId);
    }
    if (action === 'reviews') {
      if (method !== 'POST') fail(405, 'Method not allowed.');
      return handleAssetReviewCreate(req, res, assetId);
    }
    if (action === 'checklist') {
      if (method !== 'PUT') fail(405, 'Method not allowed.');
      return handleAssetChecklist(req, res, assetId);
    }
    if (action === 'safe-cover') {
      if (method !== 'POST') fail(405, 'Method not allowed.');
      return handleAssetSafeCover(req, res, assetId);
    }
    if (action === 'publication') {
      if (method !== 'POST') fail(405, 'Method not allowed.');
      return handleAssetPublication(req, res, assetId);
    }
  }

  const promptReviewMatch = pathname.match(/^\/api\/story\/prompts\/([A-Za-z0-9_-]{1,80})\/(review|reviews)$/);
  if (promptReviewMatch) {
    if (promptReviewMatch[2] === 'review') {
      if (method !== 'GET') fail(405, 'Method not allowed.');
      return handlePromptReviewGet(req, res, promptReviewMatch[1]);
    }
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handlePromptReviewCreate(req, res, promptReviewMatch[1]);
  }

  const storyPromptPromoteMatch = pathname.match(/^\/api\/story\/prompts\/([A-Za-z0-9_-]{1,80})\/promote$/);
  if (storyPromptPromoteMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryPromptPromote(req, res, storyPromptPromoteMatch[1]);
  }

  if (pathname === '/api/characters') {
    if (method === 'GET') return handleCharacterList(req, res);
    if (method === 'POST') return handleCharacterCreate(req, res);
    fail(405, 'Method not allowed.');
  }

  const characterImageMatch = pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,80})\/image\/([A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/i);
  if (characterImageMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleCharacterImage(req, res, characterImageMatch[1], characterImageMatch[2]);
  }

  if (pathname === '/api/generations') {
    if (method === 'GET') return handleGenerationList(req, res);
    if (method === 'POST') return handleGenerationCreate(req, res);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/generation-references') {
    if (method === 'POST') return handleGenerationReferenceUpload(req, res);
    fail(405, 'Method not allowed.');
  }

  const generationReferenceImageMatch = pathname.match(/^\/api\/generation-references\/([A-Za-z0-9_-]{1,80})\/image$/);
  if (generationReferenceImageMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleGenerationReferenceImage(req, res, generationReferenceImageMatch[1]);
  }

  const generationReferenceMatch = pathname.match(/^\/api\/generation-references\/([A-Za-z0-9_-]{1,80})$/);
  if (generationReferenceMatch) {
    if (method !== 'DELETE') fail(405, 'Method not allowed.');
    return handleGenerationReferenceDelete(req, res, generationReferenceMatch[1]);
  }

  if (pathname === '/api/generation-presets') {
    if (method === 'GET') return handleGenerationPresetList(req, res);
    if (method === 'POST') return handleGenerationPresetCreate(req, res);
    fail(405, 'Method not allowed.');
  }

  const generationPresetMatch = pathname.match(/^\/api\/generation-presets\/([A-Za-z0-9_-]{1,80})$/);
  if (generationPresetMatch) {
    if (method === 'PUT') return handleGenerationPresetUpdate(req, res, generationPresetMatch[1]);
    if (method === 'DELETE') return handleGenerationPresetDelete(req, res, generationPresetMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const generationImageMatch = pathname.match(/^\/api\/generations\/([A-Za-z0-9_-]{1,80})\/image\/([^/]+)$/);
  if (generationImageMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleGenerationImage(req, res, generationImageMatch[1], decodeURIComponent(generationImageMatch[2]));
  }

  const standaloneGenerationMatch = pathname.match(/^\/api\/generations\/([A-Za-z0-9_-]{1,80})$/);
  if (standaloneGenerationMatch) {
    if (method !== 'DELETE') fail(405, 'Method not allowed.');
    return handleGenerationDelete(req, res, standaloneGenerationMatch[1]);
  }

  const characterVersionImportMatch = pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,80})\/versions\/import$/);
  if (characterVersionImportMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleCharacterVersionImport(req, res, characterVersionImportMatch[1]);
  }

  const characterVersionPromoteMatch = pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,80})\/versions\/([A-Za-z0-9_-]{1,80})\/promote$/);
  if (characterVersionPromoteMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleCharacterVersionPromote(req, res, characterVersionPromoteMatch[1], characterVersionPromoteMatch[2]);
  }

  const characterGenerateMatch = pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,80})\/generate$/);
  if (characterGenerateMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleCharacterGenerate(req, res, characterGenerateMatch[1]);
  }

  const characterMatch = pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,80})$/);
  if (characterMatch) {
    if (method === 'PUT') return handleCharacterUpdate(req, res, characterMatch[1]);
    if (method === 'DELETE') return handleCharacterDelete(req, res, characterMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const storySheetPromoteMatch = pathname.match(/^\/api\/story\/sheets\/([A-Za-z0-9_-]{1,80})\/promote$/);
  if (storySheetPromoteMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStorySheetPromote(req, res, storySheetPromoteMatch[1]);
  }

  const storySheetGenerateMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/characters\/([A-Za-z0-9_-]{1,80})\/sheets\/generate$/);
  if (storySheetGenerateMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStorySheetGenerate(req, res, storySheetGenerateMatch[1], storySheetGenerateMatch[2]);
  }

  const storySheetCreateMatch = pathname.match(/^\/api\/story\/sheet-image\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/i);
  if (storySheetCreateMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleStorySheetImage(req, res, storySheetCreateMatch[1], storySheetCreateMatch[2]);
  }

  const storyPromptCreateMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/scenes\/([A-Za-z0-9_-]{1,80})\/prompts$/);
  if (storyPromptCreateMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryPromptCreate(req, res, storyPromptCreateMatch[1], storyPromptCreateMatch[2]);
  }

  const storyScenesMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/scenes$/);
  if (storyScenesMatch) {
    if (method !== 'PUT') fail(405, 'Method not allowed.');
    return handleStoryScenes(req, res, storyScenesMatch[1]);
  }

  const storyCharactersMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/characters$/);
  if (storyCharactersMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryCharacterCreate(req, res, storyCharactersMatch[1]);
  }
  const storyCharacterMatch = pathname.match(/^\/api\/story\/characters\/([A-Za-z0-9_-]{1,80})$/);
  if (storyCharacterMatch) {
    if (method === 'PUT') return handleStoryCharacterUpdate(req, res, storyCharacterMatch[1]);
    if (method === 'DELETE') return handleStoryCharacterDelete(req, res, storyCharacterMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const storyLocationsMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/locations$/);
  if (storyLocationsMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryLocationCreate(req, res, storyLocationsMatch[1]);
  }
  const storyLocationMatch = pathname.match(/^\/api\/story\/locations\/([A-Za-z0-9_-]{1,80})$/);
  if (storyLocationMatch) {
    if (method === 'PUT') return handleStoryLocationUpdate(req, res, storyLocationMatch[1]);
    if (method === 'DELETE') return handleStoryLocationDelete(req, res, storyLocationMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const storyStylesMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/styles$/);
  if (storyStylesMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryStyleCreate(req, res, storyStylesMatch[1]);
  }
  const storyStyleMatch = pathname.match(/^\/api\/story\/styles\/([A-Za-z0-9_-]{1,80})$/);
  if (storyStyleMatch) {
    if (method === 'PUT') return handleStoryStyleUpdate(req, res, storyStyleMatch[1]);
    if (method === 'DELETE') return handleStoryStyleDelete(req, res, storyStyleMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const storyBriefMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/brief$/);
  if (storyBriefMatch) {
    if (method !== 'PUT') fail(405, 'Method not allowed.');
    return handleStoryBrief(req, res, storyBriefMatch[1]);
  }

  const storyValidateMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/validate$/);
  if (storyValidateMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleStoryValidate(req, res, storyValidateMatch[1]);
  }

  const storyWorkspaceGenerateMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/workspace\/generate$/);
  if (storyWorkspaceGenerateMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleStoryWorkspaceGenerate(req, res, storyWorkspaceGenerateMatch[1]);
  }
  const worksheetMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})\/worksheet\/(actions|locations)\/(generate|save)$/);
  if (worksheetMatch) {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return worksheetMatch[3] === 'generate'
      ? handleWorksheetGenerate(req, res, worksheetMatch[1], worksheetMatch[2])
      : handleWorksheetSave(req, res, worksheetMatch[1], worksheetMatch[2]);
  }

  const storyMatch = pathname.match(/^\/api\/story\/([A-Za-z0-9_-]{1,80})$/);
  if (storyMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleStoryGet(req, res, storyMatch[1]);
  }

  if (pathname === '/api/collections') {
    if (method !== 'GET' && method !== 'POST') fail(405, 'Method not allowed.');
    return handleCollections(req, res);
  }

  const collectionAssetMatch = pathname.match(/^\/api\/collections\/([A-Za-z0-9_-]{1,64})\/assets\/([A-Za-z0-9_-]{1,64})$/);
  if (collectionAssetMatch) {
    if (method !== 'POST' && method !== 'DELETE') fail(405, 'Method not allowed.');
    return handleCollectionAsset(req, res, collectionAssetMatch[1], collectionAssetMatch[2]);
  }

  const collectionMatch = pathname.match(/^\/api\/collections\/([A-Za-z0-9_-]{1,64})$/);
  if (collectionMatch) {
    if (method === 'DELETE') return handleCollectionDelete(req, res, collectionMatch[1]);
    if (method === 'PUT') return handleCollectionUpdate(req, res, collectionMatch[1]);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/tags') {
    if (method !== 'GET' && method !== 'POST') fail(405, 'Method not allowed.');
    return handleTags(req, res);
  }

  const tagMatch = pathname.match(/^\/api\/tags\/([A-Za-z0-9_-]{1,64})$/);
  if (tagMatch) {
    if (method === 'DELETE') return handleTagDelete(req, res, tagMatch[1]);
    if (method === 'PUT') return handleTagUpdate(req, res, tagMatch[1]);
    fail(405, 'Method not allowed.');
  }

  const projectEpisodesMatch = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/episodes$/);
  if (projectEpisodesMatch) {
    if (method !== 'GET' && method !== 'POST') fail(405, 'Method not allowed.');
    return handleEpisodeCollection(req, res, projectEpisodesMatch[1]);
  }

  const episodeMatch = pathname.match(/^\/api\/episodes\/([A-Za-z0-9_-]{1,64})$/);
  if (episodeMatch) {
    if (method === 'DELETE') return handleEpisodeDelete(req, res, episodeMatch[1]);
    if (method === 'PUT') return handleEpisodeUpdate(req, res, episodeMatch[1]);
    fail(405, 'Method not allowed.');
  }

  if (pathname === '/api/images/upload') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleUploadImage(req, res);
  }

  const imageMatch = pathname.match(/^\/api\/image\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/i);
  if (imageMatch) {
    if (method !== 'GET') fail(405, 'Method not allowed.');
    return handleServeImage(req, res, imageMatch[1], imageMatch[2]);
  }

  fail(404, 'Not found.');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (_) {
    return sendJSON(res, 400, { error: 'Malformed URL' });
  }
  const versioned = /[?&]v=/.test(req.url || '');
  const staticPath = urlPath === '/' ? 'index.html'
    : urlPath === '/track' || urlPath === '/track/' ? 'track/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, staticPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      // Unknown extensionless paths fall back to the app shell.
      if (urlPath !== '/' && !path.extname(filePath)) {
        return serveIndex(res);
      }
      return sendJSON(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (readErr, content) => {
      if (readErr) return sendJSON(res, 500, { error: 'Failed to read file' });
      applySecurityHeaders(res);
      if (ext === '.html') applyCsp(res);
      applyCacheHeaders(res, filePath, versioned);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': content.length,
      });
      res.end(content);
    });
  });
}

function serveIndex(res) {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(filePath, (err, content) => {
    if (err) return sendJSON(res, 500, { error: 'Failed to read index.html' });
    applySecurityHeaders(res);
    applyCsp(res);
    applyCacheHeaders(res, filePath, false);
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Content-Length': content.length });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function dispatch(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return sendJSON(res, 400, { error: 'Malformed URL' });
  }

  if (url.pathname.startsWith('/api/')) {
    const execute = () => Promise.resolve(handleApi(req, res, url.pathname)).catch((err) => handleError(res, err));
    // Polling the debugger must not fill its own request history.
    if (url.pathname === '/api/track' || url.pathname.startsWith('/api/track/')) return execute();
    return requestTracker.run(req, res, currentSession(req)?.user_id, execute);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }
  return sendJSON(res, 405, { error: 'Method not allowed' });
}

function handleError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    return sendJSON(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message });
  }
  console.error(err);
  return sendJSON(res, 500, { error: 'Internal server error.' });
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch((err) => handleError(res, err));
});

server.on('error', (err) => {
  console.error(`\n  Could not start the server: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Carnival App v${APP_VERSION} running:`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  ➜  database: ${db.DB_PATH}\n`);
});
