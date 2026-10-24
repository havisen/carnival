'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { offset: 0, limit: 50, traceId: '', selectedId: '', selected: null, userId: null, loading: false, revision: 0 };
const labels = {
  '/api/generate': 'Generate ideas', '/api/reference': 'Generate reference material',
  '/api/generation/prompts': 'Generate scene prompts', '/api/generation/prompt': 'Regenerate scene prompt',
  '/api/images/generate': 'Generate scene image', '/api/chat': 'Chat', '/api/reviewer/review': 'Review fields',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function display(value) { return value == null ? 'No body captured.' : typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function duration(entry) {
  const ms = entry.durationMs ?? Date.now() - entry.started;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function badge(entry) {
  return element('span', `${entry.statusCode || ''} ${entry.status === 'pending' ? 'in progress' : entry.status}`.trim(), `badge ${entry.status}`);
}
function notice(text, error = false) { $('#message').textContent = text; $('#message').classList.toggle('error', error); }
async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) {
    clearSelection();
    $('#requests').replaceChildren();
    throw new Error('Sign in to Carnival in the app, then refresh this page.');
  }
  if (!response.ok) throw new Error(`Could not load request activity (HTTP ${response.status}).`);
  return response.json();
}

function renderRows(requests) {
  const focusedId = document.activeElement?.closest('tr')?.dataset.id;
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const row = element('tr');
    row.dataset.id = request.id;
    if (request.id === state.selectedId) row.classList.add('selected');
    const time = new Date(request.startedAt);
    const timeCell = element('td', time.toLocaleTimeString([], { hour12: false }));
    timeCell.title = time.toLocaleString();
    timeCell.append(element('span', time.toLocaleDateString([], { month: 'short', day: 'numeric' }), 'request-meta'));
    const description = element('td');
    const button = element('button', labels[request.operation] || request.operation, 'request-select');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(request.id === state.selectedId));
    button.addEventListener('click', () => select(request.id));
    description.append(button, element('span', `${request.direction === 'outgoing' ? '↗' : '↙'} ${request.method} · ${request.provider || 'app'}${request.model ? ' · ' + request.model : ''}`, 'request-meta'));
    if (request.direction === 'outgoing') description.append(element('span', request.url, 'request-meta'));
    const status = element('td'); status.append(badge(request));
    row.append(timeCell, description, status, element('td', duration(request)));
    fragment.append(row);
  }
  $('#requests').replaceChildren(fragment);
  if (focusedId) {
    const focusedRow = [...$('#requests').rows].find((row) => row.dataset.id === focusedId);
    focusedRow?.querySelector('button').focus({ preventScroll: true });
  }
  $('#empty').hidden = requests.length > 0;
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  const revision = state.revision;
  try {
    const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
    for (const [key, value] of [['q', $('#search').value.trim()], ['direction', $('#direction').value], ['status', $('#status').value], ['traceId', state.traceId]]) {
      if (value) params.set(key, value);
    }
    const data = await api('/api/track?' + params);
    if (revision !== state.revision) return;
    if (state.userId && state.userId !== data.userId) {
      clearSelection(); state.traceId = ''; state.offset = 0; state.revision += 1;
      state.userId = data.userId; return;
    }
    state.userId = data.userId;
    renderRows(data.requests);
    for (const key of ['total', 'outgoing', 'pending', 'errors']) $('#stat-' + key).textContent = (data.stats[key] || 0).toLocaleString();
    $('#count').textContent = `(${data.total.toLocaleString()})`;
    $('#scope').textContent = state.traceId ? 'Related calls · reset to show all' : 'Newest first';
    $('#page').textContent = data.total ? `${state.offset + 1}–${Math.min(state.offset + data.limit, data.total)} of ${data.total}` : '0 requests';
    $('#previous').disabled = state.offset === 0;
    $('#next').disabled = state.offset + data.limit >= data.total;
    notice(`${$('#live').checked ? 'Live · ' : 'Paused · '}Updated ${new Date().toLocaleTimeString()}`);
    if (state.selectedId) await loadDetail(state.selectedId, revision);
  } catch (error) { notice(error.message, true); }
  finally {
    state.loading = false;
    if (revision !== state.revision) load();
  }
}

async function select(id) {
  state.selectedId = id;
  for (const button of document.querySelectorAll('.request-select')) {
    const selected = button.closest('tr').dataset.id === id;
    button.closest('tr').classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  try { await loadDetail(id, state.revision); }
  catch (error) { notice(error.message, true); }
}

function clearSelection() {
  state.selectedId = ''; state.selected = null;
  $('#detail').hidden = true; $('#detail-empty').hidden = false;
}

async function loadDetail(id, revision) {
  const { request } = await api('/api/track/' + encodeURIComponent(id));
  if (state.selectedId !== id || state.revision !== revision) return;
  state.selected = request;
  $('#detail-empty').hidden = true; $('#detail').hidden = false;
  const summary = $('#detail-summary');
  summary.replaceChildren(element('h3', labels[request.operation] || request.operation), badge(request), element('p', `${request.method} ${request.url}`, 'detail-url'));
  const facts = element('dl', undefined, 'facts');
  for (const [label, value] of [
    ['Direction', request.direction === 'outgoing' ? 'App → provider' : 'Browser → app'],
    ['Provider', request.provider || 'Carnival'], ['Model', request.model || '—'],
    ['Started', new Date(request.startedAt).toLocaleString()], ['Duration', duration(request)],
    ['Project', request.projectId || '—'], ['Request ID', request.id], ['Trace ID', request.traceId],
  ]) facts.append(element('dt', label), element('dd', value));
  summary.append(facts);
  if (request.error) summary.append(element('p', display(request.error), 'failure'));
  $('#request-body').textContent = display(request.requestBody);
  $('#response-body').textContent = display(request.responseBody);
  $('#request-headers').textContent = display(request.requestHeaders);
  $('#response-headers').textContent = display(request.responseHeaders);
  $('#network').textContent = display({ ...request.network, durationMs: request.durationMs,
    requestBytes: request.requestBytes, responseBytes: request.responseBytes,
    finishedAt: request.finishedAt, parentId: request.parentId });
}

function resetPage() { state.offset = 0; state.revision += 1; load(); }
let debounce;
$('#filters').addEventListener('submit', (event) => { event.preventDefault(); resetPage(); });
$('#search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(resetPage, 250); });
for (const id of ['direction', 'status']) $('#' + id).addEventListener('change', resetPage);
$('#clear').addEventListener('click', () => {
  $('#filters').reset(); state.traceId = ''; resetPage();
});
$('#refresh').addEventListener('click', load);
$('#live').addEventListener('change', () => { if ($('#live').checked) load(); else notice('Paused · refresh manually or resume live updates.'); });
$('#previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); state.revision += 1; load(); });
$('#next').addEventListener('click', () => { state.offset += state.limit; state.revision += 1; load(); });
$('#related').addEventListener('click', () => {
  if (!state.selected) return;
  $('#filters').reset(); state.traceId = state.selected.traceId; resetPage();
});
$('#export').addEventListener('click', () => {
  if (!state.selected) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.selected, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `carnival-request-${state.selected.id}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
setInterval(() => { if ($('#live').checked && !document.hidden) load(); }, 2000);
load();
