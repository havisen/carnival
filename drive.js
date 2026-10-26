'use strict';
const crypto = require('node:crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function init(db, security, origin) {
  const testBase = process.env.NODE_ENV === 'test' ? process.env.GOOGLE_DRIVE_TEST_BASE_URL : '';
  const urls = { auth: testBase ? `${testBase}/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: testBase ? `${testBase}/token` : 'https://oauth2.googleapis.com/token',
    api: testBase ? `${testBase}/drive/v3` : 'https://www.googleapis.com/drive/v3',
    upload: testBase ? `${testBase}/upload/drive/v3/files` : 'https://www.googleapis.com/upload/drive/v3/files' };
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = origin ? `${origin}/api/drive/callback` : '';
  const configured = Boolean(clientId && clientSecret && redirectUri);
  const scope = 'https://www.googleapis.com/auth/drive.file';
  db.exec(`CREATE TABLE IF NOT EXISTS drive_connections(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, tokens_enc TEXT NOT NULL, connected_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drive_oauth_states(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL, verifier_enc TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drive_exports(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version_id TEXT NOT NULL, image_id TEXT, info_id TEXT, PRIMARY KEY(user_id,version_id));`);
  const connection = userId => db.prepare('SELECT * FROM drive_connections WHERE user_id = ?').get(userId);
  function status(userId) { const row = connection(userId); return { configured, connected: Boolean(row), redirectUri, connectedAt: row?.connected_at || null }; }
  function connect(session) {
    if (!configured) fail(503, 'Google Drive needs OAuth setup. See Connection setup for the redirect URI and server settings.');
    const state = crypto.randomBytes(32).toString('base64url'); const verifier = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM drive_oauth_states WHERE expires_at < ? OR user_id = ?').run(Date.now(), session.user_id);
    db.prepare('INSERT INTO drive_oauth_states VALUES(?,?,?,?,?)').run(crypto.createHash('sha256').update(state).digest('hex'), session.user_id, session.token_hash, security.encryptApiKey(verifier), Date.now() + 600000);
    const url = new URL(urls.auth);
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.href };
  }
  async function token(body) {
    const response = await fetch(urls.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }), signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) fail(502, 'Google could not authorize this connection. Reconnect Drive or check OAuth setup.');
    const data = await response.json();
    if (!data.access_token) fail(502, 'Google returned no access token. Reconnect Drive.');
    return { ...data, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
  }
  async function callback(session, params) {
    const state = String(params.get('state') || '');
    const hash = crypto.createHash('sha256').update(state).digest('hex');
    const saved = db.prepare('SELECT * FROM drive_oauth_states WHERE hash = ?').get(hash);
    if (!saved || saved.user_id !== session.user_id || saved.session_hash !== session.token_hash || saved.expires_at < Date.now()) fail(400, 'This Drive connection request expired or belongs to another session. Connect again.');
    db.prepare('DELETE FROM drive_oauth_states WHERE hash = ?').run(hash);
    if (params.has('error')) fail(400, 'Google Drive connection was cancelled.');
    const code = String(params.get('code') || ''); if (!code) fail(400, 'No Google authorization code was supplied.');
    const tokens = await token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: security.decryptApiKey(saved.verifier_enc) });
    if (!tokens.refresh_token || !String(tokens.scope || '').split(' ').includes(scope)) fail(400, 'Google did not grant offline Drive file access. Connect again and allow the requested access.');
    db.prepare('INSERT OR REPLACE INTO drive_connections VALUES(?,?,?)').run(session.user_id, security.encryptApiKey(JSON.stringify(tokens)), new Date().toISOString());
    db.prepare('DELETE FROM drive_exports WHERE user_id = ?').run(session.user_id);
  }
  const refreshing = new Map();
  async function access(userId) {
    const row = connection(userId); if (!row) fail(409, 'Connect Google Drive first.');
    let tokens; try { tokens = JSON.parse(security.decryptApiKey(row.tokens_enc)); } catch { fail(409, 'Drive credentials could not be read. Reconnect Drive.'); }
    if (tokens.expires > Date.now() + 60000) return tokens.access_token;
    if (refreshing.has(userId)) return refreshing.get(userId);
    const pending = (async () => {
      const next = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      const merged = { ...tokens, ...next, refresh_token: next.refresh_token || tokens.refresh_token };
      // A disconnected account must never be recreated by a late refresh.
      db.prepare('UPDATE drive_connections SET tokens_enc = ? WHERE user_id = ? AND tokens_enc = ?').run(security.encryptApiKey(JSON.stringify(merged)), userId, row.tokens_enc);
      if (!connection(userId)) fail(409, 'Drive was disconnected.');
      return merged.access_token;
    })();
    refreshing.set(userId, pending); try { return await pending; } finally { refreshing.delete(userId); }
  }
  async function request(userId, suffix, options = {}) {
    const response = await fetch(`${urls.api}${suffix}`, { ...options, headers: { Authorization: `Bearer ${await access(userId)}`, ...(options.headers || {}) }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) fail(502, `Google Drive request failed (${response.status}). Reconnect or try again.`);
    return response;
  }
  async function list(userId) {
    const q = "trashed = false and appProperties has { key='carnival' and value='image' }";
    const response = await request(userId, `/files?${new URLSearchParams({ q, pageSize: '100', fields: 'files(id,name,mimeType,size,webViewLink,appProperties)', orderBy: 'createdTime desc' })}`);
    return response.json();
  }
  async function upload(userId, metadata, bytes, mime) {
    const bearer = `Bearer ${await access(userId)}`;
    const start = await fetch(`${urls.upload}?uploadType=resumable&fields=id,name,webViewLink`, { method: 'POST',
      headers: { Authorization: bearer, 'content-type': 'application/json', 'x-upload-content-type': mime, 'x-upload-content-length': String(bytes.length) }, body: JSON.stringify(metadata), signal: AbortSignal.timeout(30000), redirect: 'error' });
    const location = start.headers.get('location');
    if (!start.ok || !location) fail(502, 'Google Drive could not start the upload.');
    const target = new URL(location);
    if (target.origin !== new URL(urls.upload).origin) fail(502, 'Google Drive returned an unexpected upload address.');
    const response = await fetch(target, { method: 'PUT', headers: { Authorization: bearer, 'content-type': mime }, body: bytes, signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (!response.ok) fail(502, 'Google Drive upload failed. Your Library image is unchanged; try again.');
    return response.json();
  }
  async function save(userId, asset, bytes, metadata) {
    let saved = db.prepare('SELECT * FROM drive_exports WHERE user_id = ? AND version_id = ?').get(userId, asset.versionId);
    if (!saved?.image_id) {
      const image = await upload(userId, { name: asset.name, appProperties: { carnival: 'image', assetVersionId: asset.versionId } }, bytes, asset.mime || 'image/png');
      db.prepare('INSERT OR REPLACE INTO drive_exports(user_id,version_id,image_id,info_id) VALUES(?,?,?,NULL)').run(userId, asset.versionId, image.id);
      saved = { image_id: image.id };
    }
    if (!saved.info_id) {
      const info = await upload(userId, { name: `${asset.name}.prompt.json`, appProperties: { carnival: 'prompt', imageFileId: saved.image_id } }, Buffer.from(JSON.stringify(metadata, null, 2)), 'application/json');
      db.prepare('UPDATE drive_exports SET info_id = ? WHERE user_id = ? AND version_id = ?').run(info.id, userId, asset.versionId);
    }
    return { imageId: saved.image_id, url: `https://drive.google.com/file/d/${encodeURIComponent(saved.image_id)}/view` };
  }
  async function read(userId, id) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail(400, 'Invalid Drive file ID.');
    const metadata = await (await request(userId, `/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,appProperties`)).json();
    if (metadata.appProperties?.carnival !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(metadata.mimeType)) fail(400, 'Choose an image saved by Carnival.');
    if (Number(metadata.size) > 20 * 1024 * 1024) fail(413, 'Drive image is too large (20 MB maximum).');
    const response = await request(userId, `/files/${encodeURIComponent(id)}?alt=media`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) { fail(413, 'Drive image is too large.'); } chunks.push(chunk); }
    const q = `trashed = false and appProperties has { key='imageFileId' and value='${id}' }`;
    const companions = await (await request(userId, `/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`)).json();
    let info = {};
    if (companions.files?.[0]) {
      const extra = await request(userId, `/files/${encodeURIComponent(companions.files[0].id)}?alt=media`);
      const text = await extra.text(); if (text.length <= 200000) { try { info = JSON.parse(text); } catch {} }
    }
    return { metadata, bytes: Buffer.concat(chunks), info };
  }
  function disconnect(userId) {
    db.prepare('DELETE FROM drive_connections WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM drive_oauth_states WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM drive_exports WHERE user_id = ?').run(userId);
  }
  return { status, connect, callback, list, save, read, disconnect };
}
module.exports = { init };
