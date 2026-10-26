'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_STORED_CHARS = 256 * 1024;
const REDACTED = '[redacted]';
const sensitive = (key) => /^(authorization|proxyauthorization|cookie|setcookie|password|passwordhash|passwordsalt|apikey|key|token|sid|secret|appsecret|signature|sig)$/.test(String(key).replace(/[^a-z0-9]/gi, '').toLowerCase())
  || /apikey|credential|signature|accesskey|secret|token$|^(?:code_verifier|code_challenge)$/i.test(key);

function cleanUrl(value) {
  try {
    const absolute = /^[a-z]+:\/\//i.test(value);
    const url = new URL(value, 'http://localhost');
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of url.searchParams.keys()) {
      if (sensitive(key) || /^(?:code|state)$/i.test(key)) url.searchParams.set(key, REDACTED);
    }
    url.hash = '';
    return absolute ? url.href : url.pathname + url.search;
  } catch (_) { return '[invalid URL]'; }
}

function sanitize(value, secrets = new Set(), depth = 0) {
  if (depth > 30) return '[nested content omitted]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (sensitive(key) && typeof item === 'string' && item) {
        secrets.add(item);
        if (/^Bearer\s+/i.test(item)) secrets.add(item.replace(/^Bearer\s+/i, ''));
        if (/cookie/i.test(key)) {
          for (const part of item.split(';')) {
            const token = part.slice(part.indexOf('=') + 1).trim();
            if (token) secrets.add(token);
          }
        }
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      sensitive(key) ? REDACTED
        : /^(b64_json|base64)$/i.test(key) ? '[image data omitted]'
          : sanitize(item, secrets, depth + 1),
    ]));
  }
  if (typeof value !== 'string') return value;
  let out = value;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/"([^"\\]+)"(\s*:\s*)("(?:\\.|[^"\\])*(?:"|$))/g, (match, key, separator) => (
      sensitive(key) ? `"${key}"${separator}"${REDACTED}"`
        : /^(b64_json|base64)$/i.test(key) ? `"${key}"${separator}"[image data omitted]"` : match
    ))
    .replace(/data:image\/[^;,\s]+;base64,[a-z0-9+/=\s]+/gi, '[image data omitted]')
    .replace(/https?:\/\/[^\s"<>]+/gi, (url) => cleanUrl(url));
  return out.length > MAX_STORED_CHARS ? out.slice(0, MAX_STORED_CHARS) + '\n[truncated]' : out;
}

function bodySnapshot(body, secrets) {
  if (body === undefined || body === null || body === '') return null;
  let parsed = body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    parsed = Object.create(null);
    for (const [name, value] of body.entries()) {
      const item = typeof value === 'string' ? value : '[image data omitted]';
      if (Object.hasOwn(parsed, name)) parsed[name] = [...(Array.isArray(parsed[name]) ? parsed[name] : [parsed[name]]), item];
      else parsed[name] = item;
    }
  }
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch (_) { /* retain malformed provider replies */ }
  }
  const safe = sanitize(parsed, secrets);
  const text = JSON.stringify(safe);
  return text.length > MAX_STORED_CHARS
    ? { truncated: true, preview: text.slice(0, MAX_STORED_CHARS) } : safe;
}

function init(database) {
  const context = new AsyncLocalStorage();
  const requests = new WeakMap();
  database.exec(`
    CREATE TABLE IF NOT EXISTS request_traces (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trace_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_traces_user ON request_traces(user_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_request_traces_group ON request_traces(user_id, trace_id);
  `);
  database.prepare(`UPDATE request_traces SET status = 'interrupted',
    document = json_set(document, '$.status', 'interrupted', '$.error', 'Server stopped before this request completed.')
    WHERE status = 'pending'`).run();
  const insert = database.prepare(`INSERT INTO request_traces
    (id, user_id, trace_id, direction, status, started_at, document) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status, document = excluded.document`);

  function save(entry, state) {
    if (!state.userId) return;
    try {
      insert.run(entry.id, state.userId, entry.traceId, entry.direction, entry.status,
        entry.startedAt, JSON.stringify(sanitize(entry, state.secrets)));
    } catch (_) {
      // Recording must never fail a generation or cause another provider call.
      console.warn('Could not save request trace.');
    }
  }

  function finish(entry, state, patch = {}) {
    Object.assign(entry, patch, { finishedAt: new Date().toISOString(), durationMs: Date.now() - entry.started });
    save(entry, state);
  }

  function run(req, res, userId, dispatch) {
    const id = randomUUID();
    const state = { userId, secrets: new Set(), entry: null };
    requests.set(req, state);
    const requestHeaders = sanitize(req.headers, state.secrets);
    const requestUrl = new URL(req.url, 'http://localhost');
    const projectRoute = requestUrl.pathname.match(/^\/api\/(?:projects|story)\/([^/]+)/);
    const routeProjectId = projectRoute && !['import', 'prompts', 'sheets', 'sheet-image'].includes(projectRoute[1]) ? projectRoute[1] : null;
    const entry = state.entry = {
      id, traceId: id, parentId: null, direction: 'incoming', method: req.method,
      url: cleanUrl(req.url), operation: requestUrl.pathname,
      projectId: requestUrl.searchParams.get('projectId') || routeProjectId, model: null,
      status: 'pending', statusCode: null, started: Date.now(), startedAt: new Date().toISOString(),
      finishedAt: null, durationMs: null, requestHeaders, requestBody: null, responseHeaders: {},
      responseBody: null, requestBytes: 0, responseBytes: 0,
      network: { remoteAddress: req.socket.remoteAddress, httpVersion: req.httpVersion }, error: null,
    };
    save(entry, state);
    res.setHeader('X-Trace-Id', id);
    const chunks = [];
    let headers = {};
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const supplied = typeof args[1] === 'string' ? args[2] : args[1];
      if (supplied && !Array.isArray(supplied)) headers = { ...headers, ...supplied };
      return writeHead.apply(this, args);
    };
    function capture(chunk, encoding) {
      if (!chunk) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
      entry.responseBytes += bytes.length;
      if (entry.responseBytes <= MAX_CAPTURE_BYTES) chunks.push(bytes);
    }
    const write = res.write;
    res.write = function (chunk, encoding, ...args) {
      capture(chunk, encoding);
      return write.call(this, chunk, encoding, ...args);
    };
    const end = res.end;
    res.end = function (chunk, encoding, ...args) {
      capture(chunk, encoding);
      return end.call(this, chunk, encoding, ...args);
    };
    let completed = false;
    function complete(aborted) {
      if (completed) return;
      completed = true;
      entry.responseHeaders = sanitize({ ...res.getHeaders(), ...headers }, state.secrets);
      const type = String(entry.responseHeaders['content-type'] || entry.responseHeaders['Content-Type'] || '');
      const text = /json|text|javascript|xml/.test(type);
      const body = entry.responseBytes > MAX_CAPTURE_BYTES ? '[body omitted: capture limit exceeded]'
        : text ? Buffer.concat(chunks).toString('utf8') : entry.responseBytes ? '[binary body omitted]' : null;
      const responseBody = bodySnapshot(body, state.secrets);
      finish(entry, state, {
        status: aborted ? 'interrupted' : res.statusCode >= 400 ? 'error' : 'success',
        statusCode: res.statusCode, responseBody,
        model: entry.model || responseBody?.model || responseBody?.image?.model || null,
        error: aborted ? 'Client disconnected before the response completed.' : responseBody?.error || null,
      });
    }
    res.once('finish', () => complete(false));
    res.once('close', () => complete(!res.writableFinished));
    return context.run(state, dispatch);
  }

  function identify(userId) {
    const state = context.getStore();
    if (!state) return;
    state.userId = userId;
    save(state.entry, state);
  }

  function requestBody(value, req) {
    const state = req ? requests.get(req) : context.getStore();
    if (!state) return;
    state.entry.requestBody = bodySnapshot(value, state.secrets);
    if (typeof value?.projectId === 'string') state.entry.projectId = value.projectId;
    if (typeof value?.model === 'string') state.entry.model = value.model;
    save(state.entry, state);
  }

  function requestChunk(req, chunk) {
    const state = requests.get(req);
    if (state) state.entry.requestBytes += chunk.length;
  }

  async function trackedFetch(url, options = {}, metadata = {}) {
    const state = context.getStore();
    if (!state?.userId) return fetch(url, options);
    const requestHeaders = sanitize(Object.fromEntries(new Headers(options.headers)), state.secrets);
    const requestBody = bodySnapshot(options.body, state.secrets);
    const entry = {
      id: randomUUID(), traceId: state.entry.traceId, parentId: state.entry.id, direction: 'outgoing',
      method: options.method || 'GET', url: cleanUrl(String(url)), operation: state.entry.operation,
      projectId: state.entry.projectId, provider: metadata.provider || null,
      model: requestBody?.model || state.entry.model, status: 'pending', statusCode: null,
      started: Date.now(), startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      requestHeaders, requestBody, responseHeaders: {}, responseBody: null,
      requestBytes: options.body
        ? (typeof FormData !== 'undefined' && options.body instanceof FormData ? null : Buffer.byteLength(options.body))
        : 0,
      responseBytes: null,
      network: { host: new URL(url).host, protocol: new URL(url).protocol, headersMs: null }, error: null,
    };
    save(entry, state);
    try {
      const response = await fetch(url, options);
      entry.statusCode = response.status;
      entry.responseHeaders = sanitize(Object.fromEntries(response.headers), state.secrets);
      Object.assign(entry.network, { headersMs: Date.now() - entry.started, redirected: response.redirected,
        responseUrl: cleanUrl(response.url || String(url)) });
      const status = response.ok ? 'success' : 'error';
      if (!response.ok) finish(entry, state, { status, error: `HTTP ${response.status} ${response.statusText}` });
      else save(entry, state);
      // Observe the existing body read; do not clone or drain image streams twice.
      for (const method of ['text', 'json', 'arrayBuffer']) {
        const original = response[method].bind(response);
        response[method] = async (...args) => {
          try {
            const body = await original(...args);
            const binary = method === 'arrayBuffer';
            finish(entry, state, { status,
              responseBody: binary ? '[binary body omitted]' : bodySnapshot(body, state.secrets),
              responseBytes: binary ? body.byteLength : Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)),
            });
            return body;
          } catch (error) {
            finish(entry, state, { status: 'error', error: errorDetails(error) });
            throw error;
          }
        };
      }
      return response;
    } catch (error) {
      finish(entry, state, { status: 'error', error: errorDetails(error) });
      throw error;
    }
  }

  function list(userId, params) {
    const clauses = ['user_id = ?'];
    const values = [userId];
    for (const [key, column] of [['direction', 'direction'], ['status', 'status'], ['traceId', 'trace_id']]) {
      if (params.get(key)) { clauses.push(`${column} = ?`); values.push(params.get(key)); }
    }
    if (params.get('q')) { clauses.push('document LIKE ? ESCAPE \'\\\''); values.push('%' + params.get('q').slice(0, 200).replace(/[\\%_]/g, '\\$&') + '%'); }
    const where = clauses.join(' AND ');
    const total = database.prepare(`SELECT COUNT(*) AS count FROM request_traces WHERE ${where}`).get(...values).count;
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
    const offset = Math.max(0, Math.min(1000000, Number(params.get('offset')) || 0));
    const rows = database.prepare(`SELECT sequence, document FROM request_traces WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`)
      .all(...values, Math.floor(limit), Math.floor(offset));
    const requests = rows.map(({ sequence, document }) => {
      const { requestHeaders, requestBody, responseHeaders, responseBody, ...summary } = JSON.parse(document);
      return { ...summary, sequence };
    });
    const stats = database.prepare(`SELECT COUNT(*) AS total,
      SUM(status = 'pending') AS pending, SUM(status IN ('error', 'interrupted')) AS errors,
      SUM(direction = 'outgoing') AS outgoing FROM request_traces WHERE user_id = ?`).get(userId);
    return { userId, requests, total, limit: Math.floor(limit), offset: Math.floor(offset), stats };
  }

  function get(userId, id) {
    const row = database.prepare('SELECT document FROM request_traces WHERE user_id = ? AND id = ?').get(userId, id);
    return row ? JSON.parse(row.document) : null;
  }

  return { run, identify, requestBody, requestChunk, fetch: trackedFetch, list, get };
}

function errorDetails(error) {
  return { name: error.name, message: error.message, code: error.code || error.cause?.code || null,
    cause: error.cause?.message || null };
}

module.exports = { init, sanitize, cleanUrl, bodySnapshot };
