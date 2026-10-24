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
const reviewStore = require('./reviews').init(db.db, storyStore, db.DB_PATH);
const fieldReviewStore = require('./fieldreviews').init(db.db);
const { init: initApiUsage, normalizeUsage } = require('./apiusage');
const apiUsageStore = initApiUsage(db.db);

security.init(db.DATA_DIR);

const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = '4.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
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
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Image is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
const GENERATION_SYSTEM_PROMPT = `${GENERATION_SYSTEM_RULES} Return ONLY valid JSON in the form {"prompts": ["prompt for scene 1", "prompt for scene 2", ...]} with exactly one prompt per scene, in the same order as the scenes.`;
const SINGLE_SCENE_GENERATION_SYSTEM_PROMPT = `${GENERATION_SYSTEM_RULES} Return ONLY valid JSON in the form {"prompt":"one complete image-generation prompt"} for the supplied scene.`;

const CHAT_SYSTEM_PROMPTS = {
  guide: [
    'You are a concise workflow guide inside the DeviTeam project app.',
    'Guide the user step by step through the workflow: Idea → Reference Stage → Story Workspace → Generation Stage → Review → Done.',
    'Use the provided project context. Tell the user the next concrete action, and answer their questions directly.',
    'Never claim that any content has been reviewed, approved, or published.',
  ].join(' '),
  reviewer: [
    'You are a review assistant inside the DeviTeam project app.',
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
  'You are a meticulous content reviewer inside the DeviTeam project app.',
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

function buildCharacterSheetPrompt(character, story) {
  const parts = [];
  const subject = character.name || 'the character';
  const age = character.age ? `, age ${character.age}` : '';
  const gender = character.gender ? ` (${character.gender})` : '';
  parts.push(`Photorealistic full-body character reference sheet of ${subject}${age}${gender}.`);
  if (character.appearance) parts.push(`Appearance: ${character.appearance}`);
  if (character.wardrobe) parts.push(`Wardrobe: ${character.wardrobe}`);
  if (character.continuityNotes) parts.push(`Continuity details: ${character.continuityNotes}`);
  const style = (story && Array.isArray(story.styles) && story.styles[0]) || null;
  if (style) {
    if (style.description) parts.push(`Style: ${style.description}`);
    if (style.guidance) parts.push(`Visual guidance: ${style.guidance}`);
  }
  parts.push('Centered full-body pose, simple neutral background, consistent soft lighting, photographic realism.');
  const exclusions = [];
  if (style && Array.isArray(style.exclusions)) exclusions.push(...style.exclusions);
  exclusions.push('text', 'watermark', 'extra limbs', 'distorted face');
  if (exclusions.length) parts.push(`Avoid: ${exclusions.join(', ')}.`);
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
    upstream = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120000),
    });
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
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(120000),
    });
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

async function handleChat(req, res) {
  const session = requireUser(req);
  const body = await readJSON(req);

  const mode = body.mode === 'reviewer' ? 'reviewer' : 'guide';
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

function scenePromptResponseData(structured) {
  if (structured.completion.finishReason === 'length') {
    fail(502, 'DeepSeek reached the output limit before finishing the scene prompt. Your saved prompts were kept.', 'PROMPT_OUTPUT_LIMIT');
  }
  if (!structured.completion.content.trim()) {
    fail(502, 'DeepSeek returned no final prompt content. Your saved prompts were kept.', 'EMPTY_PROMPT_RESPONSE');
  }
  return structured.data;
}

function singleScenePrompt(data) {
  let value = data;
  if (data && Array.isArray(data.prompts)) {
    value = data.prompts.length === 1 ? data.prompts[0] : null;
  } else if (Array.isArray(data)) {
    value = data.length === 1 ? data[0] : null;
  }
  return typeof value === 'string' ? value.trim()
    : value && typeof value.prompt === 'string' ? value.prompt.trim() : '';
}

async function handleGenerationPrompts(req, res) {
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
  if (!projectId) fail(400, 'Choose a project in Generation Stage.');

  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');

  const reference = (project.referenceMaterial || '').trim();
  if (!reference) {
    fail(409, 'This project has no saved reference material. Generate it in Reference Stage first.', 'REFERENCE_REQUIRED');
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  if (!TEXT_MODELS.has(model)) {
    fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');

  const scenes = body.scenes !== undefined ? cleanSceneList(body.scenes) : project.scenes;
  if (!scenes.length) {
    fail(400, 'Add at least one scene before generating prompts.', 'NO_SCENES');
  }

  const promptScenes = scenes.map((scene) => ({
    title: scene.title,
    action: scene.action,
    location: scene.location,
    characters: scene.characters,
  }));

  const characterReferenceText = Array.isArray(project.characterReferences) && project.characterReferences.length
    ? `Character references (JSON):\n${JSON.stringify(project.characterReferences, null, 2)}`
    : null;
  const storyContext = storyStore.getStory(session.user_id, projectId);
  const structuredReferenceText = storyContext
    ? `Structured continuity references (JSON):\n${JSON.stringify({
      brief: storyContext.brief,
      characters: storyContext.characters,
      locations: storyContext.locations,
      styles: storyContext.styles,
    }, null, 2)}`
    : null;

  const userContent = [
    `Reference material:\n${reference}`,
    ...(characterReferenceText ? [characterReferenceText] : []),
    ...(structuredReferenceText ? [structuredReferenceText] : []),
    `Scenes (JSON, in chronological order):\n${JSON.stringify(promptScenes, null, 2)}`,
    `Write exactly ${scenes.length} image prompts, one per scene, in this order. Return {"prompts":[...]} as JSON only.`,
  ].join('\n\n');

  const structured = await callDeepSeekJson(apiKey, {
    model,
    messages: [
      { role: 'system', content: GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });

  const data = scenePromptResponseData(structured);
  const promptList = Array.isArray(data)
    ? data
    : data && Array.isArray(data.prompts)
      ? data.prompts
      : null;

  if (!promptList) {
    fail(502, 'DeepSeek returned an unreadable scene-prompt response. Try again.', 'NO_PROMPTS');
  }
  if (promptList.length !== scenes.length) {
    fail(
      502,
      `DeepSeek returned ${promptList.length} prompt(s) for ${scenes.length} scene(s). Regenerate the prompts.`,
      'PROMPT_COUNT_MISMATCH'
    );
  }

  const prompts = scenes.map((scene, index) => {
    const item = promptList[index];
    const prompt = typeof item === 'string'
      ? item.trim()
      : item && typeof item.prompt === 'string'
        ? item.prompt.trim()
        : '';
    if (!prompt) {
      fail(502, `DeepSeek returned an empty prompt for scene ${index + 1}.`, 'NO_PROMPTS');
    }
    return { sceneId: scene.id, prompt: prompt.slice(0, 30000) };
  });

  const updated = db.updateProject(session.user_id, projectId, {
    scenes,
    generation_prompts: prompts,
  });
  if (!updated) fail(404, 'Project not found.');

  const story = storyStore.getStory(session.user_id, projectId) || { scenes: [] };
  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  const imageSize = (IMAGE_MODEL_SIZES.get(imageModel) || ['2K'])[0];
  for (const prompt of updated.generationPrompts) {
    const scene = story.scenes.find((item) => item.id === prompt.sceneId);
    storyStore.createPrompt(session.user_id, projectId, prompt.sceneId, {
      text: prompt.prompt,
      exclusions: [],
      referenceRoles: scene ? {
        characterIds: scene.characterIds,
        locationId: scene.locationId || '',
        styleId: '',
      } : {},
      textModel: structured.model,
      temperature: 0.7,
      maxTokens: 8192,
      imageModel,
      imageSize,
      source: 'ai',
    });
  }

  return sendJSON(res, 200, {
    project: db.getProject(session.user_id, projectId),
    prompts: updated.generationPrompts,
    model: structured.model,
    fallback: structured.fallback,
  });
}

async function handleGenerationPrompt(req, res) {
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
  if (!projectId) fail(400, 'Choose a project in Generation Stage.');

  const project = db.getProject(session.user_id, projectId);
  if (!project) fail(404, 'Project not found.');

  const reference = (project.referenceMaterial || '').trim();
  if (!reference) {
    fail(409, 'This project has no saved reference material. Generate it in Reference Stage first.', 'REFERENCE_REQUIRED');
  }

  const rawScene = body.scene && typeof body.scene === 'object' ? body.scene : null;
  const sceneId = rawScene && typeof rawScene.id === 'string' ? rawScene.id.trim() : '';
  if (!sceneId) fail(400, 'Choose a scene to regenerate.');

  const sceneIndex = project.scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex < 0) fail(404, 'Scene not found.');

  const scene = normalizeSceneList([{ ...rawScene, id: sceneId }], 1)[0];
  scene.order = sceneIndex;
  const scenes = project.scenes.slice();
  scenes[sceneIndex] = scene;

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : (TEXT_MODELS.has(session.text_model) ? session.text_model : DEFAULT_TEXT_MODEL);
  if (!TEXT_MODELS.has(model)) {
    fail(400, 'Unsupported DeepSeek model. Choose DeepSeek 4 Pro.');
  }
  if (model.length > 100) fail(400, 'Model name is too long.');

  const characterReferenceText = Array.isArray(project.characterReferences) && project.characterReferences.length
    ? `Character references (JSON):\n${JSON.stringify(project.characterReferences, null, 2)}`
    : null;
  const storyContext = storyStore.getStory(session.user_id, projectId);
  const structuredReferenceText = storyContext
    ? `Structured continuity references (JSON):\n${JSON.stringify({
      brief: storyContext.brief,
      characters: storyContext.characters,
      locations: storyContext.locations,
      styles: storyContext.styles,
    }, null, 2)}`
    : null;

  const userContent = [
    `Reference material:\n${reference}`,
    ...(characterReferenceText ? [characterReferenceText] : []),
    ...(structuredReferenceText ? [structuredReferenceText] : []),
    `Scene (JSON):\n${JSON.stringify(scene, null, 2)}`,
    'Write one detailed photorealistic prompt for this scene. Return {"prompt":"..."} as JSON only.',
  ].join('\n\n');

  const structured = await callDeepSeekJson(apiKey, {
    model,
    messages: [
      { role: 'system', content: SINGLE_SCENE_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 4000,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });

  const prompt = singleScenePrompt(scenePromptResponseData(structured));
  if (!prompt) {
    fail(502, 'DeepSeek returned an invalid scene-prompt format. Expected one nonempty prompt. Your saved prompts were kept.', 'NO_PROMPTS');
  }

  const byScene = new Map(
    project.generationPrompts
      .filter((item) => item.sceneId !== sceneId)
      .map((item) => [item.sceneId, item])
  );
  byScene.set(sceneId, { sceneId, prompt: prompt.slice(0, 30000) });

  const generationPrompts = scenes
    .map((item) => byScene.get(item.id))
    .filter(Boolean);

  const updated = db.updateProject(session.user_id, projectId, {
    scenes,
    generation_prompts: generationPrompts,
  });
  if (!updated) fail(404, 'Project not found.');

  const story = storyStore.getStory(session.user_id, projectId) || { scenes: [] };
  const storyScene = story.scenes.find((item) => item.id === sceneId);
  const imageModel = IMAGE_MODEL_SIZES.has(session.image_model) ? session.image_model : DEFAULT_IMAGE_MODEL;
  storyStore.createPrompt(session.user_id, projectId, sceneId, {
    text: prompt,
    exclusions: [],
    referenceRoles: storyScene ? {
      characterIds: storyScene.characterIds,
      locationId: storyScene.locationId || '',
      styleId: '',
    } : {},
    textModel: structured.model,
    temperature: 0.7,
    maxTokens: 4000,
    imageModel,
    imageSize: (IMAGE_MODEL_SIZES.get(imageModel) || ['2K'])[0],
    source: 'ai',
  });

  return sendJSON(res, 200, {
    project: db.getProject(session.user_id, projectId),
    prompt: prompt.slice(0, 30000),
    model: structured.model,
    fallback: structured.fallback,
  });
}

async function generateImageBuffer(apiKey, imageModel, size, prompt) {
  let upstream;
  try {
    upstream = await fetch(BYTEPLUS_IMAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        size,
        response_format: 'b64_json',
        output_format: 'png',
        watermark: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
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
      const imageResponse = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
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

  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt);
  const buffer = generated.buffer;
  const mime = generated.mime;
  const extension = generated.extension;

  const file = `${crypto.randomUUID()}.${extension}`;
  const directory = path.join(IMAGE_DIR, projectId);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file), buffer);
  } catch (err) {
    fail(500, `Could not save the generated image: ${err.message}`, 'IMAGEGEN_SAVE_FAILED');
  }

  const image = {
    sceneId,
    file,
    mime,
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
      projectId,
      sceneId,
      relativePath: `${projectId}/${file}`,
      source: 'generated',
      model: imageModel,
      prompt,
      promptDraftId,
    });
  } catch (err) {
    fail(500, `Could not record the generated asset: ${err.message}`, 'ASSET_RECORD_FAILED');
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

  const prompt = buildCharacterSheetPrompt(character, story);
  const generated = await generateImageBuffer(apiKey, imageModel, size, prompt);

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

  if (pathname === '/api/generation/prompts') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationPrompts(req, res);
  }

  if (pathname === '/api/generation/prompt') {
    if (method !== 'POST') fail(405, 'Method not allowed.');
    return handleGenerationPrompt(req, res);
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
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));

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
    return handleApi(req, res, url.pathname);
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

server.listen(PORT, () => {
  console.log(`\n  Project Workflow App v${APP_VERSION} running:`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  ➜  database: ${db.DB_PATH}\n`);
});
