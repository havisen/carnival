'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  user: null,           // { id, username, hasApiKey, apiKeyHint }
  // Carnival umbrella: which module is active, which screen it shows, the story
  // the whole of Story Studio is pointed at, and that story's progress summary.
  ui: {
    module: 'story-studio',
    screen: 'studio-projects',
    view: '',
    shared: '',
    step: '',
    tab: 'projects',
    storyId: '',
    progress: null,
    progressFor: '',
    progressError: '',
    progressLoading: false,
    detailOpen: false,
    libraryDefault: '',
  },
  ideas: [],            // [{ title, description }]
  selected: new Set(),  // indices into state.ideas
  projects: [],         // [{ id, title, idea, description, referenceMaterial, stage, status, priority, createdAt }]
  editingId: null,      // project being edited in the modal
  episodesProjectId: null,
  stageFilter: 'Idea Stage',
  reference: {
    projectId: null,
    count: 1,
    dirty: false,
    // Keep a pool of four so changing the character count does not erase input.
    characters: [
      { name: '', gender: 'Male' },
      { name: '', gender: 'Male' },
      { name: '', gender: 'Male' },
      { name: '', gender: 'Male' },
    ],
  },
  generation: {
    projectId: null,
    task: null,
    references: null,
    draft: null,
    edits: {},
    runProgress: {},
    focusPromptId: null,
    imageModel: '',
    imageSizes: [],
    loading: false,
    building: false,
    saving: false,
    reviewing: false,
    running: false,
    error: '',
  },
  library: {
    loaded: false,
    loading: false,
    images: [],
    collections: [],
    error: null,
    search: '',
    selectedId: null,
    selectedAssetId: null,
    currentAsset: null,
    reviewData: null,
    filters: {
      projectId: '',
      episodeId: '',
      collectionId: '',
      tag: '',
      type: '',
      status: '',
      duplicate: false,
      missing: false,
      unassigned: false,
    },
  },
  characters: {
    loaded: false,
    loading: false,
    error: '',
    items: [],
    selectedId: '',
    formFor: '',
    saving: false,
    generating: false,
  },
  projectCharacters: {
    projectId: '',
    loadedFor: '',
    loading: false,
    error: '',
    items: [],
    selectedId: '',
    formFor: '',
    saving: false,
    generating: false,
    makers: [],
  },
  generator: {
    loaded: false,
    loading: false,
    error: '',
    generations: [],
    presets: [],
    uploads: [],
    libraryImages: [],
    characterSources: [],
    references: [],
    selectedPresetId: '',
    generating: false,
    maxReferences: 10,
    savingModel: false,
    mode: 'single',
    layout: 'grid-2x2',
    panels: ['', '', '', ''],
    uploading: false,
    uploadToken: 0,
    runToken: 0,
  },
  story: {
    loaded: false,
    loading: false,
    projectId: '',
    data: null,
    error: null,
    editor: null,
    dirty: false,
    sheetCharacterId: '',
    worksheetOpen: false,
    actionDraft: null,
    locationDraft: null,
  },
  sidebar: {
    projectId: '',
    story: null,
    storyProjectId: '',
    track: [],
  },
  chat: {
    mode: 'guide',
    guide: [],
    reviewer: [],
    busy: false,
  },
  reviewer: {
    projectId: '',
    box: 'scene-prompts',
    fields: [],
    loading: false,
    running: false,
    error: '',
    loadToken: 0,
    runToken: 0,
    loadedProjectId: '',
    loadedBox: '',
  },
};

const AUTH_TAB_KEY = 'projectWorkflow.lastTab';
const PROJECT_STATUSES = ['Not Started', 'In Progress', 'Done'];
const PROJECT_STAGES = ['Idea Stage', 'Reference Stage', 'Generation Stage'];
const PM_TABS = [...PROJECT_STAGES, 'Completed'];
const REVIEWER_BOX_OPTIONS = [
  { id: 'scene-prompts', label: 'Scene Prompts' },
  { id: 'scene-outline', label: 'Scene Outline' },
  { id: 'story-brief', label: 'Story Brief' },
  { id: 'characters', label: 'Character Bibles' },
  { id: 'locations', label: 'Locations' },
  { id: 'styles', label: 'Style References' },
  { id: 'reference-material', label: 'Reference Material' },
  { id: 'project-details', label: 'Project Details' },
];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3600);
}

// ---------------------------------------------------------------------------
// Floating process tracker
// ---------------------------------------------------------------------------
const activeProcesses = new Map();
let processSequence = 0;
let processTimer = null;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderProcesses() {
  const widget = $('#process-widget');
  const list = $('#process-list');
  if (!widget || !list) return;

  list.innerHTML = '';
  if (!activeProcesses.size) {
    widget.classList.add('hidden');
    if (processTimer) {
      clearInterval(processTimer);
      processTimer = null;
    }
    return;
  }

  widget.classList.remove('hidden');
  $('#process-count').textContent = String(activeProcesses.size);

  Array.from(activeProcesses.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .forEach((process) => {
      const row = document.createElement('div');
      row.className = 'process-item';

      const spinner = document.createElement('span');
      spinner.className = 'spinner-ring process-spinner';

      const label = document.createElement('span');
      label.className = 'process-item-label';
      label.textContent = process.label;

      const time = document.createElement('span');
      time.className = 'process-time';
      time.textContent = formatElapsed(Date.now() - process.startedAt);

      row.append(spinner, label, time);
      list.appendChild(row);
    });

  if (!processTimer) {
    processTimer = setInterval(renderProcesses, 1000);
  }
}

function startProcess(label) {
  const id = `process-${++processSequence}`;
  activeProcesses.set(id, { label, startedAt: Date.now() });
  renderProcesses();
  return id;
}

function updateProcess(id, label) {
  const process = activeProcesses.get(id);
  if (!process) return;
  process.label = label;
  renderProcesses();
}

function finishProcess(id) {
  if (!id) return;
  activeProcesses.delete(id);
  renderProcesses();
}

function clearProcesses() {
  activeProcesses.clear();
  renderProcesses();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const formData = body instanceof FormData;
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || formData ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : formData ? body : JSON.stringify(body),
    });
  } catch (_) {
    throw new ApiError('Network error. Check your connection and try again.', 0);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && state.user) {
      expireSession();
    }
    throw new ApiError(
      (data && data.error) || `Request failed (${res.status}).`,
      res.status,
      data && data.code
    );
  }
  return data || {};
}

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach((tab) => {
    const active = tab.dataset.authTab === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').classList.add('hidden');
  try {
    localStorage.setItem(AUTH_TAB_KEY, mode);
  } catch (_) { /* ignore */ }
}

function showAuthError(message) {
  const el = $('#auth-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideBoot() {
  const boot = $('#boot-screen');
  if (boot) boot.classList.add('hidden');
}

function showAuth() {
  state.user = null;
  hideBoot();
  $('#app-shell').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-password').value = '';
  $('#api-key').value = '';
  setAuthMode(authMode === 'register' ? 'register' : 'login');
}

function showApp() {
  hideBoot();
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#user-name').textContent = '@' + state.user.username;
  renderKeyState();
  renderBytePlusKeyState();
  renderAnthropicKeyState();
  renderOpenAIKeyState();
  renderDirectOpenAIKeyState();
  applyAiSettings();
  applyChatSettings();
  startSidebarTrackPolling();
  if (typeof workspaceStarted === 'function') workspaceStarted();
}

function expireSession() {
  state.user = null;
  state.projects = [];
  state.ideas = [];
  state.selected.clear();
  clearProcesses();
  stopSidebarTrackPolling();
  resetSidebarTrack();
  resetLibrary();
  resetCharacters();
  resetProjectCharacters();
  resetGenerator();
  resetSidebarAndChat();
  resetStudio();
  setStageFilter('Idea Stage');
  authMode = 'login';
  showAuth();
  toast('Your session expired. Please sign in again.', 'error');
}

async function enterApp() {
  showApp();
  try {
    await loadProjects();
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'Could not load projects.', 'error');
  }
  await importLegacyProjects();
  renderIdeas();
  initModuleNavigation();
}

async function initAuth() {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    await enterApp();
  } catch (err) {
    if (err.status === 401) {
      showAuth();
    } else {
      showAuth();
      showAuthError(err.message || 'Could not reach the server.');
    }
  }
}

$$('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
});

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;

  if (!username || !password) {
    showAuthError('Enter your username and password.');
    return;
  }

  const submit = $('#auth-submit');
  submit.disabled = true;
  submit.textContent = authMode === 'login' ? 'Signing in…' : 'Creating account…';

  try {
    const { user } = await api('/api/auth/' + authMode, {
      method: 'POST',
      body: { username, password },
    });
    state.user = user;
    $('#auth-password').value = '';
    await enterApp();
    toast(authMode === 'login' ? `Welcome back, ${user.username}.` : 'Account created.', 'success');
  } catch (err) {
    showAuthError(err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (_) { /* signing out locally is enough */ }

  state.user = null;
  state.projects = [];
  state.ideas = [];
  state.selected.clear();
  clearProcesses();
  stopSidebarTrackPolling();
  resetSidebarTrack();
  resetLibrary();
  resetCharacters();
  resetProjectCharacters();
  resetGenerator();
  state.reference.projectId = null;
  state.reference.dirty = false;
  state.reference.count = 1;
  state.reference.characters = [
    { name: '', gender: 'Male' },
    { name: '', gender: 'Male' },
    { name: '', gender: 'Male' },
    { name: '', gender: 'Male' },
  ];
  state.generation.projectId = null;
  resetGenerationView();
  resetSidebarAndChat();
  $('#ref-character-count').value = '1';
  $('#ref-setting').value = '';
  setStageFilter('Idea Stage');
  renderCharacterFields();
  renderProjects();
  renderIdeas();
  renderReferenceProjects();
  renderGenerationProjects();
  renderChat();
  authMode = 'login';
  showAuth();
  toast('Signed out.');
});

// ---------------------------------------------------------------------------
// API key (stored server-side; only the masked hint comes back)
// ---------------------------------------------------------------------------
function renderKeyState() {
  const saved = Boolean(state.user && state.user.hasApiKey);
  $('#key-empty').classList.toggle('hidden', saved);
  $('#key-saved').classList.toggle('hidden', !saved);
  $('#key-hint').textContent = saved ? state.user.apiKeyHint || 'saved key' : '—';
  $('#key-label').textContent = saved ? 'Replace DeepSeek API key' : 'Add DeepSeek API key';
  $('#save-key').textContent = saved ? 'Update key' : 'Save key';
  $('#remove-key').classList.toggle('hidden', !saved);

  const status = $('#apis-deepseek-status');
  status.textContent = saved ? 'DeepSeek: connected' : 'DeepSeek: no key';
  status.classList.toggle('connected', saved);
  status.classList.toggle('missing', !saved);
}

$('#toggle-key').addEventListener('click', () => {
  const input = $('#api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('#toggle-key').textContent = isPassword ? '🙈' : '👁';
});

$('#save-key').addEventListener('click', async () => {
  const apiKey = $('#api-key').value.trim();
  if (!apiKey) {
    toast('Paste your DeepSeek API key first.', 'error');
    $('#api-key').focus();
    return;
  }

  const button = $('#save-key');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/api-key', { method: 'PUT', body: { apiKey } });
    state.user = user;
    $('#api-key').value = '';
    renderKeyState();
    renderChat();
    toast('API key saved to your account.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the API key.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('#remove-key').addEventListener('click', async () => {
  if (!confirm('Remove the saved DeepSeek API key from your account?')) return;
  try {
    const { user } = await api('/api/me/api-key', { method: 'DELETE' });
    state.user = user;
    renderKeyState();
    renderChat();
    toast('Saved API key removed.', 'success');
  } catch (err) {
    toast(err.message || 'Could not remove the API key.', 'error');
  }
});

// ---------------------------------------------------------------------------
// BytePlus image API key
// ---------------------------------------------------------------------------
function renderBytePlusKeyState() {
  const saved = Boolean(state.user && state.user.hasBytePlusKey);
  $('#bp-key-empty').classList.toggle('hidden', saved);
  $('#bp-key-saved').classList.toggle('hidden', !saved);
  $('#bp-key-hint').textContent = saved ? state.user.byteplusKeyHint || 'saved key' : '—';
  $('#bp-key-label').textContent = saved ? 'Replace BytePlus API key' : 'Add BytePlus API key';
  $('#bp-save-key').textContent = saved ? 'Update key' : 'Save key';
  $('#bp-remove-key').classList.toggle('hidden', !saved);

  const status = $('#apis-byteplus-status');
  status.textContent = saved ? 'BytePlus: connected' : 'BytePlus: no key';
  status.classList.toggle('connected', saved);
  status.classList.toggle('missing', !saved);
  refreshImageTools();
}

$('#bp-toggle-key').addEventListener('click', () => {
  const input = $('#bp-api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('#bp-toggle-key').textContent = isPassword ? '🙈' : '👁';
});

$('#bp-save-key').addEventListener('click', async () => {
  const apiKey = $('#bp-api-key').value.trim();
  if (!apiKey) {
    toast('Paste your BytePlus API key first.', 'error');
    $('#bp-api-key').focus();
    return;
  }

  const button = $('#bp-save-key');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/byteplus-key', { method: 'PUT', body: { apiKey } });
    state.user = user;
    $('#bp-api-key').value = '';
    renderBytePlusKeyState();
    toast('BytePlus API key saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the BytePlus API key.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('#bp-remove-key').addEventListener('click', async () => {
  if (!confirm('Remove the saved BytePlus API key from your account?')) return;
  try {
    const { user } = await api('/api/me/byteplus-key', { method: 'DELETE' });
    state.user = user;
    renderBytePlusKeyState();
    toast('Saved BytePlus API key removed.', 'success');
  } catch (err) {
    toast(err.message || 'Could not remove the BytePlus API key.', 'error');
  }
});

// ---------------------------------------------------------------------------
// Anthropic API key
// ---------------------------------------------------------------------------
function renderAnthropicKeyState() {
  const saved = Boolean(state.user && state.user.hasAnthropicKey);
  $('#anthropic-key-empty').classList.toggle('hidden', saved);
  $('#anthropic-key-saved').classList.toggle('hidden', !saved);
  $('#anthropic-key-hint').textContent = saved ? state.user.anthropicKeyHint || 'saved key' : '—';
  $('#anthropic-key-label').textContent = saved ? 'Replace Anthropic API key' : 'Add Anthropic API key';
  $('#anthropic-save-key').textContent = saved ? 'Update key' : 'Save key';
  $('#anthropic-remove-key').classList.toggle('hidden', !saved);
}

$('#anthropic-toggle-key').addEventListener('click', () => {
  const input = $('#anthropic-api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('#anthropic-toggle-key').textContent = isPassword ? '🙈' : '👁';
});

$('#anthropic-save-key').addEventListener('click', async () => {
  const apiKey = $('#anthropic-api-key').value.trim();
  if (!apiKey) {
    toast('Paste your Anthropic API key first.', 'error');
    $('#anthropic-api-key').focus();
    return;
  }
  const button = $('#anthropic-save-key');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/anthropic-key', { method: 'PUT', body: { apiKey } });
    state.user = user;
    $('#anthropic-api-key').value = '';
    renderAnthropicKeyState();
    renderChat();
    toast('Anthropic API key saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the Anthropic API key.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('#anthropic-remove-key').addEventListener('click', async () => {
  if (!confirm('Remove the saved Anthropic API key from your account?')) return;
  try {
    const { user } = await api('/api/me/anthropic-key', { method: 'DELETE' });
    state.user = user;
    renderAnthropicKeyState();
    renderChat();
    toast('Saved Anthropic API key removed.', 'success');
  } catch (err) {
    toast(err.message || 'Could not remove the Anthropic API key.', 'error');
  }
});

// ---------------------------------------------------------------------------
// OpenAI-compatible API key
// ---------------------------------------------------------------------------
function renderOpenAIKeyState() {
  const saved = Boolean(state.user && state.user.hasOpenAIKey);
  $('#openai-key-empty').classList.toggle('hidden', saved);
  $('#openai-key-saved').classList.toggle('hidden', !saved);
  $('#openai-key-hint').textContent = saved ? state.user.openAIKeyHint || 'saved key' : '—';
  $('#openai-key-label').textContent = saved ? 'Replace OpenAI-compatible API key' : 'Add OpenAI-compatible API key';
  $('#openai-save-key').textContent = saved ? 'Update key' : 'Save key';
  $('#openai-remove-key').classList.toggle('hidden', !saved);
  refreshImageTools();
}

$('#openai-toggle-key').addEventListener('click', () => {
  const input = $('#openai-api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('#openai-toggle-key').textContent = isPassword ? '🙈' : '👁';
});

$('#openai-save-key').addEventListener('click', async () => {
  const apiKey = $('#openai-api-key').value.trim();
  if (!apiKey) {
    toast('Paste your OpenAI-compatible API key first.', 'error');
    $('#openai-api-key').focus();
    return;
  }
  const button = $('#openai-save-key');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/openai-key', {
      method: 'PUT',
      body: { apiKey, baseUrl: $('#openai-base-url').value.trim() },
    });
    state.user = user;
    $('#openai-api-key').value = '';
    renderOpenAIKeyState();
    applyChatSettings();
    renderChat();
    toast('OpenAI-compatible API key saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the OpenAI-compatible API key.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('#openai-remove-key').addEventListener('click', async () => {
  if (!confirm('Remove the saved OpenAI-compatible API key from your account?')) return;
  try {
    const { user } = await api('/api/me/openai-key', { method: 'DELETE' });
    state.user = user;
    renderOpenAIKeyState();
    applyChatSettings();
    renderChat();
    toast('Saved OpenAI-compatible API key removed.', 'success');
  } catch (err) {
    toast(err.message || 'Could not remove the OpenAI-compatible API key.', 'error');
  }
});

// ---------------------------------------------------------------------------
// Chat assistants (Guide + Reviewer)
// ---------------------------------------------------------------------------
function renderDirectOpenAIKeyState() {
  const saved = Boolean(state.user && state.user.hasDirectOpenAIKey);
  $('#openai-direct-key-empty').classList.toggle('hidden', saved);
  $('#openai-direct-key-saved').classList.toggle('hidden', !saved);
  $('#openai-direct-key-hint').textContent = saved ? state.user.directOpenAIKeyHint || 'saved key' : '—';
  $('#openai-direct-key-label').textContent = saved ? 'Replace OpenAI API key' : 'Add OpenAI API key';
  $('#openai-direct-save-key').textContent = saved ? 'Update key' : 'Save key';
  $('#openai-direct-remove-key').classList.toggle('hidden', !saved);
  refreshImageTools();
}

$('#openai-direct-toggle-key').addEventListener('click', () => {
  const input = $('#openai-direct-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#openai-direct-toggle-key').textContent = input.type === 'password' ? '👁' : '🙈';
});

$('#openai-direct-save-key').addEventListener('click', async () => {
  const apiKey = $('#openai-direct-api-key').value.trim();
  if (!apiKey) { toast('Paste your OpenAI API key first.', 'error'); $('#openai-direct-api-key').focus(); return; }
  const button = $('#openai-direct-save-key');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/openai-direct-key', { method: 'PUT', body: { apiKey } });
    state.user = user;
    $('#openai-direct-api-key').value = '';
    renderDirectOpenAIKeyState();
    applyChatSettings(); renderChat();
    toast('OpenAI API key saved.', 'success');
  } catch (err) { toast(err.message || 'Could not save the OpenAI API key.', 'error'); }
  finally { button.disabled = false; }
});

$('#openai-direct-remove-key').addEventListener('click', async () => {
  if (!confirm('Remove the saved OpenAI API key from your account?')) return;
  try {
    const { user } = await api('/api/me/openai-direct-key', { method: 'DELETE' });
    state.user = user;
    renderDirectOpenAIKeyState();
    applyChatSettings(); renderChat();
    toast('Saved OpenAI API key removed.', 'success');
  } catch (err) { toast(err.message || 'Could not remove the OpenAI API key.', 'error'); }
});

function applyChatSettings() {
  if (!state.user) return;
  $('#guide-provider').value = state.user.guideProvider || 'deepseek';
  $('#guide-model').value = state.user.guideModel || '';
  $('#guide-context').value = state.user.guideContext || '';
  $('#reviewer-provider').value = state.user.reviewerProvider || 'deepseek';
  $('#reviewer-model').value = state.user.reviewerModel || '';
  $('#reviewer-context').value = state.user.reviewerContext || '';
  $('#openai-base-url').value = state.user.openAIBaseUrl || '';
}

$('#save-chat-settings').addEventListener('click', async () => {
  const button = $('#save-chat-settings');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/chat-settings', {
      method: 'PUT',
      body: {
        guideProvider: $('#guide-provider').value,
        guideModel: $('#guide-model').value,
        guideContext: $('#guide-context').value,
        reviewerProvider: $('#reviewer-provider').value,
        reviewerModel: $('#reviewer-model').value,
        reviewerContext: $('#reviewer-context').value,
      },
    });
    state.user = user;
    applyChatSettings();
    renderChat();
    state.reviewer.loadedProjectId = '';
    renderReviewer();
    $('#chat-settings-hint').textContent = 'Chat settings saved.';
    toast('Chat settings saved.', 'success');
  } catch (err) {
    $('#chat-settings-hint').textContent = 'Could not save chat settings.';
    toast(err.message || 'Could not save chat settings.', 'error');
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// AI model preferences
// ---------------------------------------------------------------------------
const TEXT_MODEL_LABELS = {
  'deepseek-v4-pro': 'DeepSeek 4 Pro',
};
const IMAGE_MODEL_LABELS = Object.fromEntries(CARNIVAL_IMAGE_MODELS.map((model) => [model.id, model.label]));
const IMAGE_MODEL_SIZES = Object.fromEntries(CARNIVAL_IMAGE_MODELS.map((model) => [model.id, model.sizes]));

function currentTextModel() {
  return state.user?.textModel || 'deepseek-v4-pro';
}

function currentImageModel() {
  return state.user && IMAGE_MODEL_LABELS[state.user.imageModel]
    ? state.user.imageModel
    : 'dola-seedream-5-0-pro-260628';
}

function imageProviderLabel() {
  if (CARNIVAL_IMAGE_MODELS.find((model) => model.id === currentImageModel())?.provider !== 'openai') return 'BytePlus';
  return state.user?.openAIImageProvider === 'openai-direct' ? 'OpenAI' : 'OpenAI-compatible';
}

function imageKeySelector() {
  return imageProviderLabel() === 'BytePlus' ? '#bp-api-key' : imageProviderLabel() === 'OpenAI' ? '#openai-direct-api-key' : '#openai-api-key';
}

function hasImageApiKey() {
  return Boolean(state.user && (imageProviderLabel() === 'BytePlus' ? state.user.hasBytePlusKey
    : imageProviderLabel() === 'OpenAI' ? state.user.hasDirectOpenAIKey : state.user.hasOpenAIKey));
}

function handleMissingImageKey(error) {
  if (!state.user) return;
  if (error.code === 'NO_DIRECT_OPENAI_KEY') {
    state.user.hasDirectOpenAIKey = false;
    renderDirectOpenAIKeyState();
  } else if (error.code === 'NO_OPENAI_IMAGE_KEY') {
    state.user.hasOpenAIKey = false;
    renderOpenAIKeyState();
  } else if (error.code === 'NO_IMAGEGEN_KEY') {
    state.user.hasBytePlusKey = false;
    renderBytePlusKeyState();
  }
}

function applyImageModelOptions(selector, selected = currentImageModel()) {
  const select = $(selector);
  if (!select) return;
  if (!select.dataset.catalogReady) {
    select.innerHTML = '';
    for (const provider of ['byteplus', 'openai']) {
      const group = document.createElement('optgroup');
      group.label = provider === 'openai' ? 'OpenAI · GPT Image' : 'BytePlus · Seedream';
      CARNIVAL_IMAGE_MODELS.filter((model) => model.provider === provider).forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.label;
        group.appendChild(option);
      });
      select.appendChild(group);
    }
    select.dataset.catalogReady = 'true';
  }
  select.value = selected;
}

function refreshImageTools() {
  if (!state.user) return;
  applyAiSettings();
  if (state.generator.loaded) renderGenerator();
  if (state.characters.loaded) renderCharacters();
  if (state.projectCharacters.loaded) renderProjectCharacters();
}

function applyImageSizeOptions(imageModel, selector = '#gen-image-size') {
  const select = $(selector);
  if (!select) return;
  const sizes = IMAGE_MODEL_SIZES[imageModel] || IMAGE_MODEL_SIZES['dola-seedream-5-0-pro-260628'];
  const previous = select.value;
  select.innerHTML = '';
  sizes.forEach((size) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    select.appendChild(option);
  });
  select.value = sizes.includes(previous) ? previous : (sizes.includes('2K') ? '2K' : sizes[0]);
}

function applyAiSettings() {
  if (!state.user) return;
  const textModel = currentTextModel();
  const imageModel = currentImageModel();

  $('#text-model-pref').value = textModel;
  if (typeof fillProviderOptions === 'function') fillProviderOptions($('#text-provider-pref'), state.user.textProvider || 'deepseek');
  $('#openai-image-provider').value = state.user.openAIImageProvider || 'openai-direct';
  applyImageModelOptions('#image-model-pref', imageModel);
  applyImageModelOptions('#generator-model', imageModel);
  ['#model', '#ref-model', '#gen-model'].forEach((selector) => {
    const input = $(selector);
    if (input) input.value = textModel;
  });

  $('#route-text-label').textContent = TEXT_MODEL_LABELS[textModel] || textModel;
  $('#route-image-label').textContent = IMAGE_MODEL_LABELS[imageModel] || imageModel;
  $('#gen-image-model-label').textContent = IMAGE_MODEL_LABELS[imageModel] || imageModel;
  applyImageSizeOptions(imageModel);
  applyImageSizeOptions(imageModel, '#character-size');
  applyImageSizeOptions(imageModel, '#project-character-size');
  applyImageSizeOptions(imageModel, '#generator-size');
}

$('#save-ai-settings').addEventListener('click', async () => {
  const textModel = $('#text-model-pref').value;
  const imageModel = $('#image-model-pref').value;
  const button = $('#save-ai-settings');
  button.disabled = true;
  try {
    const { user } = await api('/api/me/ai-settings', {
      method: 'PUT',
      body: { textModel, imageModel, textProvider: $('#text-provider-pref').value, openAIImageProvider: $('#openai-image-provider').value },
    });
    state.user = user;
    applyAiSettings();
    renderKeyState();
    renderBytePlusKeyState();
    $('#ai-settings-hint').textContent = 'Model preferences saved.';
    toast('AI model preferences saved.', 'success');
  } catch (err) {
    $('#ai-settings-hint').textContent = 'Could not save model preferences.';
    toast(err.message || 'Could not save model preferences.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('#text-model-pref').addEventListener('change', () => {
  $('#ai-settings-hint').textContent = 'Unsaved text-model change. Click Save model preferences.';
});
$('#image-model-pref').addEventListener('change', () => {
  $('#ai-settings-hint').textContent = 'Unsaved image-model change. Click Save model preferences.';
});
$('#openai-image-provider').addEventListener('change', () => {
  $('#ai-settings-hint').textContent = 'Unsaved GPT Image provider change. Click Save model preferences.';
});

$$('.open-apis').forEach((button) => {
  button.addEventListener('click', () => switchTab('apis'));
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
let libraryReturnFocus = null;
const LIBRARY_REVIEW_DECISIONS = new Set(['APPROVED', 'REVISE', 'REJECT', 'OWNER REVIEW']);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Not recorded';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLibraryDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString();
}

function libraryRecorded(value) {
  return value === undefined || value === null || value === '' ? 'Not recorded' : String(value);
}

function libraryReviewLabel(metadata) {
  const decision = metadata && metadata.reviewDecision;
  return LIBRARY_REVIEW_DECISIONS.has(decision) ? decision : 'Not recorded';
}

function libraryReviewClass(decision) {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'REVISE') return 'revise';
  if (decision === 'REJECT') return 'reject';
  if (decision === 'OWNER REVIEW') return 'owner';
  return '';
}

function libraryFilteredImages() {
  const filters = state.library.filters;
  const query = state.library.search.trim().toLowerCase();
  return state.library.images.filter((image) => {
    const metadata = image.metadata || {};
    if (state.library.section === 'sheets' && image.source !== 'character-reference-sheet') return false;
    if (query && !`${image.name || ''} ${image.relativePath || ''} ${image.label || ''}`.toLowerCase().includes(query)) return false;
    if (filters.projectId && metadata.projectId !== filters.projectId) return false;
    if (filters.episodeId && metadata.episodeId !== filters.episodeId) return false;
    if (filters.collectionId && !(image.collections || []).some((item) => item.id === filters.collectionId)) return false;
    if (filters.tag && !(image.tags || []).some((item) =>
      item.id === filters.tag || item.name.toLowerCase() === filters.tag.toLowerCase()
    )) return false;
    if (filters.type && image.extension !== filters.type) return false;
    if (filters.status && image.lifecycleStatus !== filters.status) return false;
    if (filters.duplicate && !(image.duplicateCount > 1)) return false;
    if (filters.missing && !image.missing) return false;
    if (filters.unassigned && metadata.projectId) return false;
    return true;
  });
}

function setSelectOptions(select, values, placeholder) {
  const current = select.value;
  select.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  values.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = values.some((item) => item.value === current) ? current : '';
}

function renderLibraryFilters() {
  const images = state.library.images;
  const projects = new Map();
  const episodes = new Map();
  const collections = new Map(state.library.collections.map((item) => [item.id, item.name]));
  const tags = new Map();
  const types = new Set();
  const statuses = new Set();
  images.forEach((image) => {
    const metadata = image.metadata || {};
    if (metadata.projectId) projects.set(metadata.projectId, metadata.projectTitle || metadata.projectId);
    if (metadata.episodeId) episodes.set(metadata.episodeId, metadata.episodeTitle || metadata.episodeId);
    (image.collections || []).forEach((item) => collections.set(item.id, item.name));
    (image.tags || []).forEach((item) => tags.set(item.id, item.name));
    if (image.extension) types.add(image.extension);
    if (image.lifecycleStatus) statuses.add(image.lifecycleStatus);
  });

  setSelectOptions($('#library-project-filter'),
    Array.from(projects, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    'All projects');
  setSelectOptions($('#library-episode-filter'),
    Array.from(episodes, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    'All episodes');
  setSelectOptions($('#library-collection-filter'),
    Array.from(collections, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    'All collections');
  setSelectOptions($('#library-tag-filter'),
    Array.from(tags, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    'All tags');
  setSelectOptions($('#library-type-filter'),
    Array.from(types).sort().map((value) => ({ value, label: value.toUpperCase() })),
    'All types');
  setSelectOptions($('#library-status-filter'),
    Array.from(statuses).sort().map((value) => ({ value, label: value })),
    'All statuses');
  $('#library-project-filter').value = state.library.filters.projectId;
  $('#library-episode-filter').value = state.library.filters.episodeId;
  $('#library-collection-filter').value = state.library.filters.collectionId;
  $('#library-tag-filter').value = state.library.filters.tag;
  $('#library-type-filter').value = state.library.filters.type;
  $('#library-status-filter').value = state.library.filters.status;
  $('#library-duplicate-filter').checked = state.library.filters.duplicate;
  $('#library-missing-filter').checked = state.library.filters.missing;
  $('#library-unassigned-filter').checked = state.library.filters.unassigned;
}

function renderLibrary() {
  const loading = $('#library-loading');
  const empty = $('#library-empty');
  const error = $('#library-error');
  const summary = $('#library-summary');
  const grid = $('#library-grid');

  grid.innerHTML = '';
  if (state.library.loading) {
    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    error.classList.add('hidden');
    summary.classList.add('hidden');
    grid.classList.add('hidden');
    return;
  }
  loading.classList.add('hidden');

  if (state.library.error) {
    error.classList.remove('hidden');
    empty.classList.add('hidden');
    summary.classList.add('hidden');
    grid.classList.add('hidden');
    $('#library-error-text').textContent = state.library.error;
    return;
  }
  error.classList.add('hidden');

  if (!state.library.images.length) {
    empty.classList.remove('hidden');
    summary.classList.add('hidden');
    grid.classList.add('hidden');
    renderLibraryFilters();
    $('#library-empty p').innerHTML = 'No images found. Images placed in <code>data/images</code> will appear here.';
    return;
  }

  renderLibraryFilters();
  const images = libraryFilteredImages();
  if (!images.length) {
    empty.classList.remove('hidden');
    summary.classList.add('hidden');
    grid.classList.add('hidden');
    $('#library-empty p').textContent = 'No images match your search.';
    return;
  }

  empty.classList.add('hidden');
  summary.classList.remove('hidden');
  grid.classList.remove('hidden');
  $('#library-count').textContent = images.length === state.library.images.length
    ? `${images.length} image${images.length === 1 ? '' : 's'}`
    : `${images.length} of ${state.library.images.length} images`;

  images.forEach((image) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'library-card';
    card.dataset.libraryId = image.id;
    card.setAttribute('aria-label', `Inspect ${image.name}`);
    card.setAttribute('aria-haspopup', 'dialog');

    const thumb = document.createElement('span');
    thumb.className = 'library-thumb';
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    if (image.width) img.width = image.width;
    if (image.height) img.height = image.height;
    img.addEventListener('error', () => {
      img.remove();
      const fallback = document.createElement('span');
      fallback.className = 'library-thumb-fallback';
      fallback.textContent = 'Preview unavailable';
      thumb.appendChild(fallback);
    });
    thumb.appendChild(img);

    const body = document.createElement('span');
    body.className = 'library-card-body';
    const name = document.createElement('span');
    name.className = 'library-card-name';
    name.textContent = image.label || image.name;
    const pathLabel = document.createElement('span');
    pathLabel.className = 'library-card-path';
    pathLabel.textContent = image.relativePath;
    const decision = image.reviewDecision && image.reviewDecision !== 'NOT REVIEWED'
      ? image.reviewDecision
      : 'Not reviewed';
    const badge = document.createElement('span');
    badge.className = `library-badge ${libraryReviewClass(decision)}`.trim();
    badge.textContent = image.staleReview ? `Content: ${decision} · earlier revision` : `Content: ${decision}`;
    body.append(name, pathLabel, badge);
    if (image.publicationReady) {
      const publication = document.createElement('span');
      publication.className = 'library-badge approved';
      publication.textContent = 'Publication ready';
      body.appendChild(publication);
    }
    card.append(thumb, body);
    card.addEventListener('click', () => openLibraryDetail(image.id));
    grid.appendChild(card);
  });
}

async function loadLibrary(force = false) {
  if (state.library.loading) return;
  if (state.library.loaded && !force) {
    renderLibrary();
    return;
  }

  state.library.loading = true;
  state.library.error = null;
  renderLibrary();

  try {
    const [data, collectionsResult] = await Promise.all([
      api('/api/library'),
      api('/api/collections').catch(() => ({ collections: [] })),
    ]);
    state.library.images = Array.isArray(data.images) ? data.images : [];
    state.library.collections = Array.isArray(collectionsResult.collections) ? collectionsResult.collections : [];
    state.library.loaded = true;
  } catch (err) {
    state.library.error = err.message || 'Could not load the library.';
    state.library.loaded = false;
    if (state.library.images.length) toast(state.library.error, 'error');
  } finally {
    state.library.loading = false;
    renderLibrary();
  }
}

function addLibraryFact(list, label, value, options = {}) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (options.code) {
    const code = document.createElement('code');
    code.textContent = value;
    dd.appendChild(code);
  } else {
    dd.textContent = value;
  }
  list.append(dt, dd);
}

function openLibraryDetail(id) {
  const image = state.library.images.find((item) => item.id === id || item.assetId === id);
  if (!image) return;

  state.library.selectedId = id;
  state.library.selectedAssetId = image.assetId;
  state.library.currentAsset = { ...image, id: image.assetId };
  resetLibrarySplit();
  libraryReturnFocus = document.activeElement;
  const metadata = image.metadata || {};
  const review = libraryReviewLabel(metadata);

  $('#library-modal-title').textContent = image.name;
  $('#library-detail-name').textContent = image.label || image.name;

  const preview = $('#library-preview');
  const previewError = $('#library-preview-error');
  preview.classList.remove('hidden');
  previewError.classList.add('hidden');
  preview.onload = () => {
    preview.classList.remove('hidden');
    previewError.classList.add('hidden');
  };
  preview.onerror = () => {
    preview.classList.add('hidden');
    previewError.classList.remove('hidden');
  };
  preview.src = image.url;
  preview.alt = image.name;

  const fileFacts = $('#library-file-facts');
  fileFacts.innerHTML = '';
  addLibraryFact(fileFacts, 'Filename', libraryRecorded(image.name));
  addLibraryFact(fileFacts, 'Relative path', libraryRecorded(image.relativePath), { code: true });
  addLibraryFact(fileFacts, 'File type', image.extension ? image.extension.toUpperCase() : 'Not recorded');
  addLibraryFact(
    fileFacts,
    'Dimensions',
    image.width && image.height ? `${image.width} × ${image.height}` : 'Not recorded'
  );
  addLibraryFact(fileFacts, 'File size', formatBytes(image.sizeBytes));
  addLibraryFact(fileFacts, 'Last modified', formatLibraryDate(image.modifiedAt));

  const metadataList = $('#library-metadata-list');
  metadataList.innerHTML = '';
  addLibraryFact(metadataList, 'Project ID', libraryRecorded(metadata.projectId));
  addLibraryFact(metadataList, 'Episode ID', libraryRecorded(metadata.episodeId));
  addLibraryFact(metadataList, 'Scene ID', libraryRecorded(metadata.sceneId));
  addLibraryFact(metadataList, 'Revision', libraryRecorded(metadata.revision));
  addLibraryFact(metadataList, 'Workflow status', libraryRecorded(metadata.workflowStatus));
  addLibraryFact(metadataList, 'Review decision', review);
  addLibraryFact(metadataList, 'Prompt version', libraryRecorded(metadata.promptVersion));
  addLibraryFact(metadataList, 'Prompt draft ID', libraryRecorded(metadata.promptDraftId));
  addLibraryFact(metadataList, 'Model', libraryRecorded(metadata.model));
  addLibraryFact(
    metadataList,
    'Reference IDs',
    Array.isArray(metadata.referenceIds) && metadata.referenceIds.length
      ? metadata.referenceIds.join(', ')
      : 'Not recorded'
  );
  addLibraryFact(metadataList, 'Source', libraryRecorded(metadata.source));
  addLibraryFact(metadataList, 'Project stage (context)', libraryRecorded(metadata.projectStage));
  addLibraryFact(metadataList, 'Project status (context)', libraryRecorded(metadata.projectStatus));
  addLibraryFact(metadataList, 'Generation approval', 'Not recorded');
  addLibraryFact(metadataList, 'Publication approval', 'Not recorded');
  addLibraryFact(metadataList, 'Rights / adult / content checks', 'Not recorded');

  const promptBlock = $('#library-prompt-block');
  const prompt = $('#library-prompt');
  if (typeof (metadata.prompt || image.prompt) === 'string' && (metadata.prompt || image.prompt).trim()) {
    prompt.textContent = metadata.prompt || image.prompt;
    promptBlock.classList.remove('hidden');
  } else {
    prompt.textContent = '';
    promptBlock.classList.add('hidden');
  }

  const modal = $('#library-modal');
  modal.classList.remove('hidden');
  document.body.classList.add('library-modal-open');
  $('#library-modal-close').focus();
  document.addEventListener('keydown', libraryModalKeydown);
  hydrateLibraryDetail(image.assetId);
}

async function hydrateLibraryDetail(assetId) {
  try {
    const { asset } = await api(`/api/assets/${encodeURIComponent(assetId)}`);
    if (state.library.selectedAssetId !== assetId) return;
    state.library.currentAsset = asset;
    renderLibraryAssetDetail(asset);
    loadAssetReview(assetId);
  } catch (err) {
    if (state.library.selectedAssetId !== assetId) return;
    toast(err.message || 'Could not load asset details.', 'error');
  }
}

function renderLibraryAssetDetail(asset) {
  $('#library-split-button').disabled = librarySplitBusy || asset.missing;
  const metadata = asset.metadata || {};
  const review = libraryReviewLabel(metadata);

  $('#library-modal-title').textContent = asset.name || 'Image details';
  $('#library-detail-name').textContent = asset.label || asset.name || 'Image';
  const preview = $('#library-preview');
  if (asset.url && preview.getAttribute('src') !== asset.url) {
    preview.classList.remove('hidden');
    $('#library-preview-error').classList.add('hidden');
    preview.src = asset.url;
    preview.alt = asset.name || 'Asset preview';
  }

  const fileFacts = $('#library-file-facts');
  fileFacts.innerHTML = '';
  addLibraryFact(fileFacts, 'Filename', libraryRecorded(asset.name));
  addLibraryFact(fileFacts, 'Relative path', libraryRecorded(asset.relativePath), { code: true });
  addLibraryFact(fileFacts, 'Asset ID', libraryRecorded(asset.id), { code: true });
  addLibraryFact(fileFacts, 'Current version', `${asset.revision || '—'} · ${asset.isSource ? 'source' : 'derived'}`);
  if (asset.derivedFromVersionId) addLibraryFact(fileFacts, 'Derived from version', asset.derivedFromVersionId, { code: true });
  addLibraryFact(fileFacts, 'Lifecycle', libraryRecorded(asset.lifecycleStatus));
  addLibraryFact(fileFacts, 'File type', asset.extension ? asset.extension.toUpperCase() : 'Not recorded');
  addLibraryFact(fileFacts, 'Dimensions', asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Not recorded');
  addLibraryFact(fileFacts, 'File size', formatBytes(asset.sizeBytes));
  addLibraryFact(fileFacts, 'Last modified', formatLibraryDate(asset.modifiedAt));
  addLibraryFact(fileFacts, 'Checksum', asset.sha256 ? `${asset.sha256.slice(0, 16)}…` : 'Not recorded');

  const metadataList = $('#library-metadata-list');
  metadataList.innerHTML = '';
  addLibraryFact(metadataList, 'Project ID', libraryRecorded(metadata.projectId));
  addLibraryFact(metadataList, 'Episode ID', libraryRecorded(metadata.episodeId));
  addLibraryFact(metadataList, 'Scene ID', libraryRecorded(metadata.sceneId));
  addLibraryFact(metadataList, 'Scene title', libraryRecorded(metadata.sceneTitle));
  addLibraryFact(metadataList, 'Revision', libraryRecorded(asset.revision));
  addLibraryFact(metadataList, 'Workflow status', libraryRecorded(metadata.workflowStatus));
  addLibraryFact(metadataList, 'Review decision', review);
  addLibraryFact(metadataList, 'Prompt version', libraryRecorded(metadata.promptVersion));
  addLibraryFact(metadataList, 'Prompt draft ID', libraryRecorded(metadata.promptDraftId));
  addLibraryFact(metadataList, 'Model', libraryRecorded(metadata.model));
  addLibraryFact(metadataList, 'Reference IDs',
    Array.isArray(metadata.referenceIds) && metadata.referenceIds.length
      ? metadata.referenceIds.join(', ')
      : 'Not recorded');
  addLibraryFact(metadataList, 'Source', libraryRecorded(metadata.source));
  addLibraryFact(metadataList, 'Project stage (context)', libraryRecorded(metadata.projectStage));
  addLibraryFact(metadataList, 'Project status (context)', libraryRecorded(metadata.projectStatus));
  addLibraryFact(metadataList, 'Generation approval', 'Not recorded');
  addLibraryFact(metadataList, 'Publication approval', 'Not recorded');
  addLibraryFact(metadataList, 'Rights / adult / content checks', 'Not recorded');

  const promptBlock = $('#library-prompt-block');
  const prompt = $('#library-prompt');
  if (typeof (metadata.prompt || asset.prompt) === 'string' && (metadata.prompt || asset.prompt).trim()) {
    prompt.textContent = metadata.prompt || asset.prompt;
    promptBlock.classList.remove('hidden');
  } else {
    prompt.textContent = '';
    promptBlock.classList.add('hidden');
  }

  $('#library-asset-tags').textContent = (asset.tags || []).map((tag) => tag.name).join(', ') || 'Not recorded';
  $('#library-asset-collections').textContent = (asset.collections || []).map((item) => item.name).join(', ') || 'Not recorded';

  const collectionSelect = $('#library-collection-select');
  collectionSelect.innerHTML = '';
  state.library.collections.forEach((collection) => {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.name;
    collectionSelect.appendChild(option);
  });
  if (!state.library.collections.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No collections yet';
    collectionSelect.appendChild(option);
  }

  const versions = $('#library-versions');
  versions.innerHTML = '';
  (asset.versions || []).forEach((version) => {
    const row = document.createElement('div');
    row.className = 'library-version';
    const label = document.createElement('span');
    label.textContent = `Revision ${version.revision}${version.isSource ? ' · source' : ' · derived'}`;
    const meta = document.createElement('span');
    meta.className = 'library-version-meta';
    meta.textContent = `${version.width && version.height ? `${version.width}×${version.height}` : 'No dimensions'} · ${formatBytes(version.bytes)} · ${formatLibraryDate(version.createdAt)}`;
    const pathCode = document.createElement('code');
    pathCode.textContent = version.relativePath;
    row.append(label, meta, pathCode);
    const promptInfo = document.createElement('details');
    const promptLabel = document.createElement('summary'); promptLabel.textContent = 'Saved prompt';
    const promptText = document.createElement('pre'); promptText.textContent = version.prompt || 'No generation prompt recorded for this version.';
    promptInfo.append(promptLabel, promptText); row.appendChild(promptInfo);
    versions.appendChild(row);
  });
  if (!(asset.versions || []).length) versions.textContent = 'Not recorded';

  const duplicateBox = $('#library-duplicates');
  duplicateBox.innerHTML = '';
  if (asset.duplicatePeers && asset.duplicatePeers.length) {
    asset.duplicatePeers.forEach((peer) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm library-duplicate-link';
      button.textContent = peer.relativePath;
      button.addEventListener('click', () => openLibraryDetail(peer.id));
      duplicateBox.appendChild(button);
    });
  } else {
    duplicateBox.textContent = 'Not recorded';
  }

  loadLibraryEpisodesForAsset(asset);
}

async function loadLibraryEpisodesForAsset(asset) {
  const select = $('#library-episode-select');
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'No episode';
  select.appendChild(blank);
  if (!asset.metadata || !asset.metadata.projectId) return;
  const requestedAssetId = asset.id;
  try {
    const { episodes } = await api(`/api/projects/${encodeURIComponent(asset.metadata.projectId)}/episodes`);
    if (state.library.selectedAssetId !== requestedAssetId) return;
    (episodes || []).forEach((episode) => {
      const option = document.createElement('option');
      option.value = episode.id;
      option.textContent = episode.title;
      option.selected = episode.id === asset.metadata.episodeId;
      select.appendChild(option);
    });
  } catch (_) { /* episode assignment remains unavailable */ }
}

function closeLibraryDetail() {
  const modal = $('#library-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  document.body.classList.remove('library-modal-open');
  document.removeEventListener('keydown', libraryModalKeydown);
  state.library.selectedId = null;
  state.library.selectedAssetId = null;
  state.library.currentAsset = null;
  state.library.reviewData = null;
  resetLibrarySplit();
  if (libraryReturnFocus && document.contains(libraryReturnFocus)) {
    libraryReturnFocus.focus();
  }
  libraryReturnFocus = null;
}

let librarySplitBusy = false;

function resetLibrarySplit() {
  $('#library-split-button').disabled = librarySplitBusy;
  $('#library-split-button').textContent = librarySplitBusy ? 'Splitting…' : 'Split into 4 photos';
  $('#library-split-status').textContent = 'Cuts a 2 × 2 collage into four separate photos. The original stays in your Library.';
  $('#library-split-results').replaceChildren();
  $('#library-split-results').classList.add('hidden');
}

$('#library-split-button').addEventListener('click', async () => {
  const asset = state.library.currentAsset;
  if (librarySplitBusy || !asset?.id) return;
  const ownerId = state.user?.id;
  const sourceId = asset.id;
  const button = $('#library-split-button');
  const processId = startProcess('Splitting collage into 4 photos');
  librarySplitBusy = true;
  button.disabled = true;
  button.textContent = 'Splitting…';
  $('#library-split-results').replaceChildren();
  $('#library-split-results').classList.add('hidden');
  $('#library-split-status').textContent = 'Preparing the four photos…';
  let bitmap;
  let canvas;
  try {
    // Fetch the current version explicitly, rather than cropping a stale preview.
    const { asset: current } = await api(`/api/assets/${encodeURIComponent(sourceId)}`);
    const response = await fetch(current.url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('The source image could not be loaded. Reopen it and try again.');
    bitmap = await createImageBitmap(await response.blob());
    const { width, height } = bitmap;
    if (width < 2 || height < 2 || width * height > 16000000) throw new Error('Choose an image between 2 × 2 pixels and 16 megapixels.');
    const midX = Math.floor(width / 2);
    const midY = Math.floor(height / 2);
    const parts = [[0, 0, midX, midY], [midX, 0, width - midX, midY],
      [0, midY, midX, height - midY], [midX, midY, width - midX, height - midY]];
    const form = new FormData();
    form.append('sourceVersionId', current.versionId);
    form.append('width', String(width));
    form.append('height', String(height));
    canvas = document.createElement('canvas');
    let totalBytes = 0;
    for (let index = 0; index < parts.length; index++) {
      const [x, y, w, h] = parts[index];
      canvas.width = w; canvas.height = h;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser could not prepare the photos. Try reopening the page.');
      context.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      const photo = await new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('A photo could not be prepared. Try a smaller image.')), 'image/png'));
      totalBytes += photo.size;
      if (totalBytes > 20 * 1024 * 1024 - 65536) throw new Error('The four photos exceed 20 MB. Try a smaller collage.');
      form.append('photos', photo, `photo-${index + 1}.png`);
    }
    if (state.user?.id !== ownerId) return;
    updateProcess(processId, 'Saving 4 split photos to Library');
    const { photos } = await api(`/api/assets/${encodeURIComponent(sourceId)}/split`, { method: 'POST', body: form });
    if (state.user?.id !== ownerId) return;
    if (state.library.selectedAssetId === sourceId) {
      const results = $('#library-split-results');
      const labels = ['Top left', 'Top right', 'Bottom left', 'Bottom right'];
      photos.forEach((photo, index) => {
        const item = document.createElement('div');
        const preview = document.createElement('img');
        preview.src = photo.url; preview.alt = labels[index]; preview.loading = 'lazy';
        const download = document.createElement('a');
        download.href = photo.url; download.download = photo.name;
        download.className = 'btn btn-ghost btn-sm';
        download.textContent = `Download ${index + 1} · ${labels[index]}`;
        item.append(preview, download); results.append(item);
      });
      results.classList.remove('hidden');
      $('#library-split-status').textContent = '4 photos saved to Library. Each can be opened or downloaded separately.';
    }
    await loadLibrary(true);
    toast('4 photos saved to Library. Original collage kept.', 'success');
  } catch (err) {
    if (state.user?.id === ownerId) {
      if (state.library.selectedAssetId === sourceId) $('#library-split-status').textContent = err.message || 'Could not split the collage. Your original is unchanged.';
      toast(err.message || 'Could not split the collage.', 'error');
    }
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    librarySplitBusy = false;
    button.disabled = !state.library.currentAsset || state.library.currentAsset.missing;
    button.textContent = 'Split into 4 photos';
    finishProcess(processId);
  }
});

function resetLibrary() {
  closeLibraryDetail();
  state.library.loaded = false;
  state.library.loading = false;
  state.library.images = [];
  state.library.collections = [];
  state.library.error = null;
  state.library.search = '';
  state.library.selectedId = null;
  state.library.selectedAssetId = null;
  state.library.currentAsset = null;
  state.library.reviewData = null;
  state.library.filters = {
    projectId: '', episodeId: '', collectionId: '', tag: '', type: '',
    status: '', duplicate: false, missing: false, unassigned: false,
  };
  const search = $('#library-search');
  if (search) search.value = '';
  renderLibrary();
}

function libraryModalKeydown(event) {
  const modal = $('#library-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLibraryDetail();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  );
  if (!focusable.length) {
    event.preventDefault();
    modal.focus();
    return;
  }
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    focusable[0].focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

$('#library-search').addEventListener('input', (event) => {
  state.library.search = event.target.value;
  renderLibrary();
});

const libraryFilterBindings = [
  ['#library-project-filter', 'projectId'],
  ['#library-episode-filter', 'episodeId'],
  ['#library-collection-filter', 'collectionId'],
  ['#library-tag-filter', 'tag'],
  ['#library-type-filter', 'type'],
  ['#library-status-filter', 'status'],
];
libraryFilterBindings.forEach(([selector, key]) => {
  $(selector).addEventListener('change', (event) => {
    state.library.filters[key] = event.target.value;
    renderLibrary();
  });
});
[
  ['#library-duplicate-filter', 'duplicate'],
  ['#library-missing-filter', 'missing'],
  ['#library-unassigned-filter', 'unassigned'],
].forEach(([selector, key]) => {
  $(selector).addEventListener('change', (event) => {
    state.library.filters[key] = event.target.checked;
    renderLibrary();
  });
});
$('#library-clear-filters').addEventListener('click', () => {
  state.library.filters = {
    projectId: '', episodeId: '', collectionId: '', tag: '', type: '',
    status: '', duplicate: false, missing: false, unassigned: false,
  };
  state.library.search = '';
  $('#library-search').value = '';
  renderLibrary();
});

async function refreshLibraryAsset() {
  const assetId = state.library.currentAsset && state.library.currentAsset.id;
  await loadLibrary(true);
  if (assetId) await hydrateLibraryDetail(assetId);
}

$('#library-add-tag').addEventListener('click', async () => {
  const assetId = state.library.currentAsset && state.library.currentAsset.id;
  const name = $('#library-tag-input').value.trim();
  if (!assetId) return;
  if (!name) return toast('Enter a tag name.', 'error');
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}/tags`, { method: 'POST', body: { name } });
    $('#library-tag-input').value = '';
    await refreshLibraryAsset();
    toast('Tag added.', 'success');
  } catch (err) {
    toast(err.message || 'Could not add the tag.', 'error');
  }
});

$('#library-add-collection').addEventListener('click', async () => {
  const assetId = state.library.currentAsset && state.library.currentAsset.id;
  const collectionId = $('#library-collection-select').value;
  if (!assetId || !collectionId) return toast('Choose a collection first.', 'error');
  try {
    await api(`/api/collections/${encodeURIComponent(collectionId)}/assets/${encodeURIComponent(assetId)}`, { method: 'POST' });
    await refreshLibraryAsset();
    toast('Added to collection.', 'success');
  } catch (err) {
    toast(err.message || 'Could not add to the collection.', 'error');
  }
});

$('#library-create-collection').addEventListener('click', async () => {
  const name = $('#library-new-collection').value.trim();
  if (!name) return toast('Enter a collection name.', 'error');
  try {
    await api('/api/collections', { method: 'POST', body: { name } });
    $('#library-new-collection').value = '';
    await refreshLibraryAsset();
    toast('Collection created.', 'success');
  } catch (err) {
    toast(err.message || 'Could not create the collection.', 'error');
  }
});

$('#library-set-episode').addEventListener('click', async () => {
  const assetId = state.library.currentAsset && state.library.currentAsset.id;
  if (!assetId) return;
  const episodeId = $('#library-episode-select').value || null;
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'PUT', body: { episodeId } });
    await refreshLibraryAsset();
    toast('Episode assignment updated.', 'success');
  } catch (err) {
    toast(err.message || 'Could not update the episode.', 'error');
  }
});

// ---------------------------------------------------------------------------
// Review and quality control
// ---------------------------------------------------------------------------
function reviewStatusClass(status) {
  if (status === 'APPROVED' || status === 'PUBLICATION READY') return 'approved';
  if (status === 'REJECT') return 'unapproved';
  if (status === 'REVISE' || status === 'OWNER REVIEW') return 'draft';
  return 'draft';
}

async function loadAssetReview(assetId) {
  try {
    $('#review-hint').textContent = 'Loading review history…';
    const { review } = await api(`/api/assets/${encodeURIComponent(assetId)}/review`);
    if (state.library.selectedAssetId !== assetId) return;
    state.library.reviewData = review;
    renderAssetReview(review);
  } catch (err) {
    if (state.library.selectedAssetId !== assetId) return;
    $('#review-hint').textContent = 'Could not load review data.';
    toast(err.message || 'Could not load review data.', 'error');
  }
}

function renderAssetReview(review) {
  const latest = review.review || null;
  const status = review.status || 'NOT REVIEWED';
  const statusStale = Boolean(latest && review.currentVersionId && latest.assetVersionId && latest.assetVersionId !== review.currentVersionId);
  $('#review-hint').textContent = 'Content review, checklists, and publication are separate decisions.';
  const badge = $('#review-status');
  badge.textContent = status === 'NOT REVIEWED'
    ? 'Not reviewed'
    : statusStale
      ? `${status} · earlier revision`
      : status;
  badge.className = `story-badge ${reviewStatusClass(status)}`;
  $('#review-decision').value = latest ? latest.decision : '';
  $('#review-notes').value = latest ? latest.notes : '';
  $('#review-blockers').value = latest ? latest.blockers.join('\n') : '';

  const checklist = $('#review-checklist');
  checklist.innerHTML = '';
  const states = ['unreviewed', 'pass', 'fail', 'not-applicable'];
  (review.categories || []).forEach((category) => {
    const item = (review.checklist || []).find((entry) => entry.category === category.id) || {
      state: 'unreviewed',
      notes: '',
    };
    const row = document.createElement('div');
    row.className = 'review-checklist-item';
    row.dataset.reviewCategory = category.id;
    const label = document.createElement('strong');
    label.textContent = category.label;
    const select = document.createElement('select');
    select.dataset.reviewState = '1';
    states.forEach((state) => {
      const option = document.createElement('option');
      option.value = state;
      option.textContent = state === 'not-applicable' ? 'not applicable' : state;
      select.appendChild(option);
    });
    select.value = item.state;
    const notes = document.createElement('input');
    notes.type = 'text';
    notes.maxLength = 2000;
    notes.placeholder = 'Checklist notes';
    notes.dataset.reviewNotes = '1';
    notes.value = item.notes || '';
    row.append(label, select, notes);
    checklist.appendChild(row);
  });

  const coverSelect = $('#review-cover-select');
  coverSelect.innerHTML = '';
  const versions = (state.library.currentAsset && state.library.currentAsset.versions) || [];
  const noCover = document.createElement('option');
  noCover.value = '';
  noCover.textContent = 'No safe cover';
  coverSelect.appendChild(noCover);
  versions.forEach((version) => {
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `Revision ${version.revision}${version.isSource ? ' · source' : ' · derived'}`;
    coverSelect.appendChild(option);
  });
  coverSelect.value = review.safeCover ? review.safeCover.versionId : '';
  $('#review-cover-status').textContent = review.safeCover
    ? `Safe cover: revision ${(versions.find((version) => version.id === review.safeCover.versionId) || {}).revision || '?'}`
    : 'No safe cover designated. Publication approval is blocked.';

  const publication = review.publication;
  const publicationNote = review.publicationReady
    ? 'Publication-ready: content review, completed checklist, safe cover, and publication approval are all recorded.'
    : review.blockers && review.blockers.length
      ? `Not publication-ready: ${review.blockers.join(' · ')}`
      : 'Not publication-ready: review evidence is incomplete.';
  $('#review-publication-status').textContent = publicationNote;
  $('#review-publication-notes').value = publication ? publication.notes : '';

  const continuity = $('#review-continuity');
  continuity.innerHTML = '';
  (review.continuity || []).forEach((check) => {
    const row = document.createElement('div');
    row.className = 'review-continuity-item';
    const badge = document.createElement('span');
    badge.className = `story-badge ${check.state === 'pass' ? 'approved' : 'unapproved'}`;
    badge.textContent = check.state === 'pass' ? 'pass' : 'warn';
    const text = document.createElement('span');
    text.textContent = `${check.label}: ${check.message}`;
    row.append(badge, text);
    continuity.appendChild(row);
  });
  if (!review.continuity || !review.continuity.length) continuity.textContent = 'Not recorded';

  const compareA = $('#review-compare-a');
  const compareB = $('#review-compare-b');
  [compareA, compareB].forEach((select) => {
    select.innerHTML = '';
    versions.forEach((version) => {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = `Revision ${version.revision}`;
      select.appendChild(option);
    });
  });
  if (versions.length > 1) {
    compareA.value = versions[versions.length - 2].id;
    compareB.value = versions[versions.length - 1].id;
  }
  renderReviewCompare();

  const audit = $('#review-audit');
  audit.innerHTML = '';
  if (!(review.audit || []).length) {
    audit.textContent = 'No review events recorded yet.';
  } else {
    review.audit.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'review-audit-item';
      const when = formatLibraryDate(entry.createdAt);
      row.textContent = `${when} · ${entry.actor} · ${entry.action}${entry.decision ? ' · ' + entry.decision : ''}${entry.blockers && entry.blockers.length ? ' · blockers: ' + entry.blockers.join('; ') : ''}`;
      audit.appendChild(row);
    });
  }
}

function renderReviewCompare() {
  const container = $('#review-compare');
  const versions = (state.library.currentAsset && state.library.currentAsset.versions) || [];
  const first = versions.find((version) => version.id === $('#review-compare-a').value);
  const second = versions.find((version) => version.id === $('#review-compare-b').value);
  container.innerHTML = '';
  [first, second].forEach((version) => {
    const figure = document.createElement('figure');
    if (version) {
      const img = document.createElement('img');
      img.src = version.url;
      img.alt = `Revision ${version.revision} preview`;
      const caption = document.createElement('figcaption');
      caption.textContent = `Revision ${version.revision} · ${version.width && version.height ? `${version.width}×${version.height}` : 'dimensions not recorded'} · ${formatBytes(version.bytes)}`;
      figure.append(img, caption);
    } else {
      const caption = document.createElement('figcaption');
      caption.textContent = versions.length ? 'Choose two revisions.' : 'No multiple revisions to compare.';
      figure.appendChild(caption);
    }
    container.appendChild(figure);
  });
}

$('#review-save').addEventListener('click', async () => {
  const assetId = state.library.selectedAssetId;
  const decision = $('#review-decision').value;
  if (!assetId || !decision) return toast('Choose a review decision first.', 'error');
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}/reviews`, {
      method: 'POST',
      body: {
        decision,
        notes: $('#review-notes').value,
        blockers: $('#review-blockers').value.split('\n').map((value) => value.trim()).filter(Boolean),
        comparedRevisions: [$('#review-compare-a').value, $('#review-compare-b').value].filter(Boolean),
      },
    });
    await loadAssetReview(assetId);
    await loadLibrary(true);
    toast('Review decision recorded.', 'success');
  } catch (err) {
    toast(err.message || 'Could not record the review decision.', 'error');
  }
});

$('#review-save-checklist').addEventListener('click', async () => {
  const assetId = state.library.selectedAssetId;
  if (!assetId) return;
  const items = Array.from($('#review-checklist').querySelectorAll('[data-review-category]')).map((row) => ({
    category: row.dataset.reviewCategory,
    state: row.querySelector('[data-review-state]').value,
    notes: row.querySelector('[data-review-notes]').value,
  }));
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}/checklist`, { method: 'PUT', body: { items } });
    await loadAssetReview(assetId);
    await loadLibrary(true);
    toast('Checklist saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the checklist.', 'error');
  }
});

$('#review-set-cover').addEventListener('click', async () => {
  const assetId = state.library.selectedAssetId;
  if (!assetId) return;
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}/safe-cover`, {
      method: 'POST',
      body: { versionId: $('#review-cover-select').value || null },
    });
    await loadAssetReview(assetId);
    await loadLibrary(true);
    toast('Safe cover updated.', 'success');
  } catch (err) {
    toast(err.message || 'Could not update the safe cover.', 'error');
  }
});

async function recordPublicationDecision(approved) {
  const assetId = state.library.selectedAssetId;
  if (!assetId) return;
  try {
    await api(`/api/assets/${encodeURIComponent(assetId)}/publication`, {
      method: 'POST',
      body: { approved, notes: $('#review-publication-notes').value },
    });
    await loadAssetReview(assetId);
    await loadLibrary(true);
    toast(approved ? 'Publication approval recorded.' : 'Publication decision recorded.', 'success');
  } catch (err) {
    await loadAssetReview(assetId);
    toast(err.message || 'Could not record the publication decision.', 'error');
  }
}

$('#review-publication-approve').addEventListener('click', () => recordPublicationDecision(true));
$('#review-publication-decline').addEventListener('click', () => recordPublicationDecision(false));
$('#review-compare-btn').addEventListener('click', renderReviewCompare);
['#review-notes', '#review-blockers', '#review-publication-notes'].forEach((selector) => {
  $(selector).addEventListener('input', () => {
    $('#review-hint').textContent = 'Unsaved review changes. Record the decision or checklist to keep them.';
  });
});
$('#review-checklist').addEventListener('change', () => {
  $('#review-hint').textContent = 'Unsaved checklist changes. Save the checklist to keep them.';
});

// ---------------------------------------------------------------------------
// Episodes manager
// ---------------------------------------------------------------------------
function closeEpisodesModal() {
  $('#episodes-modal').classList.add('hidden');
  state.episodesProjectId = null;
}

async function loadEpisodes() {
  const projectId = state.episodesProjectId;
  if (!projectId) return;
  const list = $('#episodes-list');
  list.innerHTML = '';
  try {
    const { episodes } = await api(`/api/projects/${encodeURIComponent(projectId)}/episodes`);
    if (!episodes.length) {
      list.textContent = 'No episodes yet.';
      return;
    }
    episodes.forEach((episode) => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      const label = document.createElement('span');
      label.textContent = `${episode.position}. ${episode.title}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-danger btn-sm';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete episode "${episode.title}"?`)) return;
        try {
          await api(`/api/episodes/${encodeURIComponent(episode.id)}`, { method: 'DELETE' });
          await loadEpisodes();
          toast('Episode deleted.', 'success');
        } catch (err) {
          toast(err.message || 'Could not delete the episode.', 'error');
        }
      });
      row.append(label, remove);
      list.appendChild(row);
    });
  } catch (err) {
    list.textContent = err.message || 'Could not load episodes.';
  }
}

function openEpisodesModal(project) {
  state.episodesProjectId = project.id;
  $('#episodes-modal-title').textContent = 'Episodes';
  $('#episodes-project-label').textContent = project.title;
  $('#episode-title-input').value = '';
  $('#episodes-modal').classList.remove('hidden');
  $('#episode-title-input').focus();
  loadEpisodes();
}

$('#episodes-modal-close').addEventListener('click', closeEpisodesModal);
$('#episodes-modal').addEventListener('click', (event) => {
  if (event.target === $('#episodes-modal')) closeEpisodesModal();
});
$('#episode-add-btn').addEventListener('click', async () => {
  const title = $('#episode-title-input').value.trim();
  if (!title) return toast('Enter an episode title.', 'error');
  try {
    await api(`/api/projects/${encodeURIComponent(state.episodesProjectId)}/episodes`, {
      method: 'POST',
      body: { title },
    });
    $('#episode-title-input').value = '';
    await loadEpisodes();
    toast('Episode added.', 'success');
  } catch (err) {
    toast(err.message || 'Could not add the episode.', 'error');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#episodes-modal').classList.contains('hidden')) {
    closeEpisodesModal();
  }
});
$('#library-refresh').addEventListener('click', () => loadLibrary(true));
$('#library-retry').addEventListener('click', () => loadLibrary(true));
$('#library-modal-close').addEventListener('click', closeLibraryDetail);
$('#library-modal').addEventListener('click', (event) => {
  if (event.target === $('#library-modal')) closeLibraryDetail();
});

// ---------------------------------------------------------------------------
// Story workspace
// ---------------------------------------------------------------------------
const STORY_REFERENCE_CONFIG = {
  character: {
    collection: 'characters',
    noun: 'Character',
    fields: [
      { key: 'name', label: 'Name', max: 120, required: true },
      { key: 'gender', label: 'Gender', max: 40 },
      { key: 'age', label: 'Age', max: 80 },
      { key: 'appearance', label: 'Appearance', max: 5000, multiline: true },
      { key: 'wardrobe', label: 'Wardrobe', max: 5000, multiline: true },
      { key: 'continuityNotes', label: 'Continuity notes', max: 5000, multiline: true },
    ],
  },
  location: {
    collection: 'locations',
    noun: 'Location',
    fields: [
      { key: 'name', label: 'Name', max: 200, required: true },
      { key: 'description', label: 'Description', max: 5000, multiline: true },
      { key: 'lighting', label: 'Lighting', max: 2000, multiline: true },
      { key: 'continuityNotes', label: 'Continuity notes', max: 5000, multiline: true },
    ],
  },
  style: {
    collection: 'styles',
    noun: 'Style',
    fields: [
      { key: 'name', label: 'Name', max: 200, required: true },
      { key: 'description', label: 'Description', max: 5000, multiline: true },
      { key: 'guidance', label: 'Visual guidance', max: 5000, multiline: true },
      { key: 'exclusions', label: 'Exclusions (one per line)', max: 9000, multiline: true },
    ],
  },
};

function storySetHint(message) {
  const hint = $('#story-brief-hint');
  if (hint) hint.textContent = message || 'The brief is the canonical root of the story.';
}

function storyMarkDirty() {
  state.story.dirty = true;
  storySetHint('Unsaved changes. Save the section you are editing.');
}

function storyClearDirty() {
  state.story.dirty = false;
  storySetHint('The brief is the canonical root of the story.');
}

function storyProjectOptions() {
  const select = $('#story-project');
  const previous = state.story.projectId;
  select.innerHTML = '';
  if (!state.projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No projects yet';
    select.appendChild(option);
    return;
  }
  state.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.status === 'Done' ? `${project.title} (completed)` : project.title;
    select.appendChild(option);
  });
  const valid = state.projects.some((project) => project.id === previous);
  select.value = valid ? previous : state.projects[0].id;
  state.story.projectId = select.value;
}

function renderStoryState() {
  $('#story-loading').classList.toggle('hidden', !state.story.loading);
  $('#story-empty').classList.toggle('hidden', state.story.loading || Boolean(state.story.data) || Boolean(state.story.error) || Boolean(state.story.projectId));
  $('#story-error').classList.toggle('hidden', !state.story.error);
  $('#story-content').classList.toggle('hidden', !state.story.data);
  $('#story-content').classList.add('hidden');
  $('#story-worksheet').classList.toggle('hidden', !state.story.data || !state.story.worksheetOpen);
  if (state.story.error) $('#story-error-text').textContent = state.story.error;
}

function renderStoryProjects() {
  storyProjectOptions();
  if (!state.story.projectId) {
    state.story.data = null;
    renderStoryState();
    return;
  }
  loadStory(state.story.projectId);
}

async function loadStory(projectId) {
  if (!projectId) return;
  state.story.loading = true;
  state.story.error = null;
  renderStoryState();
  try {
    const { story } = await api(`/api/story/${encodeURIComponent(projectId)}`);
    if (state.story.projectId !== projectId) return;
    state.story.data = story;
    if ((story.worksheet?.actions || []).length || (story.worksheet?.locations || []).length ||
        (story.characterSheets || []).length) state.story.worksheetOpen = true;
    state.story.loaded = true;
    state.story.dirty = false;
    renderStory();
  } catch (err) {
    if (state.story.projectId !== projectId) return;
    state.story.data = null;
    state.story.error = err.message || 'Could not load the story workspace.';
  } finally {
    state.story.loading = false;
    renderStoryState();
  }
}

function setStoryInput(selector, value) {
  const input = $(selector);
  if (input) input.value = value || '';
}

function renderStory() {
  const story = state.story.data;
  if (!story) return;
  renderStoryState();
  renderWorksheet();
  return;
  const brief = story.brief || {};
  setStoryInput('#story-brief-title', brief.title);
  setStoryInput('#story-brief-logline', brief.logline);
  setStoryInput('#story-brief-premise', brief.premise);
  setStoryInput('#story-brief-tone', brief.tone);
  setStoryInput('#story-brief-genre', brief.genre);
  setStoryInput('#story-brief-audience', brief.audience);
  setStoryInput('#story-brief-setting', brief.setting);
  storyClearDirty();
  renderStoryReferences('character');
  renderStoryReferences('location');
  renderStoryReferences('style');
  renderStoryScenes();
  renderStorySheetOptions();
  renderStorySheets();
  renderStoryWarnings();
  const generateWorkspace = $('#story-generate-workspace');
  if (generateWorkspace) {
    generateWorkspace.classList.toggle('hidden', !story.hasReference);
  }
}

function worksheetText(label, value) {
  const line = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  line.append(strong, document.createTextNode(value || 'Not provided'));
  return line;
}

function renderWorksheet() {
  const story = state.story.data;
  if (!story) return;
  const source = story.referenceSource || {};
  const saved = story.worksheet || { actions: [], locations: [] };
  const sourceList = $('#story-source-references');
  sourceList.replaceChildren(
    worksheetText('Name', source.name), worksheetText('Idea', source.idea),
    worksheetText('Characters', (source.characters || []).join(', ')),
    worksheetText('Setting', source.setting),
    worksheetText('Reference Material', source.referenceMaterial),
  );
  (source.characterReferences || []).forEach((item) => {
    sourceList.appendChild(worksheetText(`Character Reference: ${item.name}`, item.referenceMaterial));
  });
  const characters = (source.characterReferences || []).filter((item) => item.name);
  const select = $('#worksheet-character');
  const selected = select.value;
  select.replaceChildren();
  characters.forEach((item) => {
    const character = (story.characters || []).find((candidate) => candidate.name === item.name);
    if (!character || !item.referenceMaterial) return;
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = item.name;
    select.appendChild(option);
  });
  if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
  $('#worksheet-generate-one').disabled = !select.value;
  $('#worksheet-generate-all').disabled = !select.value;
  const sheets = $('#worksheet-sheets');
  sheets.replaceChildren();
  characters.forEach((item) => {
    const character = (story.characters || []).find((candidate) => candidate.name === item.name);
    if (!character) return;
    const versions = (story.characterSheets || []).filter((sheet) => sheet.characterId === character.id)
      .sort((a, b) => b.version - a.version);
    const final = versions.find((sheet) => sheet.status === 'final');
    const latest = versions[0];
    const card = document.createElement('div');
    card.className = 'story-sheet-version';
    card.appendChild(worksheetText(item.name, !item.referenceMaterial ? 'Character Reference needed' : final ? 'Added' : latest ? 'Preview, not added' : 'Sheet needed'));
    [final, latest && latest.id !== final?.id ? latest : null].filter(Boolean).forEach((sheet) => {
      const img = document.createElement('img');
      img.className = 'story-sheet-image';
      img.alt = `${item.name} character reference sheet`;
      img.src = `/api/story/sheet-image/${encodeURIComponent(story.projectId)}/${encodeURIComponent(sheet.file)}`;
      card.appendChild(img);
      if (sheet.status !== 'final') {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn btn-primary btn-sm';
        add.textContent = 'Add this sheet';
        add.addEventListener('click', async () => {
          try {
            add.disabled = true;
            await api(`/api/story/sheets/${encodeURIComponent(sheet.id)}/promote`, { method: 'POST' });
            await loadStory(story.projectId);
          } catch (err) { add.disabled = false; toast(err.message, 'error'); }
        });
        card.appendChild(add);
      }
    });
    if (latest) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn btn-secondary btn-sm';
      again.textContent = 'Generate again';
      again.disabled = !item.referenceMaterial;
      again.addEventListener('click', () => generateWorksheetSheet(character.id, again));
      card.appendChild(again);
    }
    sheets.appendChild(card);
  });
  $('#story-reference-status').textContent = characters.length && characters.every((item) => {
    const character = (story.characters || []).find((candidate) => candidate.name === item.name);
    return item.referenceMaterial && (story.characterSheets || []).some((sheet) => sheet.characterId === character?.id && sheet.status === 'final');
  }) ? 'Done' : `${characters.filter((item) => {
    const character = (story.characters || []).find((candidate) => candidate.name === item.name);
    return (story.characterSheets || []).some((sheet) => sheet.characterId === character?.id && sheet.status === 'final');
  }).length}/${characters.length} added`;
  renderWorksheetList('actions', state.story.actionDraft || saved.actions);
  renderWorksheetList('locations', state.story.locationDraft || saved.locations);
  $('#worksheet-action-status').textContent = saved.actions.length ? 'Done' : 'Not saved';
  $('#worksheet-location-status').textContent = saved.locations.length ? 'Done' : 'Not saved';
  $('#worksheet-save-actions').classList.toggle('hidden', !state.story.actionDraft);
  $('#worksheet-save-locations').classList.toggle('hidden', !state.story.locationDraft);
  $('#worksheet-generate-locations').disabled = !saved.actions.length;
  if (saved.actions.length && !state.story.actionDraft) $('#worksheet-picture-count').value = saved.actions.length;
}

function renderWorksheetList(type, items) {
  const target = $(`#worksheet-${type}`);
  target.replaceChildren();
  if (!items.length) { target.appendChild(worksheetText(type === 'actions' ? 'Actions' : 'Locations', 'Generate to preview.')); return; }
  items.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'story-ref-item';
    card.appendChild(worksheetText(type === 'actions' ? `Action ${index + 1}` : item.name,
      type === 'actions' ? `${item.action} ${item.locationSentence}` : item.description));
    target.appendChild(card);
  });
}

function storyApprovedBadge(approved) {
  const badge = document.createElement('span');
  badge.className = `story-badge ${approved ? 'approved' : 'unapproved'}`;
  badge.textContent = approved ? 'Approved' : 'Not approved';
  return badge;
}

function storyFormField(config) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = config.label;
  const input = config.multiline ? document.createElement('textarea') : document.createElement('input');
  if (config.multiline) input.rows = 3;
  else input.type = config.type || 'text';
  input.maxLength = config.max;
  input.dataset.storyField = config.key;
  wrapper.append(label, input);
  return { wrapper, input };
}

function renderStoryReferences(type) {
  const config = STORY_REFERENCE_CONFIG[type];
  const story = state.story.data;
  if (!story) return;
  const container = $(`#story-${config.collection}`);
  container.innerHTML = '';
  const items = story[config.collection] || [];

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'story-ref-item';
    card.dataset.referenceId = item.id;

    const head = document.createElement('div');
    head.className = 'story-ref-head';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const badges = document.createElement('div');
    badges.className = 'story-ref-badges';
    badges.append(storyApprovedBadge(item.approved));
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-sm ' + (item.approved ? 'btn-secondary' : 'btn-primary');
    approve.textContent = item.approved ? '↩ Unapprove' : '✓ Approve';
    approve.title = item.approved
      ? `Unapprove this ${config.noun.toLowerCase()} reference`
      : `Approve this ${config.noun.toLowerCase()} reference as canonical`;
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      try {
        await api(`/api/story/${type}s/${encodeURIComponent(item.id)}`, {
          method: 'PUT',
          body: { approved: !item.approved },
        });
        await loadStory(state.story.projectId);
        refreshSidebarStory(true);
        toast(item.approved ? `${config.noun} unapproved.` : `${config.noun} approved.`, 'success');
      } catch (err) {
        approve.disabled = false;
        toast(err.message || `Could not update the ${config.noun.toLowerCase()}.`, 'error');
      }
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      state.story.editor = { type, id: item.id };
      renderStoryReferences(type);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-sm';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete ${config.noun.toLowerCase()} "${item.name}"?`)) return;
      try {
        await api(`/api/story/${type}s/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        await loadStory(state.story.projectId);
        toast(`${config.noun} deleted.`, 'success');
      } catch (err) {
        toast(err.message || `Could not delete the ${config.noun.toLowerCase()}.`, 'error');
      }
    });
    badges.append(approve, edit, remove);
    head.append(name, badges);
    card.appendChild(head);

    if (item.legacyMaterial) {
      const legacy = document.createElement('p');
      legacy.className = 'story-legacy';
      legacy.textContent = `Legacy reference material: ${item.legacyMaterial}`;
      card.appendChild(legacy);
    }

    const meta = document.createElement('p');
    meta.className = 'story-ref-meta';
    if (type === 'character') {
      meta.textContent = [item.gender, item.age, item.wardrobe].filter(Boolean).join(' · ') || 'No structured details yet.';
    } else if (type === 'location') {
      meta.textContent = [item.description, item.lighting].filter(Boolean).join(' · ') || 'No location description yet.';
    } else {
      meta.textContent = [item.description, item.guidance].filter(Boolean).join(' · ') || 'No style guidance yet.';
    }
    card.appendChild(meta);
    container.appendChild(card);
  });

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = `No ${config.noun.toLowerCase()} records yet.`;
    container.appendChild(empty);
  }

  if (state.story.editor && state.story.editor.type === type) {
    const editing = state.story.editor.id ? items.find((item) => item.id === state.story.editor.id) : null;
    const form = document.createElement('div');
    form.className = 'story-ref-form';
    const heading = document.createElement('h3');
    heading.textContent = editing ? `Edit ${config.noun.toLowerCase()}` : `New ${config.noun.toLowerCase()}`;
    form.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'story-form-grid';
    const fields = {};
    config.fields.forEach((fieldConfig) => {
      const field = storyFormField(fieldConfig);
      field.input.value = editing
        ? (Array.isArray(editing[fieldConfig.key]) ? editing[fieldConfig.key].join('\n') : editing[fieldConfig.key] || '')
        : '';
      fields[fieldConfig.key] = field.input;
      grid.appendChild(field.wrapper);
    });
    form.appendChild(grid);

    const approvedWrap = document.createElement('label');
    approvedWrap.className = 'story-check';
    const approved = document.createElement('input');
    approved.type = 'checkbox';
    approved.checked = editing ? Boolean(editing.approved) : false;
    approvedWrap.append(approved, document.createTextNode(' Approved canonical reference'));
    form.appendChild(approvedWrap);

    const actions = document.createElement('div');
    actions.className = 'story-form-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-sm';
    save.textContent = editing ? 'Save changes' : `Create ${config.noun.toLowerCase()}`;
    save.addEventListener('click', async () => {
      const body = { approved: approved.checked };
      for (const [key, input] of Object.entries(fields)) {
        body[key] = key === 'exclusions'
          ? input.value.split('\n').map((value) => value.trim()).filter(Boolean)
          : input.value;
      }
      try {
        const endpoint = editing
          ? `/api/story/${type}s/${encodeURIComponent(editing.id)}`
          : `/api/story/${encodeURIComponent(state.story.projectId)}/${type}s`;
        await api(endpoint, { method: editing ? 'PUT' : 'POST', body });
        state.story.editor = null;
        await loadStory(state.story.projectId);
        refreshSidebarStory(true);
        toast(`${config.noun} saved.`, 'success');
      } catch (err) {
        toast(err.message || `Could not save the ${config.noun.toLowerCase()}.`, 'error');
      }
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      state.story.editor = null;
      renderStoryReferences(type);
    });
    actions.append(save, cancel);
    form.appendChild(actions);
    container.appendChild(form);
  }
}

function renderStoryScenes() {
  const story = state.story.data;
  const container = $('#story-scenes');
  if (!story) return;
  container.innerHTML = '';
  const scenes = story.scenes || [];
  if (!scenes.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No scenes yet. Add a scene or generate reference material.';
    container.appendChild(empty);
  }
  const approvedCharacters = (story.characters || []).filter((item) => item.approved);
  const approvedLocations = (story.locations || []).filter((item) => item.approved);

  scenes.forEach((scene, index) => {
    const card = document.createElement('div');
    card.className = 'story-scene-card';
    card.dataset.sceneCard = scene.id;
    const head = document.createElement('div');
    head.className = 'story-scene-head';
    const title = document.createElement('strong');
    title.textContent = `Scene ${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-sm';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      story.scenes = story.scenes.filter((item) => item.id !== scene.id);
      storyMarkDirty();
      renderStoryScenes();
    });
    head.append(title, remove);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'story-form-grid';
    const fields = {};
    [
      { key: 'title', label: 'Title', max: 200 },
      { key: 'beat', label: 'Beat', max: 2000 },
      { key: 'props', label: 'Props', max: 2000 },
      { key: 'action', label: 'Action', max: 5000, multiline: true },
    ].forEach((config) => {
      const field = storyFormField(config);
      field.input.value = scene[config.key] || '';
      field.input.addEventListener('input', storyMarkDirty);
      fields[config.key] = field.input;
      grid.appendChild(field.wrapper);
    });

    const locationField = document.createElement('label');
    locationField.className = 'field';
    const locationLabel = document.createElement('span');
    locationLabel.className = 'field-label';
    locationLabel.textContent = 'Location';
    const locationSelect = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No linked location';
    locationSelect.appendChild(none);
    (story.locations || []).forEach((location) => {
      const option = document.createElement('option');
      option.value = location.id;
      option.textContent = `${location.name}${location.approved ? '' : ' (not approved)'}`;
      locationSelect.appendChild(option);
    });
    locationSelect.value = scene.locationId || '';
    locationSelect.addEventListener('change', storyMarkDirty);
    locationField.append(locationLabel, locationSelect);
    grid.appendChild(locationField);

    const locationTextField = storyFormField({ key: 'locationText', label: 'Or unlinked location name', max: 200 });
    locationTextField.input.value = scene.location || '';
    locationTextField.input.addEventListener('input', storyMarkDirty);
    fields.locationText = locationTextField.input;
    grid.appendChild(locationTextField.wrapper);

    const characterNamesField = storyFormField({ key: 'characterNames', label: 'Or unlinked character names (comma separated)', max: 2000 });
    characterNamesField.input.value = (scene.characters || []).join(', ');
    characterNamesField.input.addEventListener('input', storyMarkDirty);
    fields.characterNames = characterNamesField.input;
    grid.appendChild(characterNamesField.wrapper);

    const characterField = document.createElement('div');
    characterField.className = 'field story-span';
    const characterLabel = document.createElement('span');
    characterLabel.className = 'field-label';
    characterLabel.textContent = 'Characters';
    const characterList = document.createElement('div');
    characterList.className = 'story-check-list';
    (story.characters || []).forEach((character) => {
      const label = document.createElement('label');
      label.className = 'story-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = character.id;
      checkbox.checked = (scene.characterIds || []).includes(character.id);
      checkbox.addEventListener('change', storyMarkDirty);
      label.append(checkbox, document.createTextNode(`${character.name}${character.approved ? '' : ' (not approved)'}`));
      characterList.appendChild(label);
    });
    characterField.append(characterLabel, characterList);
    grid.appendChild(characterField);
    card.appendChild(grid);
    card._storyFields = { ...fields, locationSelect, characterList };
    container.appendChild(card);
  });

  $('#story-add-scene').disabled = false;
  $('#story-save-scenes').disabled = false;
  $('#story-scene-hint').textContent = approvedCharacters.length || approvedLocations.length
    ? 'Only approved locations and characters can be linked. The server rejects unapproved links.'
    : 'Approve at least one character and location before linking scenes.';
}

async function saveStoryScenes() {
  const cards = Array.from($('#story-scenes').querySelectorAll('.story-scene-card'));
  const scenes = cards.map((card) => {
    const fields = card._storyFields;
    const locationId = fields.locationSelect.value;
    const location = (state.story.data.locations || []).find((item) => item.id === locationId);
    const characterIds = Array.from(fields.characterList.querySelectorAll('input:checked')).map((input) => input.value);
    const selectedCharacters = characterIds.map((id) => (state.story.data.characters || []).find((item) => item.id === id)).filter(Boolean).map((item) => item.name);
    const unlinkedCharacterNames = fields.characterNames.value.split(',').map((value) => value.trim()).filter(Boolean);
    return {
      id: card.dataset.sceneCard,
      title: fields.title.value,
      beat: fields.beat.value,
      props: fields.props.value,
      action: fields.action.value,
      location: location ? location.name : fields.locationText.value.trim(),
      locationId,
      characters: selectedCharacters.length ? selectedCharacters : unlinkedCharacterNames,
      characterIds,
    };
  });
  try {
    const { scenes: saved } = await api(`/api/story/${encodeURIComponent(state.story.projectId)}/scenes`, {
      method: 'PUT',
      body: { scenes },
    });
    state.story.data.scenes = saved;
    state.story.dirty = false;
    await loadStory(state.story.projectId);
    refreshSidebarStory(true);
    toast('Scenes saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the scenes.', 'error');
  }
}

function renderStorySheetOptions() {
  const story = state.story.data;
  const select = $('#story-sheet-character');
  if (!story || !select) return;
  select.innerHTML = '';
  story.characters.forEach((character) => {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = character.name;
    select.appendChild(option);
  });
  if (story.characters.some((character) => character.id === state.story.sheetCharacterId)) {
    select.value = state.story.sheetCharacterId;
  } else {
    state.story.sheetCharacterId = story.characters[0] ? story.characters[0].id : '';
    select.value = state.story.sheetCharacterId;
  }
  if (!story.characters.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No characters';
    select.appendChild(option);
  }
}

function renderStorySheets() {
  const story = state.story.data;
  const container = $('#story-sheets');
  if (!story || !container) return;
  container.innerHTML = '';
  const characterId = state.story.sheetCharacterId;
  const sheets = (story.characterSheets || [])
    .filter((sheet) => sheet.characterId === characterId)
    .sort((a, b) => b.version - a.version);
  if (!sheets.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No character sheets yet. Generate a photorealistic reference image for this character.';
    container.appendChild(empty);
  }
  sheets.forEach((sheet) => {
    const card = document.createElement('div');
    card.className = 'story-sheet-version';
    const head = document.createElement('div');
    head.className = 'story-prompt-head';
    const version = document.createElement('strong');
    version.textContent = `Version ${sheet.version}`;
    const status = document.createElement('span');
    status.className = `story-badge ${sheet.status === 'final' ? 'approved' : 'draft'}`;
    status.textContent = sheet.status === 'final' ? 'Final' : 'Draft';
    const meta = document.createElement('span');
    meta.className = 'story-ref-meta';
    meta.textContent = sheet.imageModel || 'Image model not recorded';
    head.append(version, status, meta);

    const img = document.createElement('img');
    img.className = 'story-sheet-image';
    img.src = `/api/story/sheet-image/${encodeURIComponent(story.projectId)}/${encodeURIComponent(sheet.file)}`;
    img.alt = `Character sheet version ${sheet.version}`;
    img.loading = 'lazy';

    const actions = document.createElement('div');
    actions.className = 'story-form-actions';
    if (sheet.status !== 'final') {
      const promote = document.createElement('button');
      promote.type = 'button';
      promote.className = 'btn btn-secondary btn-sm';
      promote.textContent = 'Promote to final';
      promote.addEventListener('click', async () => {
        try {
          await api(`/api/story/sheets/${encodeURIComponent(sheet.id)}/promote`, { method: 'POST' });
          await loadStory(state.story.projectId);
          toast('Character sheet promoted to final.', 'success');
        } catch (err) {
          toast(err.message || 'Could not promote the character sheet.', 'error');
        }
      });
      actions.appendChild(promote);
    }
    card.append(head, img, actions);
    container.appendChild(card);
  });
}

function promptDiffTokens(textValue) {
  return String(textValue || '').split(/(\s+)/).filter((token) => token !== '');
}

function appendPromptDiff(column, textValue, otherText) {
  const heading = document.createElement('h4');
  heading.textContent = 'Version text';
  const body = document.createElement('div');
  body.className = 'prompt-diff-text';
  const tokens = promptDiffTokens(textValue);
  const other = promptDiffTokens(otherText);
  let prefix = 0;
  while (prefix < tokens.length && prefix < other.length && tokens[prefix] === other[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < tokens.length - prefix &&
    suffix < other.length - prefix &&
    tokens[tokens.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) suffix += 1;
  const before = tokens.slice(0, prefix).join('');
  const changed = tokens.slice(prefix, tokens.length - suffix).join('');
  const after = suffix ? tokens.slice(tokens.length - suffix).join('') : '';
  body.appendChild(document.createTextNode(before));
  if (changed) {
    const mark = document.createElement('mark');
    mark.textContent = changed;
    body.appendChild(mark);
  }
  body.appendChild(document.createTextNode(after));
  column.append(heading, body);
}

async function generateStorySheet() {
  const projectId = state.story.projectId;
  const characterId = state.story.sheetCharacterId;
  if (!characterId) return toast('Add or choose a character first.', 'error');
  if (!state.user) return showAuth();
  if (!hasImageApiKey()) {
    toast(`Save your ${imageProviderLabel()} API key in Settings to generate images.`, 'error');
    switchTab('apis');
    return;
  }
  const button = $('#story-generate-sheet');
  button.disabled = true;
  button.textContent = 'Generating…';
  const processId = startProcess('Generating character sheet');
  try {
    await api(`/api/story/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}/sheets/generate`, {
      method: 'POST',
    });
    await loadStory(projectId);
    refreshSidebarStory(true);
    toast('Character sheet image generated.', 'success');
  } catch (err) {
    handleMissingImageKey(err);
    toast(err.message || 'Could not generate the character sheet.', 'error');
  } finally {
    finishProcess(processId);
    button.disabled = false;
    button.textContent = '✨ Generate character sheet';
  }
}

function renderStoryWarnings() {
  const story = state.story.data;
  const container = $('#story-warnings');
  if (!story) return;
  container.innerHTML = '';
  const warnings = story.warnings || [];
  $('#story-warning-count').textContent = warnings.length ? `${warnings.length} warning(s)` : 'No warnings';
  if (!warnings.length) {
    const clean = document.createElement('p');
    clean.className = 'hint';
    clean.textContent = 'No continuity warnings. This does not imply publication approval.';
    container.appendChild(clean);
    return;
  }
  warnings.forEach((warning) => {
    const row = document.createElement('div');
    row.className = 'story-warning';
    const text = document.createElement('span');
    text.textContent = warning.message;
    row.appendChild(text);
    if (warning.sceneId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm';
      button.textContent = 'Go to scene';
      button.addEventListener('click', () => {
        const card = document.querySelector(`[data-scene-card="${warning.sceneId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('story-flash');
          setTimeout(() => card.classList.remove('story-flash'), 1200);
        }
      });
      row.appendChild(button);
    } else if (warning.referenceId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm';
      button.textContent = 'Go to reference';
      button.addEventListener('click', () => {
        const card = document.querySelector(`[data-reference-id="${warning.referenceId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('story-flash');
          setTimeout(() => card.classList.remove('story-flash'), 1200);
        }
      });
      row.appendChild(button);
    }
    container.appendChild(row);
  });
}

async function saveStoryBrief() {
  try {
    await api(`/api/story/${encodeURIComponent(state.story.projectId)}/brief`, {
      method: 'PUT',
      body: {
        title: $('#story-brief-title').value,
        logline: $('#story-brief-logline').value,
        premise: $('#story-brief-premise').value,
        tone: $('#story-brief-tone').value,
        genre: $('#story-brief-genre').value,
        audience: $('#story-brief-audience').value,
        setting: $('#story-brief-setting').value,
      },
    });
    await loadStory(state.story.projectId);
    refreshSidebarStory(true);
    toast('Story brief saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the story brief.', 'error');
  }
}

async function generateStoryWorkspace(replace = false) {
  const projectId = state.story.projectId;
  if (!projectId) return toast('Choose a project first.', 'error');
  if (!state.user) return showAuth();
  if (!hasTextApiKey()) {
    toast('Save the selected text provider API key in Settings first.', 'error');
    switchTab('apis');
    return;
  }

  const button = $('#story-generate-workspace');
  if (button) {
    button.disabled = true;
    button.textContent = 'Generating…';
  }
  let retryReplace = false;
  try {
    const data = await api(`/api/story/${encodeURIComponent(projectId)}/workspace/generate`, {
      method: 'POST',
      body: { replace },
    });
    state.story.data = data.story;
    renderStory();
    refreshSidebarStory(true);
    const note = data.workspace && data.workspace.replaced
      ? 'Structured workspace replaced with newly generated drafts (awaiting review).'
      : 'Structured Story Workspace drafts generated from the reference material (awaiting review).';
    toast(note, 'success');
  } catch (err) {
    if (err.code === 'WORKSPACE_REPLACE_REQUIRED') {
      const confirmReplace = confirm(
        'Structured Story Workspace records already exist for this project. Replace them — including any edits or approvals — with newly generated drafts?'
      );
      if (confirmReplace) retryReplace = true;
      else toast('Generation cancelled. Existing structured records were kept.', 'error');
    } else {
      if (err.code === 'NO_API_KEY') {
        state.user.hasApiKey = false;
        renderKeyState();
      }
      toast(err.message || 'Could not generate the workspace.', 'error');
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '✨ Generate workspace from reference';
    }
  }

  if (retryReplace) return generateStoryWorkspace(true);
}

// The caller may pass its own processId so a batch run keeps one tracker row
// for the whole batch instead of one per character.
async function generateWorksheetSheet(characterId, button, ownedProcessId) {
  if (!hasImageApiKey()) return toast(`Save your ${imageProviderLabel()} API key in Settings to generate images.`, 'error');
  const processId = ownedProcessId || startProcess('Generating character reference sheet');
  button.disabled = true;
  try {
    await api(`/api/story/${encodeURIComponent(state.story.projectId)}/characters/${encodeURIComponent(characterId)}/sheets/generate`, { method: 'POST' });
    await loadStory(state.story.projectId);
    toast('Sheet ready to review. Add it or generate again.', 'success');
  } catch (err) { toast(err.message || 'Could not generate sheet.', 'error'); }
  finally {
    if (!ownedProcessId) finishProcess(processId);
    button.disabled = false;
  }
}

async function generateWorksheetReferences(type) {
  const projectId = state.story.projectId;
  const button = $(`#worksheet-generate-${type}`);
  if (!hasTextApiKey()) return toast('Save the selected text provider API key in Settings first.', 'error');
  button.disabled = true;
  try {
    const body = type === 'actions' ? { count: Number($('#worksheet-picture-count').value) } : {};
    const data = await api(`/api/story/${encodeURIComponent(projectId)}/worksheet/${type}/generate`, { method: 'POST', body });
    if (state.story.projectId !== projectId) return;
    if (type === 'actions') state.story.actionDraft = data.actions;
    else state.story.locationDraft = data.locations;
    renderWorksheet();
    toast('Review the draft, then save or generate again.', 'success');
  } catch (err) { toast(err.message || 'Could not generate references.', 'error'); }
  finally { button.disabled = false; }
}

async function saveWorksheetReferences(type) {
  const projectId = state.story.projectId;
  const items = type === 'actions' ? state.story.actionDraft : state.story.locationDraft;
  if (!items) return;
  const button = $(`#worksheet-save-${type}`);
  button.disabled = true;
  try {
    await api(`/api/story/${encodeURIComponent(projectId)}/worksheet/${type}/save`, { method: 'POST', body: { [type]: items } });
    if (state.story.projectId !== projectId) return;
    await loadStory(projectId);
    if (type === 'actions') { state.story.locationDraft = null; state.story.actionDraft = null; }
    else state.story.locationDraft = null;
    renderWorksheet();
    toast(`${type === 'actions' ? 'Action' : 'Location'} references saved.`, 'success');
  } catch (err) { toast(err.message || 'Could not save references.', 'error'); button.disabled = false; }
}

$('#story-generate-worksheet').addEventListener('click', () => {
  state.story.worksheetOpen = true;
  renderStoryState();
  if (state.story.data) renderWorksheet();
});
$('#worksheet-generate-one').addEventListener('click', (event) => generateWorksheetSheet($('#worksheet-character').value, event.currentTarget));
$('#worksheet-generate-all').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const story = state.story.data;
  const characters = (story.referenceSource?.characterReferences || []).map((item) =>
    story.characters.find((character) => character.name === item.name && item.referenceMaterial)).filter(Boolean);
  if (!characters.length) {
    button.disabled = false;
    return toast('Add a character reference for at least one character first.', 'error');
  }
  const processId = startProcess(`Generating ${characters.length} character reference sheet(s)`);
  try {
    let index = 0;
    for (const character of characters) {
      if (state.story.projectId !== story.projectId) break;
      index += 1;
      updateProcess(processId, `Generating character sheet ${index} of ${characters.length}`);
      await generateWorksheetSheet(character.id, button, processId);
    }
  } finally {
    finishProcess(processId);
  }
  if (state.story.projectId === story.projectId) button.disabled = false;
});
['actions', 'locations'].forEach((type) => {
  $(`#worksheet-generate-${type}`).addEventListener('click', () => generateWorksheetReferences(type));
  $(`#worksheet-save-${type}`).addEventListener('click', () => saveWorksheetReferences(type));
});
$('#story-project').addEventListener('change', (event) => {
  if (state.story.dirty && !confirm('Discard unsaved story changes?')) {
    event.target.value = state.story.projectId;
    return;
  }
  state.story.projectId = event.target.value;
  state.story.editor = null;
  state.story.sheetCharacterId = '';
  state.story.worksheetOpen = true;
  state.story.actionDraft = null;
  state.story.locationDraft = null;
  loadStory(state.story.projectId);
});
const storyRefresh = $('#story-refresh');
if (storyRefresh) storyRefresh.addEventListener('click', () => loadStory(state.story.projectId));
$('#story-retry').addEventListener('click', () => loadStory(state.story.projectId));
const storyGenerateWorkspace = $('#story-generate-workspace');
if (storyGenerateWorkspace) storyGenerateWorkspace.addEventListener('click', () => generateStoryWorkspace(false));
$('#story-save-brief').addEventListener('click', saveStoryBrief);
const storyValidate = $('#story-validate');
if (storyValidate) storyValidate.addEventListener('click', async () => {
  try {
    const { warnings } = await api(`/api/story/${encodeURIComponent(state.story.projectId)}/validate`);
    state.story.data.warnings = warnings;
    renderStoryWarnings();
    toast(warnings.length ? `Found ${warnings.length} continuity warning(s).` : 'No continuity warnings.', warnings.length ? 'error' : 'success');
  } catch (err) {
    toast(err.message || 'Could not validate continuity.', 'error');
  }
});
['#story-add-character', '#story-add-location', '#story-add-style'].forEach((selector, index) => {
  $(selector).addEventListener('click', () => {
    state.story.editor = { type: ['character', 'location', 'style'][index], id: null };
    renderStoryReferences(state.story.editor.type);
  });
});
$('#story-add-scene').addEventListener('click', () => {
  state.story.data.scenes.push({
    id: `scene-${Date.now()}`,
    order: state.story.data.scenes.length,
    title: `Scene ${state.story.data.scenes.length + 1}`,
    beat: '',
    props: '',
    action: '',
    location: '',
    characters: [],
    locationId: '',
    characterIds: [],
  });
  storyMarkDirty();
  renderStoryScenes();
});
$('#story-save-scenes').addEventListener('click', saveStoryScenes);
$('#story-sheet-character').addEventListener('change', (event) => {
  state.story.sheetCharacterId = event.target.value;
  renderStorySheets();
});
$('#story-generate-sheet').addEventListener('click', generateStorySheet);
$('#story-content').addEventListener('input', storyMarkDirty);
$('#story-content').addEventListener('change', storyMarkDirty);

$('#ref-open-story').addEventListener('click', () => switchTab('story'));
$('#gen-open-story').addEventListener('click', () => switchTab('story'));

// ---------------------------------------------------------------------------
// Sidebar: AI request tracker + CarniChat
// ---------------------------------------------------------------------------
const TRACK_OPERATION_LABELS = {
  '/api/generate': 'Generate ideas',
  '/api/reference': 'Generate reference material',
  '/api/generation/prompts': 'Generate scene prompts',
  '/api/generation/prompt': 'Regenerate scene prompt',
  '/api/generation/images/one': 'Generate scene image',
  '/api/images/generate': 'Generate scene image',
  '/api/images/upload': 'Upload image',
  '/api/chat': 'Chat',
  '/api/reviewer/review': 'Review fields',
  '/api/story': 'Story action',
  '/api/story/workspace/generate': 'Generate story workspace',
};

const TRACK_STATUS_LABELS = {
  pending: 'In progress',
  success: 'Complete',
  error: 'Failed',
  interrupted: 'Interrupted',
};

const TRACK_LIMIT = 6;
let trackPollTimer = null;
let trackInFlight = false;

function sidebarProject() {
  return state.projects.find((p) => p.id === state.sidebar.projectId) || null;
}

function trackRowLabel(entry) {
  if (entry.label) return entry.label;
  return TRACK_OPERATION_LABELS[entry.operation] || entry.operation || 'AI request';
}

function trackRowModel(entry) {
  if (!entry.model) return '';
  return String(entry.model).startsWith('deepseek-') ? 'DeepSeek' : entry.model;
}

function renderSidebarTrack() {
  const list = $('#sidebar-track');
  const empty = $('#sidebar-track-empty');
  if (!list || !empty) return;
  list.innerHTML = '';
  const items = state.sidebar.track;
  empty.classList.toggle('hidden', items.length > 0);

  items.forEach((entry) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'track-item track-item-' + (entry.status || 'pending');
    item.title = `Open Track for: ${trackRowLabel(entry)}`;

    const icon = document.createElement('span');
    icon.className = 'track-icon';
    icon.textContent = entry.status === 'success' ? '✨' : '⚙️';

    const label = document.createElement('span');
    label.className = 'track-label';
    label.textContent = trackRowLabel(entry);

    const model = trackRowModel(entry);
    if (model) {
      const modelEl = document.createElement('span');
      modelEl.className = 'track-model';
      modelEl.textContent = model;
      item.append(icon, label, modelEl);
    } else {
      item.append(icon, label);
    }

    const time = document.createElement('span');
    time.className = 'track-time';
    time.textContent = entry.time;

    const status = document.createElement('span');
    status.className = 'track-status-icon ' + (entry.status || 'pending');
    status.textContent = entry.status === 'success' ? '✓' : entry.status === 'pending' ? '' : '✕';
    status.title = TRACK_STATUS_LABELS[entry.status] || entry.status || '';

    item.append(time, status);
    item.addEventListener('click', () => {
      const full = '/track/';
      const win = window.open(full, '_blank');
      if (!win) window.location.href = full;
    });
    list.appendChild(item);
  });
}

async function loadSidebarTrack() {
  if (trackInFlight || !state.user) return;
  trackInFlight = true;
  try {
    const data = await api(`/api/track?limit=${TRACK_LIMIT}`);
    const outgoing = (Array.isArray(data.requests) ? data.requests : [])
      .filter((entry) => entry.direction === 'outgoing')
      .map((entry) => ({
        operation: entry.operation || '/api/generate',
        model: entry.model || '',
        status: entry.status || 'pending',
        durationMs: entry.durationMs,
        startedAt: entry.startedAt,
        time: entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString([], { hour12: false }) : '',
      }))
      .slice(0, TRACK_LIMIT);
    if (!state.user || !sidebarTrackItemsEqual(state.sidebar.track, outgoing)) {
      state.sidebar.track = outgoing;
      renderSidebarTrack();
    }
  } catch (_) {
    // The sidebar is a convenience view; a loading failure must not disturb the app.
  } finally {
    trackInFlight = false;
  }
}

function sidebarTrackItemsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].operation !== b[i].operation || a[i].status !== b[i].status ||
        a[i].startedAt !== b[i].startedAt || a[i].model !== b[i].model) return false;
  }
  return true;
}

function startSidebarTrackPolling() {
  stopSidebarTrackPolling();
  loadSidebarTrack();
  trackPollTimer = setInterval(loadSidebarTrack, 2000);
}

function stopSidebarTrackPolling() {
  if (trackPollTimer) {
    clearInterval(trackPollTimer);
    trackPollTimer = null;
  }
  trackInFlight = false;
}

function resetSidebarTrack() {
  state.sidebar.track = [];
  renderSidebarTrack();
}

function renderSidebarProjects() {
  const select = $('#sidebar-project');
  if (!select) return;
  const previous = state.sidebar.projectId;
  select.innerHTML = '';
  if (!state.projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No projects yet';
    select.appendChild(option);
    select.disabled = true;
    select.value = '';
    state.sidebar.projectId = '';
    return;
  }
  select.disabled = false;
  state.projects.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.status === 'Done' ? `${p.title} ✓` : p.title;
    select.appendChild(option);
  });
  const valid = state.projects.some((p) => p.id === previous);
  const next = valid ? previous : state.projects[0].id;
  if (next !== state.sidebar.projectId) state.sidebar.projectId = next;
  select.value = state.sidebar.projectId;
}

async function refreshSidebarStory(force = false) {
  const projectId = state.sidebar.projectId;
  if (!projectId) return;
  if (!force && state.sidebar.storyProjectId === projectId) return;
  try {
    const { story } = await api(`/api/story/${encodeURIComponent(projectId)}`);
    if (state.sidebar.projectId !== projectId) return;
    state.sidebar.story = story;
    state.sidebar.storyProjectId = projectId;
  } catch (_) {
    state.sidebar.story = null;
    state.sidebar.storyProjectId = projectId;
  }
}

function allScenesHaveImages(project) {
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  if (!scenes.length) return false;
  const images = Array.isArray(project.sceneImages) ? project.sceneImages : [];
  return scenes.every((scene) => images.some((image) => image.sceneId === scene.id));
}

function sidebarNextStepInfo() {
  const project = sidebarProject();
  if (!project) {
    return { disabled: true, label: '→ Next step', title: 'Select a project.' };
  }
  if (project.status === 'Done') {
    return { disabled: true, label: '✓ Completed', title: 'This project is complete.' };
  }
  const stage = project.stage || 'Idea Stage';
  if (stage === 'Idea Stage') {
    const ready = Boolean((project.idea || '').trim());
    return {
      disabled: !ready,
      label: '→ Move to Reference Stage',
      title: ready ? 'Advance this project to Reference Stage' : 'Capture an idea first.',
    };
  }
  if (stage === 'Reference Stage') {
    const ready = Boolean((project.referenceMaterial || '').trim());
    return {
      disabled: !ready,
      label: '→ Move to Generation Stage',
      title: ready ? 'Advance this project to Generation Stage' : 'Generate reference material first.',
    };
  }
  const ready = allScenesHaveImages(project);
  return {
    disabled: !ready,
    label: '✓ Complete project',
    title: ready ? 'Mark this project complete' : 'Generate all scene images first.',
  };
}

function renderSidebarNextStep() {
  const button = $('#sidebar-next-step');
  if (!button) return;
  const info = sidebarNextStepInfo();
  button.disabled = info.disabled;
  button.textContent = info.label;
  button.title = info.title;
}

function renderSidebar() {
  renderSidebarProjects();
  renderSidebarNextStep();
  renderSidebarTrack();
  if (state.chat.mode === 'reviewer') renderReviewer();
}

function resetSidebarAndChat() {
  if (typeof workspaceReset === 'function') workspaceReset();
  state.sidebar.projectId = '';
  state.sidebar.story = null;
  state.sidebar.storyProjectId = '';
  state.sidebar.track = [];
  state.chat.mode = 'guide';
  state.chat.guide = [];
  state.chat.reviewer = [];
  state.chat.busy = false;
  state.reviewer.projectId = '';
  state.reviewer.box = 'scene-prompts';
  state.reviewer.fields = [];
  state.reviewer.loading = false;
  state.reviewer.running = false;
  state.reviewer.error = '';
  state.reviewer.loadedProjectId = '';
  state.reviewer.loadedBox = '';
  state.reviewer.loadToken += 1;
  state.reviewer.runToken += 1;
}

// Chat
function chatMessages() {
  return state.chat.mode === 'reviewer' ? state.chat.reviewer : state.chat.guide;
}

function setChatBusy(busy) {
  state.chat.busy = busy;
  const send = $('#chat-send');
  if (send) send.disabled = busy;
  const typing = $('#chat-typing');
  if (typing) typing.classList.toggle('hidden', !busy);
}

const REVIEWER_STATUS_LABELS = {
  pending: 'Pending',
  processing: 'Processing',
  reviewed: 'Reviewed',
  failed: 'Failed',
};

function guideHasCredentials() {
  if (!state.user) return false;
  const provider = state.user.guideProvider || 'deepseek';
  if (provider === 'anthropic') return Boolean(state.user.hasAnthropicKey);
  if (provider === 'openai') return Boolean(state.user.hasOpenAIKey);
  if (provider === 'openai-direct') return Boolean(state.user.hasDirectOpenAIKey);
  return Boolean(state.user.hasApiKey);
}

function reviewerHasCredentials() {
  if (!state.user) return false;
  const provider = state.user.reviewerProvider || 'deepseek';
  if (provider === 'anthropic') return Boolean(state.user.hasAnthropicKey);
  if (provider === 'openai') return Boolean(state.user.hasOpenAIKey);
  if (provider === 'openai-direct') return Boolean(state.user.hasDirectOpenAIKey);
  return Boolean(state.user.hasApiKey);
}

function reviewerProjectCandidates() {
  const active = state.projects.filter((project) => project.status !== 'Done');
  const pool = active.length ? active : state.projects;
  return pool.slice().sort((a, b) => {
    const stageOrder = PROJECT_STAGES.indexOf(a.stage || 'Idea Stage') - PROJECT_STAGES.indexOf(b.stage || 'Idea Stage');
    if (stageOrder) return stageOrder;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function selectedReviewerProject() {
  return state.projects.find((project) => project.id === state.reviewer.projectId) || null;
}

function reviewerStatusIcon(status) {
  const icon = document.createElement('span');
  const safeStatus = REVIEWER_STATUS_LABELS[status] ? status : 'pending';
  icon.className = `reviewer-status-icon ${safeStatus}`;
  icon.setAttribute('aria-label', REVIEWER_STATUS_LABELS[safeStatus]);
  icon.title = REVIEWER_STATUS_LABELS[safeStatus];
  if (safeStatus === 'processing') {
    const spinner = document.createElement('span');
    spinner.className = 'reviewer-spinner';
    icon.appendChild(spinner);
  } else {
    icon.textContent = safeStatus === 'reviewed' ? '✓' : safeStatus === 'failed' ? '✕' : '○';
  }
  return icon;
}

function renderReviewerProjectSelect() {
  const select = $('#reviewer-project');
  if (!select) return;
  const candidates = reviewerProjectCandidates();
  const signature = candidates
    .map((project) => `${project.id}:${project.stage || ''}:${project.title || ''}`)
    .join('|');

  if (select.dataset.signature !== signature) {
    select.innerHTML = '';
    if (!candidates.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No projects yet';
      select.appendChild(option);
    } else {
      candidates.forEach((project) => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.status === 'Done' ? `${project.title} ✓` : project.title;
        select.appendChild(option);
      });
    }
    select.dataset.signature = signature;
  }

  select.disabled = !candidates.length;
  if (!candidates.some((project) => project.id === state.reviewer.projectId)) {
    const nextId = candidates[0] ? candidates[0].id : '';
    if (nextId !== state.reviewer.projectId) {
      state.reviewer.running = false;
      state.reviewer.loadToken += 1;
      state.reviewer.runToken += 1;
    }
    state.reviewer.projectId = nextId;
    state.reviewer.fields = [];
    state.reviewer.error = '';
    state.reviewer.loadedProjectId = '';
    state.reviewer.loadedBox = '';
  }
  if (!candidates.length) select.value = '';
  else select.value = state.reviewer.projectId;
}

function renderReviewerBoxSelect() {
  const select = $('#reviewer-box');
  if (!select) return;
  if (!select.options.length) {
    REVIEWER_BOX_OPTIONS.forEach((box) => {
      const option = document.createElement('option');
      option.value = box.id;
      option.textContent = box.label;
      select.appendChild(option);
    });
  }
  if (!REVIEWER_BOX_OPTIONS.some((box) => box.id === state.reviewer.box)) {
    state.reviewer.box = 'scene-prompts';
  }
  select.value = state.reviewer.box;
}

function reviewerBoxLabel() {
  const box = REVIEWER_BOX_OPTIONS.find((item) => item.id === state.reviewer.box);
  return box ? box.label : 'Scene Prompts';
}

function renderReviewerFields() {
  const list = $('#reviewer-fields');
  const empty = $('#reviewer-empty');
  if (!list) return;
  list.innerHTML = '';
  const fields = state.reviewer.fields;

  fields.forEach((field) => {
    const item = document.createElement('li');
    item.className = 'reviewer-field-item';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `reviewer-field-row ${field.status || 'pending'}`;
    row.dataset.fieldId = field.id;
    row.title = `${field.label} — ${REVIEWER_STATUS_LABELS[field.status] || 'Pending'}`;

    const label = document.createElement('span');
    label.className = 'reviewer-field-label';
    label.textContent = field.label;

    row.append(label, reviewerStatusIcon(field.status || 'pending'));
    row.addEventListener('click', () => openReviewerDetails(field.id));
    item.appendChild(row);
    list.appendChild(item);
  });

  if (empty) {
    empty.classList.toggle('hidden', Boolean(fields.length));
    empty.textContent = state.reviewer.loading
      ? 'Loading fields…'
      : state.reviewer.error
        ? state.reviewer.error
        : 'No fields in this section yet.';
  }

  const details = $('#reviewer-details-btn');
  if (details) details.disabled = !fields.length;
}

function renderReviewer() {
  const stageLabel = $('#reviewer-stage-label');
  const boxLabel = $('#reviewer-box-label');
  const run = $('#reviewer-run');
  const rerun = $('#reviewer-rerun');
  const hint = $('#reviewer-hint');

  renderReviewerProjectSelect();
  renderReviewerBoxSelect();
  const project = selectedReviewerProject();

  if (stageLabel) stageLabel.textContent = project ? project.stage || 'Idea Stage' : 'No project';
  if (boxLabel) boxLabel.textContent = reviewerBoxLabel();
  renderReviewerFields();

  if (!project) {
    if (run) {
      run.disabled = true;
      run.textContent = 'Review';
    }
    if (rerun) rerun.disabled = true;
    if (hint) hint.textContent = 'Choose a project to review.';
    return;
  }

  if (!state.reviewer.loading
    && !state.reviewer.running
    && (state.reviewer.loadedProjectId !== state.reviewer.projectId
      || state.reviewer.loadedBox !== state.reviewer.box)) {
    loadReviewerFields();
  }

  if (run) {
    run.disabled = state.reviewer.loading
      || state.reviewer.running
      || !state.reviewer.fields.length
      || !reviewerHasCredentials();
    run.textContent = state.reviewer.running ? 'Reviewing…' : 'Review';
  }
  if (rerun) rerun.disabled = run ? run.disabled : true;

  if (hint) {
    if (!reviewerHasCredentials()) {
      hint.textContent = 'Save the Reviewer API key in Settings to run reviews.';
    } else if (state.reviewer.error) {
      hint.textContent = state.reviewer.error;
    } else if (state.reviewer.loading) {
      hint.textContent = 'Loading fields…';
    } else if (state.reviewer.running) {
      const processing = state.reviewer.fields.filter((field) => field.status === 'processing').length;
      hint.textContent = `Reviewing ${processing} field${processing === 1 ? '' : 's'}…`;
    } else if (!state.reviewer.fields.length) {
      hint.textContent = 'No fields to review in this section.';
    } else {
      const reviewed = state.reviewer.fields.filter((field) => field.status === 'reviewed').length;
      const failed = state.reviewer.fields.filter((field) => field.status === 'failed').length;
      const pending = state.reviewer.fields.filter((field) => field.status === 'pending').length;
      hint.textContent = `${reviewed} reviewed · ${failed} failed · ${pending} pending`;
    }
  }
}

async function loadReviewerFields() {
  const projectId = state.reviewer.projectId;
  const box = state.reviewer.box;
  if (!projectId) {
    state.reviewer.fields = [];
    state.reviewer.loading = false;
    renderReviewer();
    return;
  }

  const token = ++state.reviewer.loadToken;
  state.reviewer.loading = true;
  state.reviewer.error = '';
  state.reviewer.fields = [];
  state.reviewer.loadedProjectId = projectId;
  state.reviewer.loadedBox = box;
  renderReviewer();

  try {
    const data = await api(
      `/api/reviewer/fields?projectId=${encodeURIComponent(projectId)}&box=${encodeURIComponent(box)}`
    );
    if (token !== state.reviewer.loadToken
      || projectId !== state.reviewer.projectId
      || box !== state.reviewer.box) return;
    state.reviewer.fields = (data.fields || []).map((field) => {
      const review = field.review;
      const hasResult = Boolean(review && (review.status === 'reviewed' || review.status === 'failed'));
      return {
        id: field.id,
        label: field.label,
        hasContent: Boolean(field.hasContent),
        contentHash: field.contentHash || '',
        status: hasResult ? (review.status === 'reviewed' ? 'reviewed' : 'failed') : 'pending',
        summary: review ? review.summary || '' : '',
        findings: review ? review.findings || [] : [],
        suggestions: review ? review.suggestions || [] : [],
        model: review ? review.model || null : null,
        reviewedAt: review ? review.reviewedAt || '' : '',
      };
    });
  } catch (err) {
    if (token !== state.reviewer.loadToken) return;
    state.reviewer.error = err.message || 'Could not load fields.';
    state.reviewer.fields = [];
  } finally {
    if (token === state.reviewer.loadToken) {
      state.reviewer.loading = false;
      renderReviewer();
    }
  }
}

async function runReviewer(force = false) {
  if (state.reviewer.running || state.reviewer.loading || !state.reviewer.fields.length) return;
  if (!state.user) return showAuth();
  if (!reviewerHasCredentials()) {
    toast('Save the Reviewer API key in Settings first.', 'error');
    return;
  }
  const projectId = state.reviewer.projectId;
  const box = state.reviewer.box;
  const runToken = ++state.reviewer.runToken;
  const fields = state.reviewer.fields;
  // The server checks current content and settings, including changes made in another tab.
  const pending = fields;

  state.reviewer.running = true;
  state.reviewer.error = '';
  pending.forEach((field) => {
    field.status = 'processing';
    field.summary = '';
    field.findings = [];
    field.suggestions = [];
  });
  renderReviewer();

  try {
    const data = await api('/api/reviewer/review', {
      method: 'POST',
      body: { projectId, box, force },
    });
    if (runToken !== state.reviewer.runToken || projectId !== state.reviewer.projectId || box !== state.reviewer.box) {
      return;
    }
    const byId = new Map((data.reviews || []).map((review) => [review.id, review]));
    fields.forEach((field) => {
      const review = byId.get(field.id);
      if (!review) return;
      field.status = review.status === 'reviewed' ? 'reviewed' : 'failed';
      field.summary = review.summary || '';
      field.findings = Array.isArray(review.findings) ? review.findings : [];
      field.suggestions = Array.isArray(review.suggestions) ? review.suggestions : [];
      field.model = review.model || null;
      field.reviewedAt = review.reviewedAt || '';
    });
  } catch (err) {
    if (runToken !== state.reviewer.runToken) return;
    state.reviewer.error = err.message || 'The review could not be completed. Try again.';
    if (err.code === 'NO_API_KEY' && state.user) {
      state.user.hasApiKey = false;
      renderKeyState();
    }
    pending.forEach((field) => {
      field.status = 'failed';
      field.summary = err.message || 'The review could not be completed.';
      field.findings = [{ severity: 'error', message: err.message || 'The review request failed.' }];
      field.suggestions = [];
      field.reviewedAt = new Date().toISOString();
    });
  } finally {
    if (runToken === state.reviewer.runToken) {
      state.reviewer.running = false;
      renderReviewer();
      const reviewed = fields.filter((field) => field.status === 'reviewed').length;
      const failed = fields.filter((field) => field.status === 'failed').length;
      if (state.reviewer.error) toast(state.reviewer.error, 'error');
      else toast(`Review finished: ${reviewed} reviewed, ${failed} failed.`, failed ? 'warn' : 'success');
    }
  }
}

let reviewerReturnFocus = null;

function closeReviewerDetails() {
  const modal = $('#reviewer-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  state.reviewer.detailFieldId = '';
  document.removeEventListener('keydown', reviewerModalKeydown);
  if (reviewerReturnFocus && document.contains(reviewerReturnFocus)) reviewerReturnFocus.focus();
  reviewerReturnFocus = null;
}

function reviewerModalKeydown(event) {
  const modal = $('#reviewer-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeReviewerDetails();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  );
  if (!focusable.length) {
    event.preventDefault();
    modal.focus();
    return;
  }
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    focusable[0].focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openReviewerDetails(fieldId = '') {
  const modal = $('#reviewer-modal');
  if (!modal || !state.reviewer.fields.length) return;
  const project = selectedReviewerProject();
  const boxLabel = reviewerBoxLabel();
  const title = $('#reviewer-modal-title');
  const subtitle = $('#reviewer-modal-subtitle');
  title.textContent = 'Review details';
  subtitle.textContent = `${project ? project.title : 'Project'} · ${boxLabel}`;

  const list = $('#reviewer-detail-list');
  list.innerHTML = '';
  const counts = { reviewed: 0, failed: 0, pending: 0, processing: 0 };
  state.reviewer.fields.forEach((field) => {
    counts[field.status] = (counts[field.status] || 0) + 1;
  });
  const summary = document.createElement('p');
  summary.className = 'reviewer-detail-summary';
  summary.textContent = `${counts.reviewed} reviewed · ${counts.failed} failed · ${counts.pending + counts.processing} pending`;
  list.appendChild(summary);

  state.reviewer.fields.forEach((field) => {
    const card = document.createElement('article');
    card.className = `reviewer-detail${field.id === fieldId ? ' reviewer-detail-focus' : ''}`;
    const head = document.createElement('div');
    head.className = 'reviewer-detail-head';

    const label = document.createElement('strong');
    label.textContent = field.label;
    const status = document.createElement('span');
    status.className = 'reviewer-detail-status';
    status.append(reviewerStatusIcon(field.status || 'pending'));
    const statusText = document.createElement('span');
    statusText.textContent = REVIEWER_STATUS_LABELS[field.status] || 'Pending';
    status.appendChild(statusText);
    head.append(label, status);
    card.appendChild(head);

    const summaryText = document.createElement('p');
    summaryText.className = 'reviewer-detail-copy';
    summaryText.textContent = field.summary
      || (field.status === 'processing'
        ? 'Review in progress…'
        : field.status === 'reviewed'
          ? 'No summary was returned.'
          : 'Not reviewed yet.');
    card.appendChild(summaryText);

    if (field.findings && field.findings.length) {
      const findings = document.createElement('ul');
      findings.className = 'reviewer-findings';
      field.findings.forEach((finding) => {
        const item = document.createElement('li');
        item.className = `reviewer-finding ${finding.severity || 'warning'}`;
        item.textContent = finding.message || '';
        findings.appendChild(item);
      });
      card.appendChild(findings);
    }

    if (field.suggestions && field.suggestions.length) {
      const suggestions = document.createElement('div');
      suggestions.className = 'reviewer-suggestions';
      const heading = document.createElement('strong');
      heading.textContent = 'Suggestions';
      const ul = document.createElement('ul');
      field.suggestions.forEach((suggestion) => {
        const item = document.createElement('li');
        item.textContent = suggestion;
        ul.appendChild(item);
      });
      suggestions.append(heading, ul);
      card.appendChild(suggestions);
    }

    if (field.reviewedAt) {
      const meta = document.createElement('p');
      meta.className = 'reviewer-detail-meta';
      const when = new Date(field.reviewedAt);
      meta.textContent = Number.isNaN(when.getTime())
        ? 'Reviewed by the automated reviewer.'
        : `Reviewed ${when.toLocaleString()}${field.model ? ` · ${field.model}` : ''}`;
      card.appendChild(meta);
    }

    list.appendChild(card);
  });

  reviewerReturnFocus = document.activeElement;
  modal.classList.remove('hidden');
  $('#reviewer-modal-close').focus();
  document.addEventListener('keydown', reviewerModalKeydown);
  const focusCard = fieldId ? list.querySelector('.reviewer-detail-focus') : null;
  if (focusCard) focusCard.scrollIntoView({ block: 'nearest' });
}

function renderChat() {
  const list = $('#chat-messages');
  if (!list) return;
  list.innerHTML = '';
  const messages = chatMessages();
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = carniChatEmptyHint();
    list.appendChild(empty);
  } else {
    messages.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'chat-msg ' + (m.role === 'user' ? 'chat-user' : 'chat-bot');
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.textContent = m.content;
      (m.attachments || []).forEach((attachment) => {
        const image = document.createElement('img'); image.src = attachment.url; image.alt = attachment.name || 'Chat image'; image.className = 'chat-image'; bubble.appendChild(image);
      });
      row.appendChild(bubble);
      if (m.referenceDraft && m.projectId) {
        const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'chat-copy'; apply.textContent = 'Apply to reference fields';
        apply.addEventListener('click', () => applyReferenceChatDraft(m.referenceDraft, m.projectId)); row.appendChild(apply);
      }
      if (state.chat.mode === 'guide' && m.role === 'assistant') {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'chat-copy';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy guide response');
        copy.addEventListener('click', () => copyToClipboard(m.content, 'Response'));
        row.appendChild(copy);
      }
      list.appendChild(row);
    });
  }
  list.scrollTop = list.scrollHeight;

  const reviewer = state.chat.mode === 'reviewer';
  const guidePane = $('#guide-chat-pane');
  const reviewerPane = $('#reviewer-pane');
  const sidebar = $('#sidebar');
  if (sidebar) sidebar.classList.toggle('reviewer-mode', reviewer);
  if (guidePane) guidePane.classList.toggle('hidden', reviewer);
  if (reviewerPane) reviewerPane.classList.toggle('hidden', !reviewer);
  $$('.chat-mode').forEach((btn) => {
    const active = btn.dataset.chatMode === state.chat.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  if (reviewer) renderReviewer();
  if (typeof renderWorkspaceChat === 'function') renderWorkspaceChat();
}

function switchChatMode(mode) {
  if (mode !== 'guide' && mode !== 'reviewer') return;
  if (mode === 'guide') closeReviewerDetails();
  state.chat.mode = mode;
  if (typeof workspaceChatModelDirty !== 'undefined') workspaceChatModelDirty = false;
  if (mode === 'reviewer' && !state.reviewer.projectId) {
    const preferred = state.sidebar.projectId;
    if (state.projects.some((project) => project.id === preferred && project.status !== 'Done')) {
      state.reviewer.projectId = preferred;
    }
  }
  renderChat();
}

async function sendChat({ prompt = '', projectId = '', mode = state.chat.mode, referenceRequest = false } = {}) {
  if (!state.user) return showAuth();
  if (state.chat.busy) return;
  try { await ensureChatHistory(); } catch { return toast('Chat history could not load. Reconnect and try again.', 'error'); }
  if (state.chat.busy) return;
  const input = $('#chat-input'); const automatic = Boolean(prompt);
  const text = (automatic ? prompt : input.value).trim();
  const attachments = automatic ? [] : workspaceChatImages.slice();
  if (!text && !attachments.length) return;
  if (mode !== state.chat.mode) switchChatMode(mode);
  if (!(mode === 'reviewer' ? reviewerHasCredentials() : guideHasCredentials())) return toast('Save the selected chat provider key in Settings first.', 'error');
  const ownerId = state.user.id; const message = { id: crypto.randomUUID(), role: 'user', content: text, attachments };
  const messages = chatMessages(); messages.push(message);
  if (!automatic) { input.value = ''; workspaceChatImages = []; renderWorkspaceChat(); }
  const referenceProjectId = projectId || state.sidebar.projectId || '';
  const referenceInputs = referenceRequest ? referenceChatInputs() : null;
  const fingerprint = JSON.stringify(referenceInputs);
  renderChat(); setChatBusy(true);
  const processId = startProcess(referenceRequest ? 'CarniChat is preparing all reference fields' : 'CarniChat is replying');
  try {
    const data = await api('/api/chat', { method: 'POST', body: { mode, message,
      projectId: referenceProjectId, module: mode === 'reviewer' ? '' : state.ui.module,
      referenceRequest, referenceInputs } });
    if (state.user?.id !== ownerId) return;
    if (Array.isArray(data.messages)) state.chat[mode] = data.messages;
    else messages.push({ role: 'assistant', content: data.reply });
    if (data.referenceDraft && state.reference.projectId === referenceProjectId && JSON.stringify(referenceChatInputs()) === fingerprint) applyReferenceChatDraft(data.referenceDraft, referenceProjectId);
    else if (referenceRequest && !data.referenceDraft) toast('CarniChat replied, but did not return all reference fields. Your existing fields were kept.', 'error');
    renderChat();
  } catch (error) {
    if (state.user?.id !== ownerId) return;
    // Keep the failed text and attachments ready for another attempt.
    if (!automatic && !input.value) { input.value = text; workspaceChatImages = attachments; }
    try { const saved = await api('/api/chat/history'); if (state.user?.id === ownerId) { state.chat.guide = saved.guide || []; state.chat.reviewer = saved.reviewer || []; } } catch {}
    toast(error.message || 'Could not reach CarniChat.', 'error'); renderChat();
  } finally {
    finishProcess(processId);
    if (state.user?.id === ownerId) { setChatBusy(false); renderWorkspaceChat(); }
  }
}

$('#sidebar-project').addEventListener('change', (event) => {
  state.sidebar.projectId = event.target.value;
  state.sidebar.story = null;
  state.sidebar.storyProjectId = '';
  refreshSidebarStory();
  renderSidebarNextStep();
});
$('#sidebar-next-step').addEventListener('click', async () => {
  const project = sidebarProject();
  if (!project) return;
  const stage = project.stage || 'Idea Stage';
  const patch = stage === 'Idea Stage'
    ? { stage: 'Reference Stage' }
    : stage === 'Reference Stage'
      ? { stage: 'Generation Stage' }
      : { status: 'Done' };
  const nextLabel = stage === 'Idea Stage'
    ? 'Reference Stage'
    : stage === 'Reference Stage'
      ? 'Generation Stage'
      : 'completed';
  try {
    const { project: updated } = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: patch,
    });
    Object.assign(project, updated);
    renderProjects();
    renderSidebarNextStep();
    if (nextLabel === 'Reference Stage') {
      state.reference.projectId = project.id;
      switchTab('reference');
    }
    toast(nextLabel === 'completed' ? 'Project completed.' : `Project moved to ${nextLabel}.`, 'success');
  } catch (err) {
    toast(err.message || 'Could not advance the project.', 'error');
  }
});
$$('.chat-mode').forEach((btn) => btn.addEventListener('click', () => switchChatMode(btn.dataset.chatMode)));
$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat();
});

$('#reviewer-project').addEventListener('change', (event) => {
  closeReviewerDetails();
  state.reviewer.projectId = event.target.value;
  state.reviewer.fields = [];
  state.reviewer.error = '';
  state.reviewer.loadedProjectId = '';
  state.reviewer.loadedBox = '';
  state.reviewer.running = false;
  state.reviewer.loadToken += 1;
  state.reviewer.runToken += 1;
  renderReviewer();
});

$('#reviewer-box').addEventListener('change', (event) => {
  closeReviewerDetails();
  state.reviewer.box = event.target.value;
  state.reviewer.fields = [];
  state.reviewer.error = '';
  state.reviewer.loadedProjectId = '';
  state.reviewer.loadedBox = '';
  state.reviewer.running = false;
  state.reviewer.loadToken += 1;
  state.reviewer.runToken += 1;
  renderReviewer();
});

$('#reviewer-run').addEventListener('click', () => {
  runReviewer();
});
$('#reviewer-rerun').addEventListener('click', () => runReviewer(true));

$('#reviewer-details-btn').addEventListener('click', () => openReviewerDetails());
$('#reviewer-modal-close').addEventListener('click', closeReviewerDetails);
$('#reviewer-modal').addEventListener('click', (event) => {
  if (event.target === $('#reviewer-modal')) closeReviewerDetails();
});

// ---------------------------------------------------------------------------
// Character maker
//
// Standalone characters that belong to the signed-in user and to no project.
// Each generation appends a version; one version can be marked final.
// ---------------------------------------------------------------------------
function resetCharacters() {
  state.characters.loaded = false;
  state.characters.loading = false;
  state.characters.error = '';
  state.characters.items = [];
  state.characters.selectedId = '';
  state.characters.formFor = '';
  state.characters.saving = false;
  state.characters.generating = false;
}

function selectedCharacter() {
  return state.characters.items.find((item) => item.id === state.characters.selectedId) || null;
}

function upsertCharacter(character) {
  if (!character) return;
  const index = state.characters.items.findIndex((item) => item.id === character.id);
  if (index === -1) state.characters.items.unshift(character);
  else state.characters.items[index] = character;
}

async function loadCharacters(options = {}) {
  if (!state.user || state.characters.loading) return;
  if (state.characters.loaded && !options.force) {
    renderCharacters();
    return;
  }
  state.characters.loading = true;
  state.characters.error = '';
  renderCharacters();
  applyImageSizeOptions(currentImageModel(), '#character-size');
  try {
    const data = await api('/api/characters');
    state.characters.items = Array.isArray(data.characters) ? data.characters : [];
    state.characters.loaded = true;
    if (!selectedCharacter()) {
      state.characters.selectedId = state.characters.items.length ? state.characters.items[0].id : '';
    }
  } catch (err) {
    if (err.status !== 401) state.characters.error = err.message || 'Could not load characters.';
  } finally {
    state.characters.loading = false;
    renderCharacters();
  }
}

function renderCharacters() {
  const panel = $('#panel-characters');
  if (!panel) return;

  const error = $('#characters-error');
  error.classList.toggle('hidden', !state.characters.error);
  if (state.characters.error) $('#characters-error-text').textContent = state.characters.error;

  const list = $('#character-list');
  list.innerHTML = '';
  $('#characters-count').textContent = state.characters.items.length
    ? `${state.characters.items.length} saved`
    : '';

  if (!state.characters.items.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = state.characters.loading
      ? 'Loading characters…'
      : 'No characters yet. Create one to generate a portrait or a character sheet.';
    list.appendChild(hint);
  }

  state.characters.items.forEach((character) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'maker-character' + (character.id === state.characters.selectedId ? ' active' : '');
    const name = document.createElement('strong');
    name.textContent = character.name;
    const meta = document.createElement('span');
    meta.className = 'hint';
    const final = (character.versions || []).find((version) => version.status === 'final');
    meta.textContent = character.versionCount
      ? `${character.versionCount} version${character.versionCount === 1 ? '' : 's'}${final ? ` · final: ${final.mode === 'sheet' ? 'sheet' : 'portrait'}` : ' · no final yet'}`
      : 'No images yet';
    button.append(name, meta);
    button.addEventListener('click', () => {
      state.characters.selectedId = character.id;
      renderCharacters();
    });
    list.appendChild(button);
  });

  renderCharacterEditor();
}

function renderCharacterEditor() {
  const character = selectedCharacter();
  const empty = $('#character-empty');
  const fields = $('#character-fields');
  const remove = $('#character-delete');

  if (!character) {
    $('#character-editor-title').textContent = 'Character';
    empty.classList.remove('hidden');
    fields.classList.add('hidden');
    remove.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  fields.classList.remove('hidden');
  remove.classList.remove('hidden');
  $('#character-editor-title').textContent = character.name || 'Character';

  // Only write into the inputs when the selection changes, so typing is not
  // interrupted by a re-render.
  if (state.characters.formFor !== character.id) {
    state.characters.formFor = character.id;
    $('#character-name').value = character.name || '';
    $('#character-description').value = character.description || '';
  }

  const hasKey = hasImageApiKey();
  $('#character-generate').disabled = state.characters.generating || !hasKey;
  $('#character-save').disabled = state.characters.saving || state.characters.generating;
  remove.disabled = state.characters.generating;
  $('#character-hint').textContent = state.characters.generating
    ? 'Generating…'
    : !hasKey
      ? `Save your ${imageProviderLabel()} API key in Settings to generate images.`
      : character.description.trim()
        ? 'The description drives the image. Generate again to add another version.'
        : 'Describe this character, then generate an image.';

  renderCharacterVersions(character);
}

// Shared by the Character maker and the Project characters tabs.
function characterVersionCard(character, version, options = {}) {
  const card = document.createElement('div');
  card.className = 'story-sheet-version';

  const head = document.createElement('div');
  head.className = 'story-prompt-head';
  const label = document.createElement('strong');
  label.textContent = `Version ${version.version} · ${version.mode === 'sheet' ? 'Character sheet' : 'Portrait'}`;
  const status = document.createElement('span');
  status.className = `story-badge ${version.status === 'final' ? 'approved' : 'draft'}`;
  status.textContent = version.status === 'final' ? 'Final' : 'Draft';
  const meta = document.createElement('span');
  meta.className = 'story-ref-meta';
  meta.textContent = [version.imageModel, version.imageSize].filter(Boolean).join(' · ');
  head.append(label, status, meta);

  const img = document.createElement('img');
  img.className = 'story-sheet-image';
  img.src = version.url;
  img.alt = `${character.name} version ${version.version}`;
  img.loading = 'lazy';

  const actions = document.createElement('div');
  actions.className = 'story-form-actions';
  if (version.status !== 'final') {
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'btn btn-secondary btn-sm';
    promote.textContent = 'Make final';
    promote.disabled = Boolean(options.disabled);
    promote.addEventListener('click', () => options.onPromote(version.id));
    actions.appendChild(promote);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-secondary btn-sm';
  copy.textContent = 'Copy prompt';
  copy.addEventListener('click', () => copyToClipboard(version.prompt, 'Prompt'));
  actions.appendChild(copy);

  card.append(head, img, actions);
  return card;
}

function renderCharacterVersions(character) {
  const container = $('#character-versions');
  container.innerHTML = '';
  const versions = [...(character.versions || [])].sort((a, b) => b.version - a.version);
  if (!versions.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No images yet.';
    container.appendChild(hint);
    return;
  }

  versions.forEach((version) => {
    container.appendChild(characterVersionCard(character, version, {
      disabled: state.characters.generating,
      onPromote: () => promoteCharacterVersion(version.id),
    }));
  });
}

async function createCharacter() {
  if (state.characters.saving) return;
  state.characters.saving = true;
  try {
    const data = await api('/api/characters', {
      method: 'POST',
      body: { name: 'New character', description: '' },
    });
    upsertCharacter(data.character);
    state.characters.selectedId = data.character.id;
    state.characters.formFor = '';
    state.characters.loaded = true;
    toast('Character created. Name it and describe it, then generate.', 'success');
  } catch (err) {
    toast(err.message || 'Could not create the character.', 'error');
  } finally {
    state.characters.saving = false;
    renderCharacters();
    const name = $('#character-name');
    if (name && !$('#character-fields').classList.contains('hidden')) {
      name.focus();
      name.select();
    }
  }
}

async function saveCharacter() {
  const character = selectedCharacter();
  if (!character || state.characters.saving) return;
  const name = $('#character-name').value.trim();
  const description = $('#character-description').value.trim();
  if (!name) return toast('Enter a character name.', 'error');
  state.characters.saving = true;
  try {
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}`, {
      method: 'PUT',
      body: { name, description },
    });
    upsertCharacter(data.character);
    toast('Character saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the character.', 'error');
  } finally {
    state.characters.saving = false;
    renderCharacters();
  }
}

async function generateCharacterImage() {
  const character = selectedCharacter();
  if (!character || state.characters.generating) return;
  const mode = $('#character-mode').value === 'sheet' ? 'sheet' : 'portrait';
  const size = $('#character-size').value;
  const description = $('#character-description').value.trim();
  if (!description) return toast('Describe this character before generating.', 'error');

  state.characters.generating = true;
  const processId = startProcess(mode === 'sheet' ? 'Generating character sheet' : 'Generating character portrait');
  renderCharacters();
  try {
    // Keep the current text even if the user does not press Save first.
    if (description !== (character.description || '')) {
      const saved = await api(`/api/characters/${encodeURIComponent(character.id)}`, {
        method: 'PUT',
        body: { name: $('#character-name').value.trim() || character.name, description },
      });
      upsertCharacter(saved.character);
    }
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}/generate`, {
      method: 'POST',
      body: { mode, size },
    });
    upsertCharacter(data.character);
    toast(mode === 'sheet' ? 'Character sheet generated. Add another or make it final.' : 'Portrait generated. Add another or make it final.', 'success');
  } catch (err) {
    handleMissingImageKey(err);
    toast(err.message || 'Could not generate the character image.', 'error');
  } finally {
    finishProcess(processId);
    state.characters.generating = false;
    renderCharacters();
  }
}

async function promoteCharacterVersion(versionId) {
  const character = selectedCharacter();
  if (!character) return;
  try {
    const data = await api(
      `/api/characters/${encodeURIComponent(character.id)}/versions/${encodeURIComponent(versionId)}/promote`,
      { method: 'POST' }
    );
    upsertCharacter(data.character);
    toast('Version marked final.', 'success');
  } catch (err) {
    toast(err.message || 'Could not mark the version final.', 'error');
  } finally {
    renderCharacters();
  }
}

async function deleteCharacter() {
  const character = selectedCharacter();
  if (!character) return;
  if (!confirm(`Delete "${character.name}" and all of its generated images?`)) return;
  try {
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}`, { method: 'DELETE' });
    state.characters.items = Array.isArray(data.characters) ? data.characters : [];
    state.characters.selectedId = state.characters.items.length ? state.characters.items[0].id : '';
    state.characters.formFor = '';
    toast('Character deleted.', 'success');
  } catch (err) {
    toast(err.message || 'Could not delete the character.', 'error');
  } finally {
    renderCharacters();
  }
}

$('#character-new').addEventListener('click', createCharacter);
$('#character-save').addEventListener('click', saveCharacter);
$('#character-generate').addEventListener('click', generateCharacterImage);
$('#character-delete').addEventListener('click', deleteCharacter);
$('#characters-retry').addEventListener('click', () => loadCharacters({ force: true }));

// ---------------------------------------------------------------------------
// Project characters
//
// The same builder, scoped to one project. Characters created here carry that
// project's id, so the Character maker tab never lists them, and the project
// list never shows standalone characters.
// ---------------------------------------------------------------------------
let projectCharacterOptionsSignature = '';

function resetProjectCharacters() {
  state.projectCharacters.projectId = '';
  state.projectCharacters.loadedFor = '';
  state.projectCharacters.loading = false;
  state.projectCharacters.error = '';
  state.projectCharacters.items = [];
  state.projectCharacters.selectedId = '';
  state.projectCharacters.formFor = '';
  state.projectCharacters.saving = false;
  state.projectCharacters.generating = false;
  state.projectCharacters.makers = [];
  projectCharacterOptionsSignature = '';
}

function projectCharacterProjects() {
  return state.projects
    .filter((project) => project.status !== 'Done')
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function selectedProjectCharacter() {
  return state.projectCharacters.items.find((item) => item.id === state.projectCharacters.selectedId) || null;
}

function upsertProjectCharacter(character) {
  if (!character) return;
  const index = state.projectCharacters.items.findIndex((item) => item.id === character.id);
  if (index === -1) state.projectCharacters.items.unshift(character);
  else state.projectCharacters.items[index] = character;
}

function renderProjectCharacterProjects() {
  const select = $('#project-characters-project');
  if (!select) return;
  const projects = projectCharacterProjects();
  const signature = projects.map((project) => project.id).join(',');
  if (signature !== projectCharacterOptionsSignature) {
    projectCharacterOptionsSignature = signature;
    select.innerHTML = '';
    if (!projects.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No active projects';
      select.appendChild(option);
    }
    projects.forEach((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = `${project.title} · ${project.stage || 'Idea Stage'}`;
      select.appendChild(option);
    });
  }
  if (!projects.some((project) => project.id === state.projectCharacters.projectId)) {
    state.projectCharacters.projectId = projects.length ? projects[0].id : '';
  }
  select.value = state.projectCharacters.projectId;
}

async function loadProjectCharacters(options = {}) {
  if (!state.user || state.projectCharacters.loading) return;
  renderProjectCharacterProjects();
  const projectId = state.projectCharacters.projectId;
  if (!projectId) {
    state.projectCharacters.items = [];
    state.projectCharacters.selectedId = '';
    renderProjectCharacters();
    return;
  }
  if (state.projectCharacters.loadedFor === projectId && !options.force) {
    renderProjectCharacters();
    return;
  }

  state.projectCharacters.loading = true;
  state.projectCharacters.error = '';
  renderProjectCharacters();
  applyImageSizeOptions(currentImageModel(), '#project-character-size');
  try {
    const [scoped, makers] = await Promise.all([
      api(`/api/characters?projectId=${encodeURIComponent(projectId)}`),
      api('/api/characters'),
    ]);
    state.projectCharacters.items = Array.isArray(scoped.characters) ? scoped.characters : [];
    state.projectCharacters.makers = Array.isArray(makers.characters) ? makers.characters : [];
    state.projectCharacters.loadedFor = projectId;
    if (!selectedProjectCharacter()) {
      state.projectCharacters.selectedId = state.projectCharacters.items.length
        ? state.projectCharacters.items[0].id
        : '';
    }
  } catch (err) {
    if (err.status !== 401) state.projectCharacters.error = err.message || 'Could not load project characters.';
  } finally {
    state.projectCharacters.loading = false;
    renderProjectCharacters();
  }
}

function renderProjectCharacters() {
  const panel = $('#panel-project-characters');
  if (!panel) return;

  const error = $('#project-characters-error');
  error.classList.toggle('hidden', !state.projectCharacters.error);
  if (state.projectCharacters.error) {
    $('#project-characters-error-text').textContent = state.projectCharacters.error;
  }

  const list = $('#project-character-list');
  list.innerHTML = '';
  $('#project-characters-count').textContent = state.projectCharacters.items.length
    ? `${state.projectCharacters.items.length} saved`
    : '';

  if (!state.projectCharacters.projectId) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No active projects. Create or reopen a project first.';
    list.appendChild(hint);
  } else if (!state.projectCharacters.items.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = state.projectCharacters.loading
      ? 'Loading characters…'
      : 'No characters in this project yet. Create one, or copy a final image from the Character maker.';
    list.appendChild(hint);
  }

  state.projectCharacters.items.forEach((character) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'maker-character'
      + (character.id === state.projectCharacters.selectedId ? ' active' : '');
    const name = document.createElement('strong');
    name.textContent = character.name;
    const meta = document.createElement('span');
    meta.className = 'hint';
    const final = (character.versions || []).find((version) => version.status === 'final');
    meta.textContent = character.versionCount
      ? `${character.versionCount} version${character.versionCount === 1 ? '' : 's'}${final ? ` · final: ${final.mode === 'sheet' ? 'sheet' : 'portrait'}` : ' · no final yet'}`
      : 'No images yet';
    button.append(name, meta);
    button.addEventListener('click', () => {
      state.projectCharacters.selectedId = character.id;
      renderProjectCharacters();
    });
    list.appendChild(button);
  });

  renderProjectCharacterEditor();
}

function renderProjectCharacterReuse() {
  const select = $('#project-character-reuse');
  const importButton = $('#project-character-import');
  const candidates = [];
  state.projectCharacters.makers.forEach((character) => {
    const final = (character.versions || []).find((version) => version.status === 'final');
    if (final) candidates.push({ character, version: final });
  });

  const previous = select.value;
  select.innerHTML = '';
  if (!candidates.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No final Character maker images yet';
    select.appendChild(option);
  }
  candidates.forEach(({ character, version }) => {
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `${character.name} · version ${version.version} (${version.mode === 'sheet' ? 'sheet' : 'portrait'})`;
    select.appendChild(option);
  });
  const keep = candidates.some((item) => item.version.id === previous) ? previous : '';
  select.value = keep || (candidates.length ? candidates[0].version.id : '');
  importButton.disabled = !candidates.length || state.projectCharacters.generating;
}

function renderProjectCharacterEditor() {
  const character = selectedProjectCharacter();
  const empty = $('#project-character-empty');
  const fields = $('#project-character-fields');
  const remove = $('#project-character-delete');

  if (!character) {
    $('#project-character-editor-title').textContent = 'Character';
    empty.classList.remove('hidden');
    fields.classList.add('hidden');
    remove.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  fields.classList.remove('hidden');
  remove.classList.remove('hidden');
  $('#project-character-editor-title').textContent = character.name || 'Character';

  if (state.projectCharacters.formFor !== character.id) {
    state.projectCharacters.formFor = character.id;
    $('#project-character-name').value = character.name || '';
    $('#project-character-description').value = character.description || '';
  }

  const hasKey = hasImageApiKey();
  const busy = state.projectCharacters.generating;
  $('#project-character-generate').disabled = busy || !hasKey;
  $('#project-character-save').disabled = busy || state.projectCharacters.saving;
  remove.disabled = busy;
  $('#project-character-hint').textContent = busy
    ? 'Generating…'
    : !hasKey
      ? `Save your ${imageProviderLabel()} API key in Settings to generate images.`
      : character.description.trim()
        ? 'The description drives the image. Generate again to add another version.'
        : 'Describe this character, then generate an image.';
  $('#project-character-versions').innerHTML = '';
  const versions = [...(character.versions || [])].sort((a, b) => b.version - a.version);
  if (!versions.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No images yet. Generate one, or copy a final image from the Character maker.';
    $('#project-character-versions').appendChild(hint);
  }
  versions.forEach((version) => {
    $('#project-character-versions').appendChild(characterVersionCard(character, version, {
      disabled: busy,
      onPromote: () => promoteProjectCharacterVersion(version.id),
    }));
  });

  renderProjectCharacterReuse();
}

async function createProjectCharacter() {
  const projectId = state.projectCharacters.projectId;
  if (!projectId) return toast('Choose a project first.', 'error');
  if (state.projectCharacters.saving) return;
  state.projectCharacters.saving = true;
  try {
    const data = await api('/api/characters', {
      method: 'POST',
      body: { projectId, name: 'New character', description: '' },
    });
    upsertProjectCharacter(data.character);
    state.projectCharacters.selectedId = data.character.id;
    state.projectCharacters.formFor = '';
    toast('Character added to this project. Name it and describe it, then generate.', 'success');
  } catch (err) {
    toast(err.message || 'Could not create the character.', 'error');
  } finally {
    state.projectCharacters.saving = false;
    renderProjectCharacters();
    const name = $('#project-character-name');
    if (name && !$('#project-character-fields').classList.contains('hidden')) {
      name.focus();
      name.select();
    }
  }
}

async function saveProjectCharacter() {
  const character = selectedProjectCharacter();
  if (!character || state.projectCharacters.saving) return;
  const name = $('#project-character-name').value.trim();
  const description = $('#project-character-description').value.trim();
  if (!name) return toast('Enter a character name.', 'error');
  state.projectCharacters.saving = true;
  try {
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}`, {
      method: 'PUT',
      body: { name, description },
    });
    upsertProjectCharacter(data.character);
    toast('Character saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the character.', 'error');
  } finally {
    state.projectCharacters.saving = false;
    renderProjectCharacters();
  }
}

async function generateProjectCharacterImage() {
  const character = selectedProjectCharacter();
  if (!character || state.projectCharacters.generating) return;
  const mode = $('#project-character-mode').value === 'sheet' ? 'sheet' : 'portrait';
  const size = $('#project-character-size').value;
  const description = $('#project-character-description').value.trim();
  if (!description) return toast('Describe this character before generating.', 'error');

  state.projectCharacters.generating = true;
  const processId = startProcess(mode === 'sheet' ? 'Generating character sheet' : 'Generating character portrait');
  renderProjectCharacters();
  try {
    if (description !== (character.description || '')) {
      const saved = await api(`/api/characters/${encodeURIComponent(character.id)}`, {
        method: 'PUT',
        body: {
          name: $('#project-character-name').value.trim() || character.name,
          description,
        },
      });
      upsertProjectCharacter(saved.character);
    }
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}/generate`, {
      method: 'POST',
      body: { mode, size },
    });
    upsertProjectCharacter(data.character);
    toast(mode === 'sheet' ? 'Character sheet generated.' : 'Portrait generated.', 'success');
  } catch (err) {
    handleMissingImageKey(err);
    toast(err.message || 'Could not generate the character image.', 'error');
  } finally {
    finishProcess(processId);
    state.projectCharacters.generating = false;
    renderProjectCharacters();
  }
}

async function promoteProjectCharacterVersion(versionId) {
  const character = selectedProjectCharacter();
  if (!character) return;
  try {
    const data = await api(
      `/api/characters/${encodeURIComponent(character.id)}/versions/${encodeURIComponent(versionId)}/promote`,
      { method: 'POST' }
    );
    upsertProjectCharacter(data.character);
    toast('Version marked final.', 'success');
  } catch (err) {
    toast(err.message || 'Could not mark the version final.', 'error');
  } finally {
    renderProjectCharacters();
  }
}

async function importMakerVersion() {
  const character = selectedProjectCharacter();
  const fromVersionId = $('#project-character-reuse').value;
  if (!character) return;
  if (!fromVersionId) return toast('No final Character maker image is available to copy.', 'error');
  const processId = startProcess('Copying the final image into this project');
  state.projectCharacters.generating = true;
  renderProjectCharacters();
  try {
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}/versions/import`, {
      method: 'POST',
      body: { fromVersionId },
    });
    upsertProjectCharacter(data.character);
    toast('Final image copied into this project character.', 'success');
  } catch (err) {
    toast(err.message || 'Could not copy the image.', 'error');
  } finally {
    finishProcess(processId);
    state.projectCharacters.generating = false;
    renderProjectCharacters();
  }
}

async function deleteProjectCharacter() {
  const character = selectedProjectCharacter();
  if (!character) return;
  if (!confirm(`Delete "${character.name}" and all of its generated images from this project?`)) return;
  try {
    const data = await api(`/api/characters/${encodeURIComponent(character.id)}`, { method: 'DELETE' });
    state.projectCharacters.items = Array.isArray(data.characters) ? data.characters : [];
    state.projectCharacters.selectedId = state.projectCharacters.items.length
      ? state.projectCharacters.items[0].id
      : '';
    state.projectCharacters.formFor = '';
    toast('Character deleted.', 'success');
  } catch (err) {
    toast(err.message || 'Could not delete the character.', 'error');
  } finally {
    renderProjectCharacters();
  }
}

$('#project-characters-project').addEventListener('change', (event) => {
  state.projectCharacters.projectId = event.target.value;
  state.projectCharacters.selectedId = '';
  state.projectCharacters.formFor = '';
  state.projectCharacters.items = [];
  loadProjectCharacters({ force: true });
});
$('#project-character-new').addEventListener('click', createProjectCharacter);
$('#project-character-save').addEventListener('click', saveProjectCharacter);
$('#project-character-generate').addEventListener('click', generateProjectCharacterImage);
$('#project-character-import').addEventListener('click', importMakerVersion);
$('#project-character-delete').addEventListener('click', deleteProjectCharacter);
$('#project-characters-retry').addEventListener('click', () => loadProjectCharacters({ force: true }));

// ---------------------------------------------------------------------------
// Standalone image generator
//
// Prompt-to-image with no project. Each generated image is also added to the
// Library as an unassigned asset (the server does that), so this tab is a
// workspace and the Library stays the place where images are reviewed.
// ---------------------------------------------------------------------------
function resetGenerator() {
  state.generator.savingModel = false;
  state.generator.uploadToken += 1;
  state.generator.runToken += 1;
  state.generator.mode = 'single';
  state.generator.layout = 'grid-2x2';
  state.generator.panels = ['', '', '', ''];
  state.generator.uploading = false;
  $('#generator-prompt').value = '';
  $('#generator-panels').dataset.layout = '';
  state.generator.loaded = false;
  state.generator.loading = false;
  state.generator.error = '';
  state.generator.generations = [];
  state.generator.presets = [];
  state.generator.uploads = [];
  state.generator.libraryImages = [];
  state.generator.characterSources = [];
  state.generator.references = [];
  state.generator.selectedPresetId = '';
  state.generator.generating = false;
}

async function loadGenerator(options = {}) {
  if (!state.user || state.generator.loading) return;
  if (state.generator.loaded && !options.force) {
    renderGenerator();
    return;
  }

  state.generator.loading = true;
  state.generator.error = '';
  renderGenerator();
  try {
    const [data, library] = await Promise.all([
      api('/api/generations'),
      api('/api/library').catch(() => ({ images: [] })),
    ]);
    state.generator.generations = Array.isArray(data.generations) ? data.generations : [];
    state.generator.presets = Array.isArray(data.presets) ? data.presets : [];
    state.generator.uploads = Array.isArray(data.references) ? data.references : [];
    if (data.limits && Number.isFinite(data.limits.maxReferences)) {
      state.generator.maxReferences = data.limits.maxReferences;
    }
    state.generator.libraryImages = Array.isArray(library.images) ? library.images : [];
    // Only characters that already have a final image can be referenced.
    const characters = await api('/api/characters').catch(() => ({ characters: [] }));
    state.generator.characterSources = [];
    (characters.characters || []).forEach((character) => {
      const final = (character.versions || []).find((version) => version.status === 'final');
      if (final) state.generator.characterSources.push({ character, version: final });
    });
    state.generator.loaded = true;
  } catch (err) {
    if (err.status !== 401) state.generator.error = err.message || 'Could not load the generator.';
  } finally {
    state.generator.loading = false;
    renderGenerator();
  }
}

function generatorHint() {
  if (!hasImageApiKey()) {
    return `Save your ${imageProviderLabel()} API key in Settings to generate images.`;
  }
  if (state.generator.generating) return 'Generating…';
  if (state.generator.uploading) return 'Uploading reference photos…';
  if (state.generator.mode === 'panels') return 'Each variation is one combined image containing all panel prompts. Your references guide every panel.';
  return 'Every image you generate is saved here and added to the Library as an unassigned asset.';
}

function renderGeneratorPresets() {
  const select = $('#generator-preset');
  const previous = state.generator.selectedPresetId || select.value;
  select.innerHTML = '';
  if (!state.generator.presets.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No presets saved yet';
    select.appendChild(option);
  }
  state.generator.presets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  });
  const keep = state.generator.presets.some((preset) => preset.id === previous) ? previous : '';
  select.value = keep || (state.generator.presets.length ? state.generator.presets[0].id : '');
  state.generator.selectedPresetId = select.value;
  $('#generator-preset-insert').disabled = !select.value;
  $('#generator-preset-delete').disabled = !select.value;
}

function renderGeneratorReferenceSources() {
  const librarySelect = $('#generator-reference-library');
  const previousLibrary = librarySelect.value;
  librarySelect.innerHTML = '';
  if (!state.generator.libraryImages.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No Library images yet';
    librarySelect.appendChild(option);
  }
  state.generator.libraryImages.forEach((image) => {
    const option = document.createElement('option');
    option.value = image.relativePath;
    option.textContent = `${image.name}${image.metadata && image.metadata.projectTitle ? ` · ${image.metadata.projectTitle}` : ' · unassigned'}`;
    librarySelect.appendChild(option);
  });
  if (state.generator.libraryImages.some((image) => image.relativePath === previousLibrary)) {
    librarySelect.value = previousLibrary;
  }
  $('#generator-reference-add-library').disabled = !librarySelect.value || state.generator.generating || state.generator.uploading
    || state.generator.references.length >= state.generator.maxReferences;

  const characterSelect = $('#generator-reference-character');
  const previousCharacter = characterSelect.value;
  characterSelect.innerHTML = '';
  if (!state.generator.characterSources.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No final Character maker images';
    characterSelect.appendChild(option);
  }
  state.generator.characterSources.forEach(({ character, version }) => {
    const option = document.createElement('option');
    option.value = `${character.id}|${version.file}`;
    option.textContent = `${character.name} · version ${version.version} (${version.mode === 'sheet' ? 'sheet' : 'portrait'})`;
    characterSelect.appendChild(option);
  });
  if (state.generator.characterSources.some(({ character, version }) => `${character.id}|${version.file}` === previousCharacter)) {
    characterSelect.value = previousCharacter;
  }
  $('#generator-reference-add-character').disabled = !characterSelect.value || state.generator.generating || state.generator.uploading
    || state.generator.references.length >= state.generator.maxReferences;
}

function renderGeneratorReferences() {
  const container = $('#generator-reference-chips');
  container.innerHTML = '';
  const used = state.generator.references.length;
  $('#generator-reference-count').textContent = used
    ? `${used} of ${state.generator.maxReferences} attached`
    : '';

  state.generator.references.forEach((reference, index) => {
    const chip = document.createElement('div');
    chip.className = 'generator-chip';
    const thumb = document.createElement('img');
    thumb.src = reference.url;
    thumb.alt = reference.name;
    const label = document.createElement('span');
    label.textContent = reference.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary btn-sm';
    remove.textContent = '✕';
    remove.title = 'Remove this reference';
    remove.setAttribute('aria-label', `Remove ${reference.name}`);
    remove.disabled = state.generator.generating || state.generator.uploading;
    remove.addEventListener('click', () => {
      state.generator.references.splice(index, 1);
      renderGenerator();
    });
    chip.append(thumb, label, remove);
    container.appendChild(chip);
  });

  renderGeneratorReferenceSources();
}

function renderGeneratorGallery() {
  const gallery = $('#generator-gallery');
  gallery.innerHTML = '';
  const total = state.generator.generations.length;
  $('#generator-gallery-count').textContent = total ? `${total} saved` : '';

  if (!total) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = state.generator.loading
      ? 'Loading…'
      : 'Nothing generated yet. Write a prompt and click ✨ Generate.';
    gallery.appendChild(hint);
    return;
  }

  state.generator.generations.forEach((generation) => {
    const card = document.createElement('div');
    card.className = 'generator-card';

    const img = document.createElement('img');
    img.className = 'generator-image';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = generation.url;
    img.alt = generation.prompt.slice(0, 120);
    img.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'story-ref-meta';
    const when = generation.createdAt ? new Date(generation.createdAt).toLocaleString() : '';
    meta.textContent = [generation.imageSize, generation.imageModel, when].filter(Boolean).join(' · ');

    const prompt = document.createElement('p');
    prompt.className = 'generator-prompt-text';
    prompt.textContent = generation.composition
      ? generation.composition.panels.map((text, index) => `${index + 1}. ${text}`).join('\n')
      : generation.prompt;
    prompt.title = generation.prompt;

    if (generation.references && generation.references.length) {
      const refs = document.createElement('p');
      refs.className = 'hint';
      refs.textContent = `References: ${generation.references.map((item) => item.name || item.kind).join(', ')}`;
      card.append(img, meta, prompt, refs);
    } else {
      card.append(img, meta, prompt);
    }

    const actions = document.createElement('div');
    actions.className = 'story-form-actions';

    const download = document.createElement('a');
    download.className = 'btn btn-secondary btn-sm';
    download.textContent = '⬇ Download';
    download.href = generation.url;
    download.download = `carnival-${generation.id.slice(0, 8)}.png`;
    actions.appendChild(download);

    const library = document.createElement('button');
    library.type = 'button';
    library.className = 'btn btn-secondary btn-sm';
    library.textContent = '🔎 Library';
    library.title = 'Open this image in the Library';
    library.disabled = !generation.assetId;
    library.addEventListener('click', () => openGenerationInLibrary(generation));
    actions.appendChild(library);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary btn-sm';
    copy.textContent = 'Copy prompt';
    copy.addEventListener('click', () => copyToClipboard(generation.prompt, 'Prompt'));
    actions.appendChild(copy);

    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.className = 'btn btn-secondary btn-sm';
    reuse.textContent = 'Use prompts';
    reuse.disabled = state.generator.generating || state.generator.uploading;
    reuse.addEventListener('click', () => {
      const composition = generation.composition;
      state.generator.mode = composition ? 'panels' : 'single';
      state.generator.layout = composition ? composition.layout : 'grid-2x2';
      state.generator.panels = composition ? [...composition.panels] : ['', '', '', ''];
      $('#generator-prompt').value = composition ? composition.sharedPrompt : generation.prompt;
      $('#generator-panels').dataset.layout = '';
      renderGenerator();
      $('.generator-editor').scrollIntoView({ block: 'start' });
    });
    actions.appendChild(reuse);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary btn-sm';
    remove.textContent = '🗑 Delete';
    remove.disabled = state.generator.generating;
    remove.addEventListener('click', () => deleteGeneration(generation));
    actions.appendChild(remove);

    card.appendChild(actions);
    gallery.appendChild(card);
  });
}

function generatorPanelPositions() {
  return state.generator.layout === 'side-by-side' ? ['Left', 'Right']
    : state.generator.layout === 'stacked' ? ['Top', 'Bottom']
      : ['Top left', 'Top right', 'Bottom left', 'Bottom right'];
}

function renderGeneratorComposition() {
  const multiple = state.generator.mode === 'panels';
  const busy = state.generator.generating || state.generator.uploading || state.generator.savingModel;
  document.querySelectorAll('[data-generator-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.generatorMode === state.generator.mode));
    button.disabled = busy;
  });
  $('#generator-layout-row').classList.toggle('hidden', !multiple);
  $('#generator-panel-fields').classList.toggle('hidden', !multiple);
  $('#generator-layout').value = state.generator.layout;
  $('#generator-layout').disabled = busy;
  $('#generator-prompt-label').textContent = multiple ? 'Shared instructions (optional)' : 'Prompt';
  $('#generator-prompt').placeholder = multiple
    ? 'Describe the characters, visual style, lighting, or details shared by every panel.'
    : 'Describe the image: subject, setting, lighting, lens, mood, and style.';
  $('#generator-prompt').rows = multiple ? 3 : 8;
  $('#generator-prompt').disabled = busy;
  const container = $('#generator-panels');
  if (container.dataset.layout !== state.generator.layout) {
    container.innerHTML = '';
    const preview = $('#generator-layout-preview');
    preview.innerHTML = '';
    preview.className = `composition-preview layout-${state.generator.layout}`;
    generatorPanelPositions().forEach((position, index) => {
      const label = document.createElement('label');
      label.className = 'field';
      const heading = document.createElement('span');
      heading.className = 'field-label';
      heading.textContent = `Panel ${index + 1} · ${position}`;
      const input = document.createElement('textarea');
      input.id = `generator-panel-${index + 1}`;
      input.rows = 4;
      input.maxLength = 6000;
      input.placeholder = 'Describe the scene, action, and framing for this panel.';
      input.value = state.generator.panels[index] || '';
      input.addEventListener('input', () => { state.generator.panels[index] = input.value; });
      label.append(heading, input);
      container.appendChild(label);
      const cell = document.createElement('span');
      cell.textContent = String(index + 1);
      cell.title = position;
      preview.appendChild(cell);
    });
    container.dataset.layout = state.generator.layout;
  }
  container.querySelectorAll('textarea').forEach((input) => { input.disabled = busy; });
}

function renderGenerator() {
  const panel = $('#panel-standalone-images');
  if (!panel) return;

  const error = $('#generator-error');
  error.classList.toggle('hidden', !state.generator.error);
  if (state.generator.error) $('#generator-error-text').textContent = state.generator.error;

  applyImageSizeOptions(currentImageModel(), '#generator-size');
  applyImageModelOptions('#generator-model');

  const busy = state.generator.generating || state.generator.uploading || state.generator.savingModel;
  $('#generator-model').disabled = busy;
  $('#generator-generate').disabled = busy || !hasImageApiKey();
  $('#generator-count').disabled = busy;
  $('#generator-preset-save').disabled = busy;
  $('#generator-reference-upload').disabled = busy || state.generator.references.length >= state.generator.maxReferences;
  $('#generator-size').disabled = busy;
  $('#generator-reference-file').disabled = busy;
  $('#generator-reference-upload').textContent = state.generator.uploading ? 'Uploading photos…' : 'Add reference photos';
  $('#generator-upload-status').textContent = state.generator.uploading
    ? 'Please wait while your photos are uploaded.' : 'Choose one or several photos from your device.';
  $('#generator-hint').textContent = generatorHint();
  renderGeneratorComposition();

  renderGeneratorPresets();
  renderGeneratorReferences();
  renderGeneratorGallery();
}

function generatorReferencePayload() {
  return state.generator.references.map((reference) => {
    if (reference.kind === 'library') return { kind: 'library', path: reference.path };
    if (reference.kind === 'character') {
      return { kind: 'character', characterId: reference.characterId, file: reference.file };
    }
    return { kind: 'upload', id: reference.id };
  });
}

function addLibraryReference() {
  const select = $('#generator-reference-library');
  const relativePath = select.value;
  if (!relativePath) return;
  if (state.generator.references.length >= state.generator.maxReferences) {
    return toast(`You can attach up to ${state.generator.maxReferences} reference images.`, 'error');
  }
  if (state.generator.references.some((item) => item.kind === 'library' && item.path === relativePath)) {
    return toast('That image is already attached.', 'error');
  }
  const image = state.generator.libraryImages.find((item) => item.relativePath === relativePath);
  state.generator.references.push({
    kind: 'library',
    path: relativePath,
    name: (image && image.name) || relativePath.split('/').pop(),
    url: (image && image.url) || `/api/library/file?path=${encodeURIComponent(relativePath)}`,
  });
  renderGenerator();
}

function addCharacterReference() {
  const value = $('#generator-reference-character').value;
  if (!value) return;
  if (state.generator.references.length >= state.generator.maxReferences) {
    return toast(`You can attach up to ${state.generator.maxReferences} reference images.`, 'error');
  }
  const [characterId, file] = value.split('|');
  if (state.generator.references.some((item) => item.kind === 'character' && item.file === file)) {
    return toast('That character image is already attached.', 'error');
  }
  const source = state.generator.characterSources.find(
    (item) => item.character.id === characterId && item.version.file === file
  );
  state.generator.references.push({
    kind: 'character',
    characterId,
    file,
    name: source ? `${source.character.name} (${source.version.mode === 'sheet' ? 'sheet' : 'portrait'})` : 'Character',
    url: `/api/characters/${encodeURIComponent(characterId)}/image/${encodeURIComponent(file)}`,
  });
  renderGenerator();
}

async function uploadGeneratorReference() {
  const input = $('#generator-reference-file');
  if (state.generator.generating || state.generator.uploading || state.generator.savingModel) return;
  const files = Array.from(input.files || []);
  if (!files.length) return input.click();
  const remaining = state.generator.maxReferences - state.generator.references.length;
  if (files.length > remaining) {
    input.value = '';
    return toast(`You can attach ${remaining} more reference photo${remaining === 1 ? '' : 's'}.`, 'error');
  }
  const invalid = files.find((file) => file.size > 20 * 1024 * 1024
    || !(/^(image\/(png|jpeg|webp))$/.test(file.type) || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name))));
  if (invalid) {
    input.value = '';
    return toast(`${invalid.name}: choose a PNG, JPEG, or WebP photo under 20 MB.`, 'error');
  }
  state.generator.uploading = true;
  const uploadToken = ++state.generator.uploadToken;
  const userId = state.user && state.user.id;
  renderGenerator();
  const processId = startProcess('Uploading reference photos');
  let attached = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (state.generator.uploadToken !== uploadToken || !state.user || state.user.id !== userId) break;
      updateProcess(processId, `Uploading photo ${index + 1} of ${files.length}`);
      try {
        const response = await fetch(`/api/generation-references?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        let data;
        try { data = await response.json(); } catch (_) { data = null; }
        if (state.generator.uploadToken !== uploadToken || !state.user || state.user.id !== userId) break;
        if (!response.ok || !data || !data.reference) throw new Error((data && data.error) || `Upload failed (${response.status}).`);
        state.generator.uploads.unshift(data.reference);
        state.generator.references.push({ kind: 'upload', id: data.reference.id, name: data.reference.name, url: data.reference.url });
        attached += 1;
        renderGeneratorReferences();
      } catch (err) {
        if (state.generator.uploadToken === uploadToken && state.user && state.user.id === userId) {
          toast(`${file.name}: ${err.message || 'Could not upload this reference photo.'}`, 'error');
        }
      }
    }
    if (state.generator.uploadToken === uploadToken) input.value = '';
  } finally {
    finishProcess(processId);
    if (state.generator.uploadToken === uploadToken) {
      state.generator.uploading = false;
      renderGenerator();
    }
  }
  if (attached && state.generator.uploadToken === uploadToken) toast(`${attached} reference photo${attached === 1 ? '' : 's'} attached.`, 'success');
}

function insertGeneratorPreset() {
  const preset = state.generator.presets.find((item) => item.id === $('#generator-preset').value);
  if (!preset) return;
  const prompt = $('#generator-prompt');
  const current = prompt.value.trim();
  prompt.value = current ? `${current}\n${preset.text}` : preset.text;
  prompt.focus();
  toast(`Inserted “${preset.name}”.`, 'success');
}

async function saveGeneratorPreset() {
  const text = $('#generator-prompt').value.trim();
  if (!text) return toast('Write a prompt before saving a preset.', 'error');
  const suggested = text.split('\n')[0].slice(0, 60);
  const name = window.prompt('Name this preset', suggested);
  if (name === null) return;
  const trimmed = name.trim() || suggested;
  try {
    const data = await api('/api/generation-presets', { method: 'POST', body: { name: trimmed, text } });
    state.generator.presets.unshift(data.preset);
    state.generator.selectedPresetId = data.preset.id;
    toast('Preset saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the preset.', 'error');
  } finally {
    renderGenerator();
  }
}

async function deleteGeneratorPreset() {
  const preset = state.generator.presets.find((item) => item.id === $('#generator-preset').value);
  if (!preset) return;
  if (!confirm(`Delete the preset “${preset.name}”?`)) return;
  try {
    const data = await api(`/api/generation-presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
    state.generator.presets = Array.isArray(data.presets) ? data.presets : [];
    state.generator.selectedPresetId = '';
    toast('Preset deleted.', 'success');
  } catch (err) {
    toast(err.message || 'Could not delete the preset.', 'error');
  } finally {
    renderGenerator();
  }
}

async function generateImages() {
  const prompt = $('#generator-prompt').value.trim();
  if (state.generator.generating || state.generator.uploading || state.generator.savingModel) return;
  const composition = state.generator.mode === 'panels'
    ? { layout: state.generator.layout, panels: generatorPanelPositions().map((_, index) => (state.generator.panels[index] || '').trim()) }
    : null;
  if (composition) {
    const missing = composition.panels.findIndex((text) => !text);
    if (missing !== -1) {
      $(`#generator-panel-${missing + 1}`).focus();
      return toast(`Enter a prompt for panel ${missing + 1}.`, 'error');
    }
  } else if (!prompt) return toast('Enter a prompt first.', 'error');
  const size = $('#generator-size').value;
  const count = Math.min(4, Math.max(1, Number($('#generator-count').value) || 1));
  const references = generatorReferencePayload();

  state.generator.generating = true;
  const runToken = ++state.generator.runToken;
  const userId = state.user && state.user.id;
  renderGenerator();
  const processId = startProcess(count > 1 ? `Generating image 1 of ${count}` : 'Generating image');
  let done = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      if (state.generator.runToken !== runToken || !state.user || state.user.id !== userId) break;
      if (index > 0) updateProcess(processId, `Generating image ${index + 1} of ${count}`);
      try {
        const data = await api('/api/generations', { method: 'POST', body: { prompt, size, references, composition } });
        if (state.generator.runToken !== runToken || !state.user || state.user.id !== userId) break;
        state.generator.generations.unshift(data.generation);
        if (data.libraryWarning) toast(data.libraryWarning, 'error');
        done += 1;
        renderGeneratorGallery();
      } catch (err) {
        if (state.generator.runToken !== runToken || !state.user || state.user.id !== userId) break;
        handleMissingImageKey(err);
        toast(err.message || 'Could not generate the image.', 'error');
        break;
      }
    }
  } finally {
    finishProcess(processId);
    if (state.generator.runToken === runToken) {
      state.generator.generating = false;
      renderGenerator();
    }
  }
  if (done && state.generator.runToken === runToken) toast(`${done} image${done === 1 ? '' : 's'} generated.`, 'success');
}

async function deleteGeneration(generation) {
  const note = generation.assetId
    ? 'This also removes it from the Library. Images that have been reviewed or filed into a project cannot be deleted here.'
    : 'This removes the image from this tab.';
  if (!confirm(`Delete this image?\n\n${note}`)) return;
  try {
    const data = await api(`/api/generations/${encodeURIComponent(generation.id)}`, { method: 'DELETE' });
    state.generator.generations = Array.isArray(data.generations) ? data.generations : [];
    toast('Image deleted.', 'success');
  } catch (err) {
    toast(err.message || 'Could not delete the image.', 'error');
  } finally {
    renderGenerator();
  }
}

async function openGenerationInLibrary(generation) {
  if (!generation.assetId) return toast('This image is not in the Library.', 'error');
  switchTab('library');
  await loadLibrary(true);
  const found = state.library.images.find((image) => image.assetId === generation.assetId);
  if (!found) {
    return toast('This image is not in the Library yet. Run an asset sync in the Library tab.', 'error');
  }
  openLibraryDetail(generation.assetId);
}

$('#generator-generate').addEventListener('click', generateImages);
$('#generator-retry').addEventListener('click', () => loadGenerator({ force: true }));
$('#generator-preset-insert').addEventListener('click', insertGeneratorPreset);
$('#generator-preset-save').addEventListener('click', saveGeneratorPreset);
$('#generator-preset-delete').addEventListener('click', deleteGeneratorPreset);
$('#generator-preset').addEventListener('change', (event) => {
  state.generator.selectedPresetId = event.target.value;
  renderGeneratorPresets();
});
$('#generator-reference-add-library').addEventListener('click', addLibraryReference);
$('#generator-reference-add-character').addEventListener('click', addCharacterReference);
$('#generator-reference-upload').addEventListener('click', uploadGeneratorReference);
$('#generator-reference-file').addEventListener('change', uploadGeneratorReference);
$('#generator-model').addEventListener('change', async (event) => {
  const imageModel = event.target.value;
  const userId = state.user && state.user.id;
  const token = state.generator.runToken;
  state.generator.savingModel = true;
  renderGenerator();
  try {
    const { user } = await api('/api/me/ai-settings', { method: 'PUT', body: { imageModel } });
    if (!state.user || state.user.id !== userId || state.generator.runToken !== token) return;
    state.user = user;
    refreshImageTools();
    toast(`Image model: ${IMAGE_MODEL_LABELS[imageModel]}.`, 'success');
  } catch (error) {
    if (state.user && state.user.id === userId) toast(error.message || 'Could not save the image model.', 'error');
  } finally {
    if (state.user && state.user.id === userId && state.generator.runToken === token) {
      state.generator.savingModel = false;
      renderGenerator();
    }
  }
});
$('#generator-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-generator-mode]');
  if (!button || state.generator.generating || state.generator.uploading) return;
  state.generator.mode = button.dataset.generatorMode;
  renderGenerator();
});
$('#generator-layout').addEventListener('change', (event) => {
  state.generator.layout = event.target.value;
  renderGeneratorComposition();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Mobile navigation: keep the assistant available without shrinking the editor.
const mobileNavigationQuery = window.matchMedia('(max-width: 900px), (max-width: 1024px) and (max-height: 500px)');
let sidebarPreviousFocus = null;

function setMobileAccount(open) {
  $('.app-header').classList.toggle('account-open', open);
  $('#account-toggle').setAttribute('aria-expanded', String(open));
}

function setMobileSidebar(open) {
  const visible = open && mobileNavigationQuery.matches;
  const wasOpen = document.body.classList.contains('sidebar-open');
  const sidebar = $('#sidebar');
  if (visible && !wasOpen) sidebarPreviousFocus = document.activeElement;
  document.body.classList.toggle('sidebar-open', visible);
  // Keep the same live widget and timer, but let mobile chat have its own space.
  const processWidget = $('#process-widget');
  const processHome = visible ? $('#sidebar-process-slot') : $('#process-widget-home');
  if (processWidget.parentElement !== processHome) processHome.appendChild(processWidget);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(visible));
  $('.app-header').inert = visible;
  $('.workspace').inert = visible;
  if (visible) {
    setMobileAccount(false);
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', 'Assistant and AI requests');
    requestAnimationFrame(() => {
      if (document.body.classList.contains('sidebar-open')) $('#sidebar-close').focus({ preventScroll: true });
    });
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    if (wasOpen && sidebarPreviousFocus && sidebarPreviousFocus.isConnected) sidebarPreviousFocus.focus();
    sidebarPreviousFocus = null;
  }
}

$('#sidebar-toggle').addEventListener('click', () => setMobileSidebar(true));
$('#sidebar-close').addEventListener('click', () => setMobileSidebar(false));
$('#sidebar-backdrop').addEventListener('click', () => setMobileSidebar(false));
$('#account-toggle').addEventListener('click', () => setMobileAccount(!$('.app-header').classList.contains('account-open')));
mobileNavigationQuery.addEventListener('change', () => {
  setMobileSidebar(false);
  setMobileAccount(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setMobileSidebar(false);
    setMobileAccount(false);
  }
  if (event.key !== 'Tab' || !document.body.classList.contains('sidebar-open')) return;
  if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
  const focusable = Array.from($('#sidebar').querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
    .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first) return;
  if (!$('#sidebar').contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

// Carnival modules
//
// Carnival is the umbrella. Every screen lives in a module: Story Studio (one
// story, from idea to reviewed images) and Generate Images (character art,
// with or without a story). Accounts, provider keys, usage tracking, settings,
// the Library, and the Docs are shared services that serve every module and
// live in the header.
//
// A module owns its screens, its navigation, its terminology, and its assistant
// guidance. Adding a module means adding one entry here plus the panels its
// screens point at.
// ---------------------------------------------------------------------------
const MODULES = [
  {
    id: 'story-studio',
    label: 'Story Studio',
    icon: '📚',
    tagline: 'One story, from idea to reviewed images',
    guide: 'You are helping inside Story Studio, where one story moves through these steps in order: Idea, References, Characters & Locations, Scenes, Generate, Review. Keep every answer about the story the user has selected.',
    chatHint: 'Ask CarniChat how to move this story forward.',
    storyContext: true,
    screens: [
      { id: 'studio-projects', label: 'Projects', icon: '🗂️', tab: 'projects', badge: 'project-count-badge', hint: 'Every story you are working on.' },
      { id: 'studio-idea', label: 'Idea', icon: '💡', tab: 'story', step: 'idea', hint: 'The idea and the brief of the current story.' },
      { id: 'studio-references', label: 'References', icon: '📚', tab: 'reference', hint: 'The shared reference material every image prompt is built from.' },
      {
        id: 'studio-cast',
        label: 'Characters & Locations',
        icon: '🧑‍🎨',
        tab: 'story',
        step: 'cast',
        hint: 'The cast, the places, the look, and the character references.',
      },
      { id: 'studio-scenes', label: 'Scenes', icon: '🎬', tab: 'story', step: 'scenes', hint: 'The scene outline, the action references, and continuity.' },
      { id: 'studio-generate', label: 'Generate', icon: '🖼️', tab: 'generation', hint: 'Build one image prompt per action reference, then render every image.' },
      { id: 'studio-review', label: 'Review', icon: '✅', tab: 'studio-review', hint: 'Prompt review and the review state of this story\'s images.' },
    ],
  },
  {
    id: 'generate-images',
    label: 'Generate Images',
    icon: '🧑‍🎨',
    tagline: 'Character Maker and Standalone Images',
    guide: 'You are helping inside Generate Images, which holds the Character Maker and the Standalone image generator. These tools belong to no story unless the user is reusing one.',
    chatHint: 'Ask CarniChat about a character or an image.',
    screens: [
      { id: 'character-maker', label: 'Character Maker', icon: '🧑‍🎨', tab: 'characters', hint: 'Reusable characters, saved for every story.' },
      { id: 'standalone-images', label: 'Standalone Images', icon: '🖼', tab: 'standalone-images', hint: 'Prompt to image, with no project.' },
    ],
  },
];

// Shared services. These serve every module; they are not part of a module's
// own workflow, so they sit in the header above the modules.
const SHARED_TOOLS = [
  { id: 'ideas', label: 'Ideas', icon: '💡', tab: 'ideas', title: 'Generate story ideas' },
  { id: 'library', label: 'Library', icon: '🖼️', tab: 'library', title: 'Every asset in your account' },
  { id: 'apis', label: 'Settings', icon: '🔑', tab: 'apis', title: 'Provider keys, models, and AI settings' },
  { id: 'docs', label: 'Docs', icon: '📖', tab: 'docs', title: 'How Carnival and its modules work' },
];

// The six Story Studio steps, in workflow order, and the screen each one opens.
const STUDIO_STEP_SCREENS = {
  idea: 'studio-idea',
  references: 'studio-references',
  cast: 'studio-cast',
  scenes: 'studio-scenes',
  generate: 'studio-generate',
  review: 'studio-review',
};

function moduleById(id) {
  return MODULES.find((module) => module.id === id) || null;
}

function activeModule() {
  return moduleById(state.ui.module) || MODULES[0];
}

function allScreens() {
  const screens = [];
  MODULES.forEach((module) => {
    module.screens.forEach((screen) => screens.push({ ...screen, moduleId: module.id, shared: false }));
  });
  SHARED_TOOLS.forEach((tool) => screens.push({ ...tool, moduleId: 'shared', shared: true }));
  return screens;
}

function screenById(id) {
  return allScreens().find((screen) => screen.id === id) || null;
}

function activeScreen() {
  return screenById(state.ui.screen) || null;
}

// A step screen can hold more than one view; the first view is the default.
function activeView() {
  const screen = activeScreen();
  if (!screen || !screen.views) return null;
  return screen.views.find((view) => view.id === state.ui.view) || screen.views[0];
}

// CarniChat is the sidebar assistant. Its opening line follows the module, so
// each module keeps its own wording.
function carniChatEmptyHint() {
  return activeModule().chatHint || 'Ask CarniChat what to do next.';
}

function progressStep(stepId) {
  const progress = state.ui.progress;
  if (!progress || !Array.isArray(progress.steps)) return null;
  return progress.steps.find((step) => step.id === stepId) || null;
}

function moduleButton(className, active, label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${className}${active ? ' active' : ''}`;
  button.setAttribute('aria-selected', String(active));
  if (icon) {
    const mark = document.createElement('span');
    mark.className = 'module-icon';
    mark.textContent = icon;
    button.appendChild(mark);
  }
  const text = document.createElement('span');
  text.className = 'module-text';
  text.textContent = label;
  button.appendChild(text);
  return button;
}

function renderModuleBar() {
  const generating = !state.ui.shared;
  $('#module-bar').classList.toggle('hidden', !generating);
  $('#module-nav-wrap').classList.toggle('hidden', !generating);

  const list = $('#module-list');
  list.innerHTML = '';
  MODULES.forEach((module) => {
    const button = moduleButton('module-button', module.id === state.ui.module, '', module.icon);
    button.dataset.module = module.id;
    button.title = module.tagline;
    const label = document.createElement('span');
    label.className = 'module-label';
    label.textContent = module.label;
    const tagline = document.createElement('span');
    tagline.className = 'module-tagline';
    tagline.textContent = module.tagline;
    button.querySelector('.module-text').append(label, tagline);
    list.appendChild(button);
  });

  // The shared services sit in the header, beside the account controls.
  const shared = $('#header-shared');
  shared.innerHTML = '';
  const generate = moduleButton('module-tool', generating, '📚 Generate');
  generate.id = 'header-generate';
  generate.dataset.tool = 'generate';
  generate.title = 'Open Story Studio and Generate Images';
  generate.removeAttribute('aria-selected');
  generate.setAttribute('aria-expanded', String(generating));
  generate.setAttribute('aria-controls', 'module-bar module-nav-wrap');
  shared.appendChild(generate);
  SHARED_TOOLS.forEach((tool) => {
    const button = moduleButton('module-tool', state.ui.shared === tool.id, `${tool.icon} ${tool.label}`);
    button.dataset.tool = tool.id;
    button.title = tool.title;
    shared.appendChild(button);
  });
}

function renderModuleNav() {
  const nav = $('#module-nav');
  const module = activeModule();
  nav.innerHTML = '';
  nav.dataset.module = module.id;

  const heading = document.createElement('span');
  heading.className = 'module-nav-heading';
  heading.textContent = module.label;
  nav.appendChild(heading);

  module.screens.forEach((screen, index) => {
    const active = !state.ui.shared && screen.id === state.ui.screen;
    const button = moduleButton('module-nav-button', active, '', screen.icon);
    button.dataset.screen = screen.id;
    if (screen.hint) button.title = screen.hint;
    if (screen.step) {
      // Step screens are numbered so the workflow order is visible.
      const number = document.createElement('span');
      number.className = 'module-nav-number';
      number.textContent = String(index);
      button.insertBefore(number, button.firstChild);
      const status = progressStep(screen.step);
      if (status) {
        button.dataset.status = status.status;
        const dot = document.createElement('span');
        dot.className = 'module-nav-status';
        dot.textContent = status.status === 'done' ? '✓' : status.status === 'attention' ? '!' : '';
        dot.title = status.detail || '';
        button.appendChild(dot);
      }
    }
    if (screen.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.id = screen.badge;
      badge.textContent = String(state.projects.length);
      button.appendChild(badge);
    }
    nav.appendChild(button);
  });
}

function renderModuleSubnav() {
  const subnav = $('#module-subnav');
  const screen = activeScreen();
  subnav.innerHTML = '';
  if (state.ui.shared || !screen || !screen.views) {
    subnav.classList.add('hidden');
    return;
  }
  subnav.classList.remove('hidden');
  screen.views.forEach((view) => {
    const button = moduleButton('module-view-button', view.id === state.ui.view, view.label);
    button.dataset.view = view.id;
    subnav.appendChild(button);
  });
}

function renderNavigation() {
  renderModuleBar();
  renderModuleNav();
  renderModuleSubnav();
  renderModuleContext();
}

// The persistent story selector: one choice that drives every story screen.
function initialStudioStoryId() {
  const candidates = [state.sidebar.projectId, state.story.projectId, state.reference.projectId, state.generation.projectId];
  const known = candidates.find((id) => id && state.projects.some((project) => project.id === id));
  if (known) return known;
  return state.projects.length ? state.projects[0].id : '';
}

function syncStudioStory() {
  const select = $('#studio-story');
  if (!select) return;
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = state.projects.length ? 'Choose a story…' : 'No stories yet';
  select.appendChild(blank);
  state.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.title || 'Untitled story';
    select.appendChild(option);
  });
  select.value = state.ui.storyId || '';
}

function setStudioStory(projectId) {
  const id = projectId || '';
  state.ui.storyId = id;
  // One choice, applied to every story-scoped screen.
  state.story.projectId = id;
  state.reference.projectId = id || null;
  state.generation.projectId = id || null;
  state.sidebar.projectId = id;
  state.sidebar.story = null;
  state.sidebar.storyProjectId = '';
  state.story.data = id ? state.story.data : null;
  state.ui.progress = null;
  state.ui.progressFor = '';
  [['#story-project', id], ['#ref-project', id], ['#gen-project', id], ['#sidebar-project', id]].forEach(([selector, value]) => {
    const element = $(selector);
    if (element && value) element.value = value;
  });
  refreshSidebarStory();
  renderSidebarNextStep();
  renderStudioReview();
  loadStudioProgress();
}

function renderModuleContext() {
  const context = $('#module-context');
  const show = Boolean(activeModule().storyContext);
  context.classList.toggle('hidden', !show);
  if (!show) {
    $('#studio-progress-detail').classList.add('hidden');
    return;
  }
  syncStudioStory();
  renderStudioProgress();
}

async function loadStudioProgress() {
  const storyId = state.ui.storyId;
  if (!activeModule().storyContext || !storyId) {
    state.ui.progress = null;
    state.ui.progressFor = '';
    renderStudioProgress();
    renderStudioReview();
    return;
  }
  if (state.ui.progressFor !== storyId) {
    state.ui.progress = null;
    state.ui.progressFor = storyId;
    renderStudioProgress();
  }
  state.ui.progressLoading = true;
  try {
    const payload = await api(`/api/studio/${encodeURIComponent(storyId)}/progress`);
    if (state.ui.storyId !== storyId) return;
    state.ui.progress = payload;
  } catch (err) {
    if (state.ui.storyId !== storyId) return;
    state.ui.progress = null;
    state.ui.progressError = err.message || 'Could not load the story progress.';
  } finally {
    state.ui.progressLoading = false;
  }
  if (state.ui.storyId !== storyId) return;
  renderStudioProgress();
  renderStudioReview();
}

function renderStudioProgress() {
  const pill = $('#studio-progress');
  const button = $('#studio-next-action');
  const next = state.ui.progress && state.ui.progress.next;
  if (!state.ui.storyId) {
    pill.textContent = state.projects.length ? 'No story selected' : 'No stories yet';
    pill.dataset.status = '';
    button.classList.add('hidden');
    renderStudioProgressDetail();
    return;
  }
  if (!state.ui.progress) {
    pill.textContent = state.ui.progressLoading ? 'Checking progress…' : 'Progress unavailable';
    pill.dataset.status = '';
    button.classList.add('hidden');
    renderStudioProgressDetail();
    return;
  }
  const counts = state.ui.progress.counts || { done: 0, attention: 0, todo: 0, total: 0 };
  pill.dataset.status = counts.attention ? 'attention' : counts.todo ? 'todo' : 'done';
  pill.textContent = `${counts.done} of ${counts.total} steps done`
    + (counts.attention ? ` · ${counts.attention} needing a decision` : '')
    + (next ? ` · next: ${next.label}` : ' · story complete');
  pill.title = 'Show the full progress overview';
  if (next) {
    button.classList.remove('hidden');
    button.textContent = `→ ${next.label}`;
    button.title = next.action || next.detail || '';
  } else {
    button.classList.add('hidden');
  }
  renderStudioProgressDetail();
}

function renderStudioProgressDetail() {
  const box = $('#studio-progress-detail');
  const progress = state.ui.progress;
  if (!progress || !state.ui.detailOpen) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'progress-detail-head';
  const title = document.createElement('strong');
  title.textContent = (progress.project && progress.project.title) || 'This story';
  const summary = document.createElement('span');
  summary.className = 'hint';
  const counts = progress.counts || { done: 0, attention: 0, todo: 0 };
  summary.textContent = `${counts.done} done · ${counts.attention} needing a decision · ${counts.todo} to do`;
  head.append(title, summary);
  box.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'progress-step-list';
  progress.steps.forEach((step, index) => {
    const item = document.createElement('li');
    item.className = `progress-step progress-${step.status}`;
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'progress-step-label';
    label.dataset.screen = step.screen || STUDIO_STEP_SCREENS[step.id] || 'studio-projects';
    label.textContent = `${index + 1}. ${step.label}`;
    const detail = document.createElement('span');
    detail.className = 'progress-step-detail';
    detail.textContent = step.detail || '';
    item.append(label, detail);
    list.appendChild(item);
  });
  box.appendChild(list);
}

// The Review step: what still needs a human decision for this story.
const STUDIO_REVIEW_STEP_LABELS = {
  idea: 'Idea',
  references: 'References',
  cast: 'Characters & Locations',
  scenes: 'Scenes',
  generate: 'Generate',
  review: 'Review',
};

function reviewDecisionLabel(asset) {
  const decision = (asset.metadata && asset.metadata.reviewDecision) || '';
  return decision || 'Not reviewed';
}

function renderStudioReviewImages() {
  const box = $('#studio-review-images');
  if (!box) return;
  const status = $('#studio-review-images-status');
  box.innerHTML = '';
  const storyId = state.ui.storyId;
  if (!storyId) {
    status.textContent = '';
    box.textContent = 'Choose a story to see its images.';
    return;
  }
  if (!state.library.loaded) {
    status.textContent = '';
    box.textContent = 'Loading this story\'s images…';
    loadLibrary();
    return;
  }
  const images = state.library.images.filter((image) => (image.metadata && image.metadata.projectId) === storyId);
  if (!images.length) {
    status.textContent = '';
    box.textContent = 'No images are filed into this story yet.';
    return;
  }
  const decided = images.filter((image) => (image.metadata && image.metadata.reviewDecision)).length;
  status.textContent = `${decided} of ${images.length} images reviewed`;
  const list = document.createElement('ul');
  list.className = 'review-image-list';
  images.forEach((image) => {
    const item = document.createElement('li');
    item.className = 'review-image-item';
    const name = document.createElement('span');
    name.className = 'review-image-name';
    name.textContent = image.name || image.relativePath || image.assetId;
    const decision = document.createElement('span');
    decision.className = `review-image-decision decision-${((image.metadata && image.metadata.reviewDecision) || 'none').toLowerCase().replace(/\s+/g, '-')}`;
    decision.textContent = reviewDecisionLabel(image);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-ghost btn-sm';
    open.dataset.asset = image.assetId || image.id;
    open.textContent = '🔎 Open in Library';
    item.append(name, decision, open);
    list.appendChild(item);
  });
  box.appendChild(list);
}

function renderStudioReview() {
  const box = $('#studio-review-summary');
  if (!box) return;
  const status = $('#studio-review-summary-status');
  box.innerHTML = '';
  if (!state.ui.storyId) {
    status.textContent = '';
    box.textContent = 'Choose a story to review it.';
    renderStudioReviewImages();
    return;
  }
  const progress = state.ui.progress;
  if (!progress) {
    status.textContent = '';
    box.textContent = 'Checking what needs a decision…';
    renderStudioReviewImages();
    return;
  }
  const attention = progress.steps.filter((step) => step.status === 'attention');
  status.textContent = attention.length
    ? `${attention.length} step${attention.length === 1 ? '' : 's'} need a decision`
    : 'Nothing needs a decision';
  if (!attention.length) {
    const done = document.createElement('p');
    done.className = 'hint';
    done.textContent = 'Every prompt and every image for this story has its decision recorded.';
    box.appendChild(done);
  } else {
    const list = document.createElement('ul');
    list.className = 'review-needs-list';
    attention.forEach((step) => {
      const item = document.createElement('li');
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'review-needs-label';
      label.dataset.screen = step.screen || STUDIO_STEP_SCREENS[step.id] || 'studio-projects';
      label.textContent = step.label || STUDIO_REVIEW_STEP_LABELS[step.id] || step.id;
      const detail = document.createElement('span');
      detail.className = 'hint';
      detail.textContent = step.detail || '';
      item.append(label, detail);
      list.appendChild(item);
    });
    box.appendChild(list);
  }
  renderStudioReviewImages();
}

// The story panel serves three steps, so its heading follows the module
// navigation instead of naming one screen.
function renderStoryStepHead() {
  const title = $('#story-head-title');
  if (!title) return;
  const screen = allScreens().find((item) => item.moduleId === 'story-studio' && item.step && item.step === state.ui.step);
  const view = activeView();
  const activeViewLabel = view && screen && screen.views && view.id !== screen.views[0].id ? view.label : '';
  title.textContent = activeViewLabel || (screen ? screen.label : 'Story');
  $('#story-head-hint').textContent = screen
    ? screen.hint
    : 'The current story: its idea, its cast and places, and its scenes.';
}

// Show only the cards that belong to the active Story Studio step.
function applyStoryStep() {
  const panel = $('#panel-story');
  if (!panel) return;
  const step = state.ui.step || '';
  panel.querySelectorAll('[data-story-step]').forEach((element) => {
    const matches = !step || element.dataset.storyStep === step;
    element.classList.toggle('hidden', !matches);
  });
  panel.querySelectorAll('.grid-two > .col').forEach((column) => {
    const cards = Array.from(column.querySelectorAll('[data-story-step]'));
    column.classList.toggle('step-empty', cards.length > 0 && cards.every((card) => card.classList.contains('hidden')));
  });
  renderStoryStepHead();
}

// Entering a shared service adopts that module's default view of it.
function applyLibraryModuleDefault() {
  const module = activeModule();
  const storyId = module.storyContext ? state.ui.storyId : '';
  const wants = module.id === 'generate-images' ? 'unassigned' : storyId ? `project:${storyId}` : '';
  if (!wants || state.ui.libraryDefault === wants) return;
  state.ui.libraryDefault = wants;
  const filters = state.library.filters;
  if (wants === 'unassigned') {
    filters.projectId = '';
    filters.unassigned = true;
  } else {
    filters.projectId = storyId;
    filters.unassigned = false;
  }
  renderLibraryFilters();
  renderLibrary();
}

function switchScreen(screenId) {
  const screen = screenById(screenId);
  if (!screen) return;
  setMobileSidebar(false);
  setMobileAccount(false);
  state.ui.shared = screen.shared ? screen.id : '';
  if (!screen.shared) {
    state.ui.module = screen.moduleId;
    state.ui.screen = screen.id;
    state.ui.view = screen.views
      ? (screen.views.some((view) => view.id === state.ui.view) ? state.ui.view : screen.views[0].id)
      : '';
  }
  const view = screen.shared ? null : activeView();
  const effective = view || screen;
  state.ui.tab = effective.tab;
  state.ui.step = effective.step || '';
  // Render the navigation first: the screens it owns (like the project badge)
  // must exist before the panel's own render runs.
  renderNavigation();
  switchTab(effective.tab, { fromScreen: true });
  applyStoryStep();
  if (effective.tab === 'library') applyLibraryModuleDefault();
  loadStudioProgress();
  renderStudioReview();
}

// A direct switchTab() call (from anywhere in the app) lands on the screen that
// owns that panel, so the module navigation never disagrees with the view.
function adoptTabInNavigation(tab) {
  setMobileSidebar(false);
  const screens = allScreens().filter((screen) => !screen.shared && screen.tab === tab);
  if (!screens.length) {
    renderNavigation();
    return;
  }
  const chosen = screens.find((screen) => screen.step && screen.step === state.ui.step) || screens[0];
  state.ui.module = chosen.moduleId;
  state.ui.screen = chosen.id;
  state.ui.shared = '';
  state.ui.view = chosen.views ? chosen.views[0].id : '';
  const view = activeView();
  state.ui.step = (view && view.step) || chosen.step || '';
  state.ui.tab = chosen.tab;
  applyStoryStep();
  renderNavigation();
}

function initModuleNavigation() {
  state.ui.storyId = initialStudioStoryId();
  state.ui.detailOpen = false;

  $('#module-bar').addEventListener('click', (event) => {
    const moduleHit = event.target.closest('.module-button');
    if (moduleHit) {
      const target = moduleById(moduleHit.dataset.module);
      if (target) switchScreen(target.screens[0].id);
    }
  });

  // The shared services live in the header, so they keep their own handler.
  $('#header-shared').addEventListener('click', (event) => {
    const toolHit = event.target.closest('.module-tool');
    if (!toolHit) return;
    switchScreen(toolHit.dataset.tool === 'generate' ? state.ui.screen : toolHit.dataset.tool);
  });

  $('#module-nav').addEventListener('click', (event) => {
    const hit = event.target.closest('.module-nav-button');
    if (hit) switchScreen(hit.dataset.screen);
  });

  $('#module-subnav').addEventListener('click', (event) => {
    const hit = event.target.closest('.module-view-button');
    if (!hit) return;
    state.ui.view = hit.dataset.view;
    const view = activeView();
    if (view) {
      state.ui.tab = view.tab;
      state.ui.step = view.step || '';
      switchTab(view.tab, { fromScreen: true });
      applyStoryStep();
    }
    renderNavigation();
    loadStudioProgress();
  });

  $('#studio-story').addEventListener('change', (event) => {
    setStudioStory(event.target.value);
    switchScreen(state.ui.screen);
  });

  $('#studio-progress').addEventListener('click', () => {
    if (!state.ui.progress) return;
    state.ui.detailOpen = !state.ui.detailOpen;
    renderStudioProgressDetail();
  });

  $('#studio-next-action').addEventListener('click', () => {
    const next = state.ui.progress && state.ui.progress.next;
    if (!next) return;
    switchScreen(next.screen || STUDIO_STEP_SCREENS[next.stepId] || 'studio-projects');
  });

  $('#studio-progress-detail').addEventListener('click', (event) => {
    const hit = event.target.closest('.progress-step-label');
    if (!hit) return;
    state.ui.detailOpen = false;
    switchScreen(hit.dataset.screen);
  });

  $('#studio-review-summary').addEventListener('click', (event) => {
    const hit = event.target.closest('.review-needs-label');
    if (hit) switchScreen(hit.dataset.screen);
  });

  $('#studio-review-images').addEventListener('click', (event) => {
    const hit = event.target.closest('[data-asset]');
    if (!hit) return;
    switchScreen('library');
    openLibraryDetail(hit.dataset.asset);
  });

  $('#studio-idea-save').addEventListener('click', saveStudioIdea);

  // Point every story-scoped panel at the selected story before the first
  // screen loads, so the selector and the screens can never disagree.
  if (state.ui.storyId) setStudioStory(state.ui.storyId);

  // Story Studio ▸ Projects is the module's entry point; a brand new account
  // starts at Ideas, because a story cannot exist before one.
  switchScreen(state.projects.length ? 'studio-projects' : 'ideas');
}

function resetStudio() {
  setMobileSidebar(false);
  setMobileAccount(false);
  state.ui.module = MODULES[0].id;
  state.ui.screen = MODULES[0].screens[0].id;
  state.ui.view = '';
  state.ui.shared = '';
  state.ui.step = '';
  state.ui.tab = 'projects';
  state.ui.storyId = '';
  state.ui.progress = null;
  state.ui.progressFor = '';
  state.ui.progressError = '';
  state.ui.progressLoading = false;
  state.ui.detailOpen = false;
  state.ui.libraryDefault = '';
}

function renderStudioIdeaCard() {
  const title = $('#studio-idea-title');
  if (!title) return;
  const project = state.projects.find((item) => item.id === state.ui.storyId) || null;
  title.value = project ? project.title || '' : '';
  $('#studio-idea-stage').value = project ? project.stage || '' : '';
  $('#studio-idea-text').value = project ? project.idea || '' : '';
  $('#studio-idea-description').value = project ? project.description || '' : '';
  $('#studio-idea-hint').textContent = project
    ? 'The idea is what this story grew from; the brief above is its canonical root.'
    : 'Choose a story above to write its idea.';
  $('#studio-idea-save').disabled = !project;
}

async function saveStudioIdea() {
  const project = state.projects.find((item) => item.id === state.ui.storyId);
  if (!project) return;
  const button = $('#studio-idea-save');
  button.disabled = true;
  try {
    const { project: updated } = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: {
        title: $('#studio-idea-title').value.trim(),
        idea: $('#studio-idea-text').value,
        description: $('#studio-idea-description').value,
      },
    });
    Object.assign(project, updated);
    renderProjects();
    renderStudioIdeaCard();
    toast('Story idea saved.', 'success');
    loadStudioProgress();
  } catch (err) {
    toast(err.message || 'Could not save the story idea.', 'error');
  } finally {
    button.disabled = false;
  }
}

function switchTab(name, options = {}) {
  if (state.story.dirty && name !== 'story' && !confirm('Discard unsaved story changes?')) return;
  const panels = {
    ideas: 'panel-ideas',
    projects: 'panel-projects',
    reference: 'panel-reference',
    characters: 'panel-characters',
    'project-characters': 'panel-project-characters',
    'standalone-images': 'panel-standalone-images',
    story: 'panel-story',
    generation: 'panel-generation',
    'studio-review': 'panel-studio-review',
    library: 'panel-library',
    apis: 'panel-apis',
    docs: 'panel-docs',
  };
  Object.entries(panels).forEach(([key, id]) => {
    $('#' + id).classList.toggle('active', key === name);
  });
  if (name === 'projects') renderProjects();
  if (name === 'reference') renderReferenceProjects();
  if (name === 'characters') loadCharacters();
  if (name === 'project-characters') loadProjectCharacters();
  if (name === 'standalone-images') loadGenerator();
  if (name === 'story') renderStoryProjects();
  if (name === 'generation') renderGenerationProjects();
  if (name === 'studio-review') {
    renderGenerationProjects();
    renderStudioIdeaCard();
    renderStudioReview();
  }
  if (name === 'story') renderStudioIdeaCard();
  if (name === 'library') loadLibrary();
  if (name === 'apis') applyAiSettings();
  if (!options.fromScreen) adoptTabInNavigation(name);
}

// ---------------------------------------------------------------------------
// Idea Generator context input: file upload + paste (persisted on this device)
// ---------------------------------------------------------------------------
const IDEA_CONTEXT_KEY = 'projectWorkflow.ideaContext';
const contextText = $('#context-text');
const dropZone = $('#drop-zone');
const fileChip = $('#file-chip');
const fileName = $('#file-name');

function saveIdeaContext() {
  try {
    const value = contextText.value;
    if (value) localStorage.setItem(IDEA_CONTEXT_KEY, value);
    else localStorage.removeItem(IDEA_CONTEXT_KEY);
  } catch (_) { /* storage unavailable */ }
}

function loadIdeaContext() {
  try {
    const saved = localStorage.getItem(IDEA_CONTEXT_KEY);
    if (typeof saved === 'string' && saved) contextText.value = saved;
  } catch (_) { /* storage unavailable */ }
}

function clearIdeaContext() {
  contextText.value = '';
  fileChip.classList.add('hidden');
  fileName.textContent = '';
  try { localStorage.removeItem(IDEA_CONTEXT_KEY); } catch (_) { /* ignore */ }
  contextText.focus();
}

function setContextFromFile(file) {
  if (!file) return;
  if (!/\.txt$/i.test(file.name) && file.type && !file.type.startsWith('text/')) {
    toast('Please choose a .txt file.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    contextText.value = String(reader.result || '');
    saveIdeaContext();
    fileName.textContent = file.name;
    fileChip.classList.remove('hidden');
    toast('Context loaded from ' + file.name, 'success');
  };
  reader.onerror = () => toast('Could not read file.', 'error');
  reader.readAsText(file);
}

contextText.addEventListener('input', saveIdeaContext);

$('#pick-file').addEventListener('click', () => $('#context-file').click());
$('#context-file').addEventListener('change', (e) => {
  setContextFromFile(e.target.files[0]);
  e.target.value = '';
});
$('#clear-file').addEventListener('click', clearIdeaContext);
$('#clear-context').addEventListener('click', clearIdeaContext);
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  setContextFromFile(e.dataTransfer.files[0]);
});

loadIdeaContext();

// ---------------------------------------------------------------------------
// Idea generation (through the server, with the user's stored key)
// ---------------------------------------------------------------------------
const generateBtn = $('#generate-btn');

async function generateIdeas() {
  const model = $('#model').value.trim();
  const context = contextText.value.trim();
  const numIdeas = Math.min(Math.max(parseInt($('#num-ideas').value, 10) || 5, 1), 50);

  if (!state.user) return showAuth();
  if (!hasTextApiKey()) {
    toast('Save the selected text provider API key in Settings first.', 'error');
    switchTab('apis');
    $('#api-key').focus();
    return;
  }
  if (!model) return toast('Choose a model.', 'error');
  if (!context) return toast('Provide context (upload or paste).', 'error');

  generateBtn.disabled = true;
  $('#generate-label').textContent = 'Generating…';
  $('#generating').classList.remove('hidden');
  $('#generating-text').textContent = `Generating ${numIdeas} ideas…`;
  $('#gen-hint').textContent = 'Calling the selected text model with your saved key — this can take a few seconds.';
  const processId = startProcess('Generating ideas');

  try {
    const data = await api('/api/generate', {
      method: 'POST',
      body: { model, context, numIdeas },
    });
    state.ideas = data.ideas || [];
    state.selected = new Set();
    renderIdeas();
    $('#gen-hint').textContent = `Generated ${state.ideas.length} idea(s).`;
    if (state.ideas.length) toast(`Generated ${state.ideas.length} ideas.`, 'success');
  } catch (err) {
    $('#gen-hint').textContent = 'Generation failed.';
    if (err.code === 'NO_API_KEY') {
      state.user.hasApiKey = false;
      renderKeyState();
      $('#api-key').focus();
    }
    if (err.code === 'INVALID_API_KEY' || err.code === 'KEY_UNREADABLE') {
      $('#api-key').focus();
    }
    toast(err.message || 'Something went wrong.', 'error');
  } finally {
    finishProcess(processId);
    generateBtn.disabled = false;
    $('#generate-label').textContent = '✨ Generate ideas';
    $('#generating').classList.add('hidden');
  }
}

generateBtn.addEventListener('click', generateIdeas);

// ---------------------------------------------------------------------------
// Render ideas
// ---------------------------------------------------------------------------
function renderIdeas() {
  const list = $('#idea-list');
  const empty = $('#ideas-empty');
  const count = $('#idea-count');
  count.textContent = state.ideas.length;
  list.innerHTML = '';

  if (!state.ideas.length) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
    list.classList.remove('hidden');
  }

  state.ideas.forEach((idea, idx) => {
    const li = document.createElement('li');
    li.className = 'idea-item' + (state.selected.has(idx) ? ' selected' : '');
    li.innerHTML = `
      <input type="checkbox" data-idx="${idx}" ${state.selected.has(idx) ? 'checked' : ''} />
      <div class="idea-body">
        <div class="idea-title"></div>
        <div class="idea-desc"></div>
      </div>`;
    li.querySelector('.idea-title').textContent = idea.title;
    li.querySelector('.idea-desc').textContent = idea.description || '';
    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const cb = li.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      toggleSelection(idx, cb.checked);
    });
    li.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      toggleSelection(idx, e.target.checked);
    });
    list.appendChild(li);
  });

  updateBulkBar();
}

function toggleSelection(idx, checked) {
  if (checked) state.selected.add(idx);
  else state.selected.delete(idx);
  const li = document.querySelector(`input[data-idx="${idx}"]`)?.closest('.idea-item');
  if (li) li.classList.toggle('selected', checked);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('#bulk-bar');
  const n = state.selected.size;
  if (!state.ideas.length || !n) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#selected-count').textContent = n;
}

$('#select-all').addEventListener('click', () => {
  if (!state.ideas.length) return;
  state.ideas.forEach((_, i) => state.selected.add(i));
  renderIdeas();
});
$('#select-none').addEventListener('click', () => {
  state.selected.clear();
  renderIdeas();
});

function selectedIdeas() {
  return Array.from(state.selected)
    .sort((a, b) => a - b)
    .map((i) => state.ideas[i]);
}

$('#export-btn').addEventListener('click', () => {
  const ideas = selectedIdeas();
  if (!ideas.length) return toast('Select at least one idea.', 'error');
  const text = ideas
    .map((idea, i) => {
      const lines = [`${i + 1}. ${idea.title}`];
      if (idea.description) lines.push(`   ${idea.description}`);
      return lines.join('\n');
    })
    .join('\n\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`ideas-${stamp}.txt`, text + '\n');
  toast('Exported ' + ideas.length + ' idea(s).', 'success');
});

$('#import-btn').addEventListener('click', async () => {
  const ideas = selectedIdeas();
  if (!ideas.length) return toast('Select at least one idea.', 'error');

  const button = $('#import-btn');
  button.disabled = true;
  let imported = 0;
  try {
    for (const idea of ideas) {
      await api('/api/projects', {
        method: 'POST',
        body: {
          title: idea.title,
          idea: idea.description || '',
          description: '',
          stage: 'Idea Stage',
          status: 'Not Started',
          priority: 'Medium',
          source: 'idea',
        },
      });
      imported++;
    }
    await loadProjects();
    state.selected.clear();
    renderIdeas();
    state.stageFilter = 'Idea Stage';
    renderStageTabs();
    switchTab('projects');
    toast(`Imported ${imported} idea(s) into Project Management.`, 'success');
  } catch (err) {
    if (imported) await loadProjects();
    toast(
      imported
        ? `Imported ${imported} of ${ideas.length}. ${err.message}`
        : err.message || 'Could not import the ideas.',
      'error'
    );
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Project management (server database)
// ---------------------------------------------------------------------------
async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = Array.isArray(projects) ? projects : [];
  renderProjects();
}

/**
 * The pre-accounts version stored projects in localStorage. Move them into the
 * signed-in account once, and only when the account has no projects yet.
 */
async function importLegacyProjects() {
  const raw = localStorage.getItem('projectWorkflow.projects');
  if (!raw) return;
  if (localStorage.getItem('projectWorkflow.imported') === '1') return;

  let items;
  try {
    items = JSON.parse(raw);
  } catch (_) {
    localStorage.removeItem('projectWorkflow.projects');
    return;
  }
  if (!Array.isArray(items) || !items.length) {
    localStorage.removeItem('projectWorkflow.projects');
    return;
  }
  if (state.projects.length) return; // account already has data; keep the local copy

  try {
    const { imported } = await api('/api/projects/import', {
      method: 'POST',
      body: { projects: items.slice(0, 500) },
    });
    localStorage.setItem('projectWorkflow.imported', '1');
    if (imported) {
      await loadProjects();
      toast(`Imported ${imported} project(s) from this browser.`, 'success');
    }
  } catch (err) {
    if (err.status !== 401) toast(err.message || 'Could not import local projects.', 'error');
  }
}

function updateBadge() {
  // The badge lives on the Story Studio Projects screen button, so it only
  // exists while that module's navigation is rendered.
  const badge = $('#project-count-badge');
  if (badge) badge.textContent = state.projects.length;
}

function renderStageTabs() {
  $$('.pm-stage-tab').forEach((tab) => {
    const active = tab.dataset.stage === state.stageFilter;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function setStageFilter(stage) {
  if (!PM_TABS.includes(stage)) return;
  state.stageFilter = stage;
  const filter = $('#pm-filter');
  if (stage === 'Completed') {
    filter.value = 'all';
    filter.disabled = true;
  } else {
    filter.disabled = false;
  }
  renderStageTabs();
  renderProjects();
}

$$('.pm-stage-tab').forEach((tab) => {
  tab.addEventListener('click', () => setStageFilter(tab.dataset.stage));
});

function renderProjects() {
  const query = ($('#pm-search').value || '').toLowerCase();
  const filter = $('#pm-filter').value;

  const stageProjects = state.projects.filter((p) => {
    if (state.stageFilter === 'Completed') return p.status === 'Done';
    return (p.stage || 'Idea Stage') === state.stageFilter && p.status !== 'Done';
  });
  let list = stageProjects.slice();
  if (filter !== 'all') list = list.filter((p) => p.status === filter);
  if (query) {
    list = list.filter(
      (p) =>
        (p.title || '').toLowerCase().includes(query) ||
        (p.idea || '').toLowerCase().includes(query) ||
        (p.description || '').toLowerCase().includes(query) ||
        (p.referenceMaterial || '').toLowerCase().includes(query) ||
        (p.characterReferences || []).some((item) =>
          `${item.name || ''} ${item.gender || ''} ${item.referenceMaterial || ''}`
            .toLowerCase()
            .includes(query)
        )
    );
  }
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $('#pm-empty-text').textContent = stageProjects.length
    ? 'No projects match the current search or status filter.'
    : state.stageFilter === 'Completed'
      ? 'No completed projects yet. Use the ✓ Complete button on a project to move it here.'
      : `No projects in ${state.stageFilter} yet. Generate ideas and send them here, or create a project manually.`;

  const wrap = $('#pm-list');
  const empty = $('#pm-empty');
  wrap.innerHTML = '';

  if (!list.length) {
    empty.classList.remove('hidden');
    wrap.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
    wrap.classList.remove('hidden');
  }

  list.forEach((p) => wrap.appendChild(buildProjectCard(p)));
  updateBadge();
  renderSidebar();
}

function buildProjectCard(p) {
  const card = document.createElement('article');
  card.className = 'pm-card';

  const top = document.createElement('div');
  top.className = 'pm-card-top';
  const title = document.createElement('h3');
  title.className = 'pm-title';
  title.textContent = p.title;
  const actions = document.createElement('div');
  actions.className = 'pm-card-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-ghost btn-sm';
  editBtn.textContent = '✎ Edit';
  editBtn.addEventListener('click', () => openModal(p.id));

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-sm';
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${p.title}"?`)) return;
    delBtn.disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      state.projects = state.projects.filter((x) => x.id !== p.id);
      renderProjects();
      toast('Project deleted.', 'success');
    } catch (err) {
      delBtn.disabled = false;
      toast(err.message || 'Could not delete the project.', 'error');
    }
  });

  const moveBtn = document.createElement('button');
  moveBtn.className = 'btn btn-secondary btn-sm';
  moveBtn.textContent = '→ Generation';
  moveBtn.title = (p.referenceMaterial || '').trim()
    ? 'Move this project to Generation Stage'
    : 'Generate and save reference material first';
  moveBtn.disabled = !(p.referenceMaterial || '').trim();
  moveBtn.addEventListener('click', async () => {
    if (!confirm(`Move "${p.title}" to Generation Stage?`)) return;
    moveBtn.disabled = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: { stage: 'Generation Stage' },
      });
      Object.assign(p, project);
      setStageFilter('Generation Stage');
      toast('Project moved to Generation Stage.', 'success');
    } catch (err) {
      moveBtn.disabled = false;
      toast(err.message || 'Could not move the project.', 'error');
    }
  });

  const completeBtn = document.createElement('button');
  const isDone = p.status === 'Done';
  completeBtn.className = isDone ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  completeBtn.textContent = isDone ? '↩ Reopen' : '✓ Complete';
  completeBtn.title = isDone ? 'Move back to its project stage' : 'Mark this project complete';
  completeBtn.addEventListener('click', async () => {
    const nextStatus = isDone ? 'In Progress' : 'Done';
    completeBtn.disabled = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: { status: nextStatus },
      });
      Object.assign(p, project);
      setStageFilter(nextStatus === 'Done' ? 'Completed' : (project.stage || 'Idea Stage'));
      toast(nextStatus === 'Done' ? 'Project completed.' : 'Project reopened.', 'success');
    } catch (err) {
      completeBtn.disabled = false;
      toast(err.message || 'Could not update the project.', 'error');
    }
  });

  const episodesBtn = document.createElement('button');
  episodesBtn.className = 'btn btn-ghost btn-sm';
  episodesBtn.textContent = 'Episodes';
  episodesBtn.addEventListener('click', () => openEpisodesModal(p));

  actions.append(editBtn);
  if (p.stage === 'Reference Stage') actions.append(moveBtn);
  actions.append(episodesBtn, completeBtn, delBtn);
  top.append(title, actions);

  const idea = (p.idea || '').trim();
  const description = (p.description || '').trim();

  const ideaBlock = document.createElement('div');
  ideaBlock.className = 'pm-idea';
  const ideaLabel = document.createElement('span');
  ideaLabel.className = 'pm-idea-label';
  ideaLabel.textContent = 'Idea';
  const ideaText = document.createElement('p');
  ideaText.className = 'pm-idea-text';
  ideaText.textContent = idea;

  const descBlock = document.createElement('div');
  const descLabel = document.createElement('span');
  descLabel.className = 'pm-desc-label';
  descLabel.textContent = 'Description';
  const desc = document.createElement('p');
  desc.className = 'pm-desc';
  desc.textContent = description || 'No description.';

  const meta = document.createElement('div');
  meta.className = 'pm-meta';

  const stageSelect = document.createElement('select');
  PROJECT_STAGES.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    opt.selected = s === (p.stage || 'Idea Stage');
    stageSelect.appendChild(opt);
  });
  stageSelect.addEventListener('change', async () => {
    const previous = p.stage;
    stageSelect.disabled = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: { stage: stageSelect.value },
      });
      Object.assign(p, project);
    } catch (err) {
      stageSelect.value = previous;
      toast(err.message || 'Could not update the stage.', 'error');
    } finally {
      stageSelect.disabled = false;
      renderProjects();
    }
  });

  const statusSelect = document.createElement('select');
  PROJECT_STATUSES.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    opt.selected = s === (p.status || 'Not Started');
    statusSelect.appendChild(opt);
  });
  statusSelect.addEventListener('change', async () => {
    const previous = p.status;
    statusSelect.disabled = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: { status: statusSelect.value },
      });
      Object.assign(p, project);
      if (project.status === 'Done') setStageFilter('Completed');
      else if (state.stageFilter === 'Completed') setStageFilter(project.stage || 'Idea Stage');
      else renderProjects();
    } catch (err) {
      statusSelect.value = previous;
      toast(err.message || 'Could not update the status.', 'error');
    } finally {
      statusSelect.disabled = false;
      renderProjects();
    }
  });

  const prioritySelect = document.createElement('select');
  ['Low', 'Medium', 'High'].forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    opt.selected = s === p.priority;
    prioritySelect.appendChild(opt);
  });
  prioritySelect.addEventListener('change', async () => {
    const previous = p.priority;
    prioritySelect.disabled = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: { priority: prioritySelect.value },
      });
      Object.assign(p, project);
    } catch (err) {
      prioritySelect.value = previous;
      toast(err.message || 'Could not update the priority.', 'error');
    } finally {
      prioritySelect.disabled = false;
      renderProjects();
    }
  });

  const date = document.createElement('span');
  date.className = 'pm-date';
  date.textContent = new Date(p.createdAt).toLocaleString();

  meta.append(stageSelect, statusSelect, prioritySelect, date);

  card.append(top);
  if (idea) {
    ideaBlock.append(ideaLabel, ideaText);
    card.append(ideaBlock);
  }
  if (description || !idea) {
    descBlock.append(descLabel, desc);
    card.append(descBlock);
  }
  if (p.referenceMaterial) {
    const details = document.createElement('details');
    details.className = 'pm-reference';
    const summary = document.createElement('summary');
    summary.textContent = 'Reference Material';
    const text = document.createElement('pre');
    text.className = 'pm-reference-text';
    text.textContent = p.referenceMaterial;
    details.append(summary, text);
    card.append(details);
  }
  if (Array.isArray(p.characterReferences) && p.characterReferences.length) {
    const details = document.createElement('details');
    details.className = 'pm-reference';
    const summary = document.createElement('summary');
    summary.textContent = 'Character Reference Material';

    const list = document.createElement('div');
    list.className = 'pm-character-refs';
    p.characterReferences.forEach((item) => {
      const block = document.createElement('div');
      block.className = 'pm-character-ref';
      const heading = document.createElement('div');
      heading.className = 'pm-character-ref-head';
      heading.textContent = `${item.name || 'Character'}${item.gender ? ' · ' + item.gender : ''}`;
      const body = document.createElement('p');
      body.className = 'pm-character-ref-text';
      body.textContent = item.referenceMaterial || '';
      block.append(heading, body);
      list.appendChild(block);
    });

    details.append(summary, list);
    card.append(details);
  }
  if (Array.isArray(p.sceneImages) && p.sceneImages.length) {
    const gallery = document.createElement('div');
    gallery.className = 'pm-images';
    p.sceneImages.forEach((image) => {
      const scene = (p.scenes || []).find((item) => item.id === image.sceneId);
      const link = document.createElement('a');
      link.className = 'pm-image';
      link.href = `/api/image/${encodeURIComponent(p.id)}/${encodeURIComponent(image.file)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = scene ? scene.title : 'Scene image';
      const img = document.createElement('img');
      img.src = link.href;
      img.alt = scene ? `${scene.title} image` : 'Scene image';
      img.loading = 'lazy';
      link.appendChild(img);
      gallery.appendChild(link);
    });
    card.append(gallery);
  }
  card.append(meta);
  return card;
}

// ---------------------------------------------------------------------------
// Reference Stage workspace
// ---------------------------------------------------------------------------
function referenceProjects() {
  return state.projects
    .filter((p) => (p.stage || 'Idea Stage') === 'Reference Stage' && p.status !== 'Done')
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function setReferenceButtons(enabled) {
  $('#ref-save').disabled = !enabled;
  $('#ref-regenerate').disabled = !enabled;
  $('#ref-use-guide').disabled = !enabled;
}

function renderReferenceCharacterMaterial(references) {
  const wrap = $('#ref-character-refs');
  const list = $('#ref-character-ref-list');
  list.innerHTML = '';

  const items = Array.isArray(references)
    ? references.filter((item) => item && item.referenceMaterial)
    : [];

  if (!items.length) {
    wrap.classList.add('hidden');
    return;
  }

  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'character-ref-card';

    const head = document.createElement('div');
    head.className = 'character-ref-head';

    const name = document.createElement('strong');
    name.textContent = item.name || 'Character';

    const gender = document.createElement('span');
    gender.className = 'character-ref-gender';
    gender.textContent = item.gender || '';

    const text = document.createElement('p');
    text.className = 'character-ref-text';
    text.textContent = item.referenceMaterial;

    head.append(name, gender);
    card.append(head, text);
    list.appendChild(card);
  });

  wrap.classList.remove('hidden');
}

function setReferenceOutput(text, hasProject = Boolean(state.reference.projectId)) {
  const output = $('#ref-output');
  const empty = $('#ref-empty');
  output.value = text || '';
  if (hasProject) {
    output.classList.remove('hidden');
    empty.classList.add('hidden');
    output.scrollTop = 0;
  } else {
    output.classList.add('hidden');
    empty.classList.remove('hidden');
  }
}

function selectReferenceProject(id) {
  const project = state.projects.find((p) => p.id === id) || null;
  state.reference.projectId = project ? project.id : null;
  state.reference.chatDraft = null;
  state.reference.dirty = false;
  $('#ref-context').value = project ? project.idea || '' : '';
  setReferenceOutput(project ? project.referenceMaterial || '' : '', Boolean(project));
  renderReferenceCharacterMaterial(project ? project.characterReferences : []);
  setReferenceButtons(Boolean(project));
  $('#ref-project-hint').textContent = project
    ? `Idea loaded from "${project.title}".`
    : 'Choose a project to load its idea as context.';
}

function renderReferenceProjects() {
  const select = $('#ref-project');
  const projects = referenceProjects();
  const previous = state.reference.projectId;
  select.innerHTML = '';

  if (!projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No Reference Stage projects';
    select.appendChild(option);
    select.disabled = true;
    select.value = '';
    $('#ref-open-projects').classList.remove('hidden');
    $('#ref-project-hint').textContent =
      'No projects in Reference Stage yet. Move a project there from Project Management.';
    state.reference.projectId = null;
    state.reference.dirty = false;
    $('#ref-context').value = '';
    setReferenceOutput('', false);
    renderReferenceCharacterMaterial([]);
    setReferenceButtons(false);
    return;
  }

  select.disabled = false;
  projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.title;
    select.appendChild(option);
  });
  $('#ref-open-projects').classList.add('hidden');

  const next = projects.some((p) => p.id === previous) ? previous : projects[0].id;
  select.value = next;
  if (next !== previous) {
    selectReferenceProject(next);
  } else {
    const project = projects.find((p) => p.id === next);
    if (!state.reference.dirty) {
      setReferenceOutput(project ? project.referenceMaterial || '' : '', Boolean(project));
    }
    $('#ref-context').value = project ? project.idea || '' : '';
    $('#ref-project-hint').textContent = project
      ? `Idea loaded from "${project.title}".`
      : 'Choose a project to load its idea as context.';
    renderReferenceCharacterMaterial(project ? project.characterReferences : []);
    setReferenceButtons(Boolean(project));
  }
}

function renderCharacterFields() {
  const wrap = $('#ref-characters');
  wrap.innerHTML = '';

  state.reference.characters.slice(0, state.reference.count).forEach((character, index) => {
    const block = document.createElement('div');
    block.className = 'ref-character';
    block.innerHTML = `
      <div class="ref-character-head">Character ${index + 1}</div>
      <div class="ref-character-row">
        <label class="field">
          <span class="field-label">Name</span>
          <input type="text" data-field="name" maxlength="120" placeholder="Character name" />
        </label>
        <label class="field">
          <span class="field-label">Gender</span>
          <select data-field="gender">
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>
        </label>
      </div>`;

    block.querySelector('[data-field="name"]').value = character.name;

    const genderSelect = block.querySelector('[data-field="gender"]');
    genderSelect.value = character.gender === 'Female' ? 'Female' : 'Male';

    block.querySelectorAll('[data-field]').forEach((input) => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, () => {
        character[input.dataset.field] = input.value;
      });
    });

    wrap.appendChild(block);
  });
}

async function generateReference(replaceWorkspace = false) {
  const projectId = state.reference.projectId;
  if (!projectId) return toast('Select a Reference Stage project first.', 'error');
  if (!state.user) return showAuth();
  if (!hasTextApiKey()) {
    toast('Save the selected text provider API key in Settings first.', 'error');
    switchTab('apis');
    return;
  }

  const model = $('#ref-model').value.trim();
  if (!model) return toast('Choose a model.', 'error');

  const context = $('#ref-context').value.trim();
  const setting = $('#ref-setting').value.trim();
  const characters = state.reference.characters
    .slice(0, state.reference.count)
    .map((c) => ({ ...c }));

  if (characters.some((character) => !character.name.trim())) {
    return toast('Enter a name for each character.', 'error');
  }

  const project = state.projects.find((p) => p.id === projectId);
  const savedReference = (project && project.referenceMaterial ? project.referenceMaterial : '').trim();
  const editedReference = $('#ref-output').value.trim();
  if ((savedReference || editedReference) && !replaceWorkspace) {
    const replace = confirm(
      'Replace the saved reference material, scene outline, character references, and structured Story Workspace drafts with a new generation? Unsaved edits will be lost.'
    );
    if (!replace) return;
  }

  const button = $('#ref-generate');
  button.disabled = true;
  setReferenceButtons(false);
  $('#ref-generate-label').textContent = 'Generating…';
  $('#ref-generating').classList.remove('hidden');
  $('#ref-hint').textContent = 'Calling the selected text model with your saved key — this can take a few seconds.';
  const processId = startProcess('Generating reference material');
  let retryReplaceWorkspace = false;

  try {
    const data = await api('/api/reference', {
      method: 'POST',
      body: { projectId, context, setting, characters, model, replaceWorkspace },
    });

    const updated = data.project;
    const index = state.projects.findIndex((p) => p.id === updated.id);
    if (index >= 0) state.projects[index] = updated;
    if (state.generation.projectId === updated.id) resetGenerationView();

    state.stageFilter = 'Reference Stage';
    renderStageTabs();
    setReferenceOutput(data.referenceMaterial || '', true);
    renderReferenceCharacterMaterial(data.characterReferences || updated.characterReferences || []);
    setReferenceButtons(true);
    state.reference.dirty = false;
    refreshSidebarStory(true);
    const fallbackNote = data.fallback ? ` (${data.model} fallback)` : '';
    const workspaceNote = data.workspace && data.workspace.imported
      ? ' Structured Story Workspace drafts were generated as reviewable drafts — open the Story workspace to review and approve.'
      : '';
    $('#ref-hint').textContent = `Reference material saved to "${updated.title}"${fallbackNote}.${workspaceNote}`;
    toast(
      data.fallback
        ? `Generated with ${data.model} fallback and saved.${workspaceNote}`
        : `Reference material and structured Story Workspace drafts generated and saved.${workspaceNote}`,
      'success'
    );
  } catch (err) {
    if (err.code === 'WORKSPACE_REPLACE_REQUIRED') {
      const replace = confirm(
        'Structured Story Workspace records already exist for this project. Replace them — including any edits or approvals — with the new generation?'
      );
      if (replace) retryReplaceWorkspace = true;
      else {
        $('#ref-hint').textContent = 'Reference generation cancelled. Existing structured records were kept.';
      }
    } else {
      $('#ref-hint').textContent = 'Reference generation failed.';
      if (err.code === 'NO_API_KEY') {
        state.user.hasApiKey = false;
        renderKeyState();
      }
      toast(err.message || 'Something went wrong.', 'error');
    }
  } finally {
    finishProcess(processId);
    button.disabled = false;
    setReferenceButtons(Boolean(state.reference.projectId));
    $('#ref-generate-label').textContent = '✨ Generate reference material';
    $('#ref-generating').classList.add('hidden');
  }

  if (retryReplaceWorkspace) return generateReference(true);
}

async function saveReferenceMaterial() {
  const projectId = state.reference.projectId;
  if (!projectId) return toast('Select a Reference Stage project first.', 'error');

  const button = $('#ref-save');
  button.disabled = true;
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: { referenceMaterial: $('#ref-output').value,
        ...(state.reference.chatDraft ? { characterReferences: state.reference.chatDraft.characters.map((item, index) => ({ ...item,
          name: state.reference.characters[index]?.name || item.name, gender: state.reference.characters[index]?.gender || item.gender })) } : {}) },
    });
    const index = state.projects.findIndex((p) => p.id === project.id);
    if (index >= 0) state.projects[index] = project;
    setReferenceOutput(project.referenceMaterial || '', true);
    renderReferenceCharacterMaterial(project.characterReferences || []);
    setReferenceButtons(true);
    state.reference.dirty = false;
    $('#ref-hint').textContent = `Reference material saved to "${project.title}".`;
    toast('Reference material saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the reference material.', 'error');
  } finally {
    button.disabled = false;
  }
}

$('#ref-project').addEventListener('change', (event) => {
  if (event.target.value) selectReferenceProject(event.target.value);
});

$('#ref-character-count').addEventListener('change', (event) => {
  state.reference.chatDraft = null;
  state.reference.count = Number(event.target.value) || 1;
  renderCharacterFields();
});

$('#ref-open-projects').addEventListener('click', () => {
  setStageFilter('Reference Stage');
  switchTab('projects');
});

$('#ref-generate').addEventListener('click', () => generateReference(false));
$('#ref-save').addEventListener('click', saveReferenceMaterial);
$('#ref-regenerate').addEventListener('click', () => generateReference(false));
$('#ref-use-guide').addEventListener('click', () => {
  if (!state.reference.projectId) {
    toast('Select a Reference Stage project first.', 'error');
    return;
  }
  if (state.chat.busy) {
    toast('The Guide is still replying. Try again in a moment.', 'error');
    return;
  }
  switchChatMode('guide');
  setMobileSidebar(true);
  sendChat({
    prompt: 'Make a refrence, setting and character refrence for both the characters',
    projectId: state.reference.projectId,
    mode: 'guide',
    referenceRequest: true,
  });
});
$('#ref-output').addEventListener('input', () => {
  if (state.reference.projectId) {
    state.reference.dirty = true;
    $('#ref-hint').textContent = 'Unsaved reference edits. Click Save reference to keep them.';
  }
});

// ---------------------------------------------------------------------------
// Generation Stage workspace
//
// Four explicit steps: build image prompts from the shared references, approve
// every prompt, review the prompts against those references, then render every
// image one by one with the character reference sheets attached.
// ---------------------------------------------------------------------------
/** Clear every piece of Generation Stage state for the selected project. */
function resetGenerationView() {
  state.generation.projectId = null;
  state.generation.task = null;
  state.generation.references = null;
  state.generation.draft = null;
  state.generation.edits = {};
  state.generation.runProgress = {};
  state.generation.focusPromptId = null;
  state.generation.error = '';
}

function generationProjects() {
  return state.projects
    .filter((p) => (p.stage || 'Idea Stage') === 'Generation Stage' && p.status !== 'Done')
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function newSceneId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function copyToClipboard(text, label = 'Prompt') {
  if (!text || !text.trim()) return toast('Nothing to copy.', 'error');

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied.`, 'success');
      return;
    }
    throw new Error('Clipboard API unavailable');
  } catch (_) {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.style.position = 'fixed';
    temp.style.left = '-9999px';
    document.body.appendChild(temp);
    temp.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (_) {
      copied = false;
    }
    temp.remove();
    toast(copied ? `${label} copied.` : `Could not copy the ${label.toLowerCase()}.`, copied ? 'success' : 'error');
  }
}

function generationTask() {
  return state.generation.task || null;
}

function generationIsDraft() {
  return Array.isArray(state.generation.draft);
}

function generationPrompts() {
  if (generationIsDraft()) return state.generation.draft;
  const task = generationTask();
  return task && Array.isArray(task.prompts) ? task.prompts : [];
}

function generationStepState() {
  if (generationIsDraft()) {
    return { prompts: false, approvals: false, review: false, images: false, promptCount: state.generation.draft.length, approvedCount: 0, openFlagCount: 0, imageCount: 0 };
  }
  const task = generationTask();
  return (task && task.state) || {
    prompts: false, approvals: false, review: false, images: false,
    promptCount: 0, approvedCount: 0, openFlagCount: 0, imageCount: 0,
  };
}

function generationImageStale(prompt) {
  return Boolean(prompt && prompt.image && prompt.image.prompt !== undefined && prompt.image.prompt !== prompt.prompt);
}

function generationPromptImageUrl(prompt) {
  if (!prompt || !prompt.image || !prompt.image.file || !state.generation.projectId) return '';
  return `/api/image/${encodeURIComponent(state.generation.projectId)}/${encodeURIComponent(prompt.image.file)}`;
}

/** The final character reference sheets that belong to one prompt. */
function generationPromptSheets(prompt) {
  const references = state.generation.references;
  if (!references || !prompt) return [];
  const byName = new Map((references.characters || []).map((character) => [String(character.name).toLowerCase(), character]));
  return (prompt.characters || [])
    .map((name) => byName.get(String(name).toLowerCase()))
    .filter((character) => character && character.sheet);
}

function generationPromptStatus(prompt) {
  const open = (prompt.flags || []).filter((flag) => flag.status === 'open').length;
  if (open) return { label: `${open} flag${open === 1 ? '' : 's'}`, tone: 'failed' };
  if (prompt.image && !generationImageStale(prompt)) return { label: 'Image ready', tone: 'reviewed' };
  if (prompt.image) return { label: 'Image out of date', tone: 'processing' };
  if (prompt.approved) return { label: 'Approved', tone: 'reviewed' };
  return { label: 'Needs approval', tone: 'pending' };
}

function generationBadge(text, tone) {
  const badge = document.createElement('span');
  badge.className = `gen-badge ${tone || ''}`.trim();
  badge.textContent = text;
  return badge;
}

function generationField(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gen-field';
  const name = document.createElement('span');
  name.className = 'gen-field-label';
  name.textContent = label;
  const body = document.createElement('span');
  body.className = 'gen-field-value';
  body.textContent = value;
  wrapper.append(name, body);
  return wrapper;
}

function selectGenerationProject(id) {
  const project = state.projects.find((p) => p.id === id) || null;
  resetGenerationView();
  state.generation.projectId = project ? project.id : null;
  if (project) loadGenerationState(project.id);
  else renderGeneration();
}

async function loadGenerationState(projectId) {
  state.generation.loading = true;
  renderGeneration();
  try {
    const data = await api(`/api/generation/${encodeURIComponent(projectId)}`);
    if (state.generation.projectId !== projectId) return;
    state.generation.task = data.task || null;
    state.generation.references = data.references || null;
    state.generation.imageModel = data.imageModel || '';
    state.generation.imageSizes = Array.isArray(data.imageSizes) ? data.imageSizes : [];
    state.generation.draft = null;
    state.generation.edits = {};
    state.generation.runProgress = {};
  } catch (err) {
    if (state.generation.projectId !== projectId) return;
    state.generation.references = null;
    state.generation.error = err.message || 'Could not load the Generation Stage.';
    toast(state.generation.error, 'error');
  } finally {
    if (state.generation.projectId === projectId) {
      state.generation.loading = false;
      renderGeneration();
    }
  }
}

function renderGenerationProjects() {
  const select = $('#gen-project');
  if (!select) return;
  const projects = generationProjects();
  const previous = state.generation.projectId;
  select.innerHTML = '';

  if (!projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No Generation Stage projects';
    select.appendChild(option);
    select.disabled = true;
    $('#gen-open-projects').classList.remove('hidden');
    resetGenerationView();
    renderGeneration();
    return;
  }

  select.disabled = false;
  projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.title;
    select.appendChild(option);
  });
  $('#gen-open-projects').classList.add('hidden');

  const next = projects.some((p) => p.id === previous) ? previous : projects[0].id;
  select.value = next;
  if (next !== previous) selectGenerationProject(next);
  else if (!state.generation.references || state.generation.error) loadGenerationState(next);
  else renderGeneration();
}

function renderGeneration() {
  const references = state.generation.references;
  const hasProject = Boolean(state.generation.projectId);
  $('#gen-loading').classList.toggle('hidden', !state.generation.loading);
  $('#gen-empty').classList.toggle('hidden', hasProject);
  $('#gen-content').classList.toggle('hidden', !hasProject || !references);
  if (!hasProject || !references) return;
  renderGenerationReferences();
  renderGenerationPrompts();
  renderGenerationReview();
  renderGenerationImages();
}

function renderGenerationReferences() {
  const references = state.generation.references;
  const grid = $('#gen-reference-grid');
  grid.innerHTML = '';

  const sheetNames = (references.characters || [])
    .filter((character) => character.sheet)
    .map((character) => `${character.name} v${character.sheet.version}`);

  grid.append(
    generationField('Character references', references.characters.length
      ? references.characters.map((character) => character.name).join(', ')
      : 'None'),
    generationField('Character reference sheets', sheetNames.length ? sheetNames.join(', ') : 'None'),
    generationField('Action references', `${references.actions.length} image${references.actions.length === 1 ? '' : 's'}`),
    generationField('Location references', `${references.locations.length} location${references.locations.length === 1 ? '' : 's'}`),
  );

  const blockers = $('#gen-reference-blockers');
  blockers.innerHTML = '';
  if (references.blockers.length) {
    const list = document.createElement('ul');
    list.className = 'gen-blockers';
    references.blockers.forEach((blocker) => {
      const item = document.createElement('li');
      item.className = blocker.step === 'build' ? 'build' : 'images';
      item.textContent = `${blocker.step === 'build' ? 'Build' : 'Images'} · ${blocker.message}`;
      list.appendChild(item);
    });
    blockers.appendChild(list);
  }

  $('#gen-reference-status').textContent = references.ready.build
    ? (references.ready.images ? 'Ready' : 'Ready to build')
    : `${references.blockers.filter((blocker) => blocker.step === 'build').length} issue(s)`;
  $('#gen-build').disabled = !references.ready.build || state.generation.building || state.generation.saving;
  $('#gen-build').textContent = state.generation.building ? '✨ Building…' : '✨ Build Image Prompts';
  $('#gen-build-hint').textContent = generationIsDraft()
    ? 'Unsaved prompts are shown below. Save them or generate again.'
    : 'The build writes one image prompt per action reference.';
}

function renderGenerationPrompts() {
  const card = $('#gen-prompts-card');
  const wrap = $('#gen-prompts');
  const prompts = generationPrompts();
  const draft = generationIsDraft();
  card.classList.toggle('hidden', !prompts.length);
  wrap.innerHTML = '';
  if (!prompts.length) return;

  const state$ = generationStepState();
  $('#gen-prompts-status').textContent = draft
    ? 'Unsaved draft'
    : state$.prompts
      ? `${state$.approvedCount}/${state$.promptCount} approved`
      : 'Not saved';
  $('#gen-save-prompts').disabled = !draft || state.generation.saving;
  $('#gen-save-prompts').textContent = state.generation.saving ? '💾 Saving…' : '💾 Save image prompts';
  $('#gen-generate-again').disabled = state.generation.building || state.generation.saving;
  $('#gen-prompt-hint').textContent = draft
    ? 'Review the draft, then save it or generate again.'
    : 'Every prompt needs an explicit approval before the project can be reviewed.';

  prompts.forEach((prompt, index) => {
    const status = generationPromptStatus(prompt);
    const promptCard = document.createElement('div');
    promptCard.className = 'gen-prompt-card';
    promptCard.dataset.promptId = prompt.id;

    const head = document.createElement('div');
    head.className = 'gen-prompt-head';
    const title = document.createElement('span');
    title.className = 'gen-scene-title';
    title.textContent = `Image ${index + 1} · ${prompt.action || 'Untitled action'}`;
    head.append(title, generationBadge(status.label, status.tone));

    const meta = document.createElement('div');
    meta.className = 'gen-prompt-meta';
    const sheets = generationPromptSheets(prompt);
    meta.append(
      generationField('Location', prompt.locationName || prompt.locationSentence || 'Not recorded'),
      generationField('Characters', (prompt.characters || []).join(', ') || 'None'),
      generationField('Reference sheets used', sheets.length
        ? sheets.map((character) => `${character.name} v${character.sheet.version}`).join(', ')
        : 'None'),
    );

    const textarea = document.createElement('textarea');
    textarea.className = 'gen-prompt-text';
    textarea.maxLength = 30000;
    textarea.value = state.generation.edits[prompt.id] !== undefined
      ? state.generation.edits[prompt.id]
      : prompt.prompt;
    textarea.placeholder = 'Image prompt';

    const actions = document.createElement('div');
    actions.className = 'gen-prompt-actions';
    const edited = () => state.generation.edits[prompt.id] !== undefined
      && state.generation.edits[prompt.id] !== prompt.prompt;

    const saveEdit = document.createElement('button');
    saveEdit.type = 'button';
    saveEdit.className = 'btn btn-primary btn-sm';
    saveEdit.textContent = '💾 Save edit';
    saveEdit.addEventListener('click', () => saveGenerationPromptEdit(prompt.id, saveEdit));
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'btn btn-ghost btn-sm';
    discard.textContent = 'Discard edit';
    discard.addEventListener('click', () => {
      delete state.generation.edits[prompt.id];
      renderGeneration();
    });

    // Keep the caret where it is: editing only toggles the edit buttons instead
    // of re-rendering the whole card.
    const syncEditButtons = () => {
      const dirty = edited();
      saveEdit.classList.toggle('hidden', !dirty);
      discard.classList.toggle('hidden', !dirty);
      const hint = promptCard.querySelector('.gen-edit-hint');
      if (hint) hint.classList.toggle('hidden', !dirty);
    };
    textarea.addEventListener('input', () => {
      state.generation.edits[prompt.id] = textarea.value;
      syncEditButtons();
    });

    if (draft) {
      actions.appendChild(generationBadge('Draft — save to approve', 'pending'));
    } else {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'btn btn-sm ' + (prompt.approved ? 'btn-secondary' : 'btn-primary');
      approve.textContent = prompt.approved ? '↩ Unapprove' : '✓ Approve';
      approve.addEventListener('click', () => setGenerationApproval(prompt.id, !prompt.approved, approve));
      actions.appendChild(approve);
    }

    if (!draft) {
      actions.append(saveEdit, discard);
    }

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-ghost btn-sm';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyToClipboard(
      state.generation.edits[prompt.id] !== undefined ? state.generation.edits[prompt.id] : prompt.prompt,
      'Image prompt'
    ));
    actions.appendChild(copy);

    const editHint = document.createElement('span');
    editHint.className = 'hint gen-edit-hint';
    editHint.textContent = 'Saving an edit clears this prompt\'s approval.';

    promptCard.append(head, meta, textarea, actions, editHint);

    const openFlags = (prompt.flags || []).filter((flag) => flag.status === 'open');
    if (!draft && openFlags.length) {
      const flagBox = document.createElement('div');
      flagBox.className = 'gen-prompt-flags';
      openFlags.forEach((flag) => flagBox.appendChild(generationFlagRow(prompt.id, flag)));
      promptCard.appendChild(flagBox);
    }

    const url = generationPromptImageUrl(prompt);
    if (url) {
      const figure = document.createElement('figure');
      figure.className = 'gen-image';
      const img = document.createElement('img');
      img.src = url;
      img.alt = `Image ${index + 1}`;
      img.loading = 'lazy';
      const caption = document.createElement('figcaption');
      const download = document.createElement('a');
      download.className = 'btn btn-ghost btn-sm';
      download.href = url;
      download.download = `image-${index + 1}.${(prompt.image.file.split('.').pop() || 'png')}`;
      download.textContent = '⬇ Download image';
      caption.appendChild(download);
      if (generationImageStale(prompt)) caption.appendChild(generationBadge('From an earlier prompt', 'processing'));
      figure.append(img, caption);
      promptCard.appendChild(figure);
    }

    syncEditButtons();
    wrap.appendChild(promptCard);
  });

  const focusId = state.generation.focusPromptId;
  if (focusId) {
    state.generation.focusPromptId = null;
    const target = wrap.querySelector(`[data-prompt-id="${CSS.escape(focusId)}"] .gen-prompt-text`);
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'center' });
    }
  }
}

function generationFlagRow(promptId, flag) {
  const row = document.createElement('div');
  row.className = `gen-flag ${flag.severity || 'warning'}`;
  const message = document.createElement('p');
  message.className = 'gen-flag-message';
  message.textContent = flag.message;
  const actions = document.createElement('div');
  actions.className = 'gen-flag-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-secondary btn-sm';
  edit.textContent = '✎ Edit prompt';
  edit.addEventListener('click', () => {
    state.generation.focusPromptId = promptId;
    renderGenerationPrompts();
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn btn-ghost btn-sm';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => dismissGenerationFlag(promptId, flag.id, dismiss));

  actions.append(edit, dismiss);
  row.append(generationBadge(flag.severity || 'warning', flag.severity === 'error' ? 'failed' : 'pending'), message, actions);
  return row;
}

function renderGenerationReview() {
  const card = $('#gen-review-card');
  const task = generationTask();
  const prompts = generationPrompts();
  const draft = generationIsDraft();
  const state$ = generationStepState();
  card.classList.toggle('hidden', draft || !prompts.length);
  if (draft || !prompts.length) return;

  const openFlags = [];
  prompts.forEach((prompt) => {
    (prompt.flags || []).forEach((flag) => {
      if (flag.status === 'open') openFlags.push({ prompt, flag });
    });
  });

  const resolved = prompts.reduce((total, prompt) => total + (prompt.flags || []).filter((flag) => flag.status !== 'open').length, 0);
  $('#gen-review-status').textContent = !state$.approvals
    ? 'Waiting for approvals'
    : !task.reviewedAt
      ? 'Not reviewed'
      : openFlags.length
        ? `${openFlags.length} open flag(s)`
        : 'Reviewed';

  const review = $('#gen-review');
  review.disabled = !state$.approvals || state.generation.reviewing;
  review.textContent = state.generation.reviewing ? '🔎 Reviewing…' : task.reviewedAt ? '🔎 Review again' : '🔎 Review the prompts';

  $('#gen-review-hint').textContent = !state$.approvals
    ? 'Approve every image prompt first.'
    : task.reviewedAt
      ? `Reviewed ${new Date(task.reviewedAt).toLocaleString()}${task.reviewedBy ? ` · ${task.reviewedBy}` : ''}${resolved ? ` · ${resolved} resolved` : ''}.`
      : 'The reviewer checks every image prompt against the references.';

  const wrap = $('#gen-flags');
  wrap.innerHTML = '';
  if (!task.reviewedAt) return;

  if (!openFlags.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No inconsistencies between the image prompts and the references.';
    wrap.appendChild(empty);
    return;
  }

  openFlags.forEach(({ prompt, flag }) => {
    const block = document.createElement('div');
    block.className = 'gen-flag-block';
    const heading = document.createElement('strong');
    heading.textContent = `Image ${prompt.index + 1} · ${prompt.action || 'Untitled action'}`;
    block.append(heading, generationFlagRow(prompt.id, flag));
    wrap.appendChild(block);
  });
}

function renderGenerationImages() {
  const card = $('#gen-images-card');
  const task = generationTask();
  const prompts = generationPrompts();
  const draft = generationIsDraft();
  const state$ = generationStepState();
  card.classList.toggle('hidden', draft || !prompts.length);
  if (draft || !prompts.length) return;

  const missing = prompts.filter((prompt) => !prompt.image || generationImageStale(prompt)).length;
  $('#gen-images-status').textContent = `${state$.imageCount}/${state$.promptCount} images`;
  const run = $('#gen-run-images');
  run.disabled = !state$.review || state.generation.running;
  run.textContent = state.generation.running ? '🖼 Generating…' : '🖼 Run image generation process';
  $('#gen-images-hint').textContent = !state$.review
    ? 'Approve every prompt and finish the project review first.'
    : missing
      ? `${missing} image(s) still to generate.`
      : 'Every image is generated.';

  const wrap = $('#gen-image-progress');
  wrap.innerHTML = '';
  prompts.forEach((prompt, index) => {
    const progress = state.generation.runProgress[prompt.id];
    const row = document.createElement('div');
    row.className = 'gen-image-row';

    const url = generationPromptImageUrl(prompt);
    if (url) {
      const img = document.createElement('img');
      img.className = 'gen-image-thumb';
      img.src = url;
      img.alt = `Image ${index + 1}`;
      img.loading = 'lazy';
      row.appendChild(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'gen-image-thumb placeholder';
      placeholder.textContent = '🖼';
      row.appendChild(placeholder);
    }

    const body = document.createElement('div');
    body.className = 'gen-image-body';
    const title = document.createElement('strong');
    title.textContent = `Image ${index + 1} · ${prompt.action || 'Untitled action'}`;
    const sheets = generationPromptSheets(prompt);
    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = sheets.length
      ? `References: ${sheets.map((character) => `${character.name} v${character.sheet.version}`).join(', ')}`
      : 'No character reference sheet available.';
    body.append(title, meta);

    let label = prompt.image ? 'Out of date' : 'Not generated';
    let tone = prompt.image ? 'processing' : 'pending';
    if (prompt.image && !generationImageStale(prompt)) { label = 'Done'; tone = 'reviewed'; }
    if (progress === 'running') { label = 'Generating…'; tone = 'processing'; }
    if (progress === 'failed') { label = 'Failed'; tone = 'failed'; }
    body.appendChild(generationBadge(label, tone));
    const error = state.generation.runProgress[`${prompt.id}:error`];
    if (error) {
      const detail = document.createElement('span');
      detail.className = 'gen-image-error';
      detail.textContent = error;
      body.appendChild(detail);
    }

    row.appendChild(body);
    wrap.appendChild(row);
  });
}

async function buildGenerationPrompts() {
  const projectId = state.generation.projectId;
  if (!projectId) return toast('Select a Generation Stage project first.', 'error');
  if (!state.user) return showAuth();
  const references = state.generation.references;
  if (references && !references.ready.build) {
    const blocker = references.blockers.find((item) => item.step === 'build');
    return toast(blocker ? blocker.message : 'The references are incomplete.', 'error');
  }

  const model = $('#gen-model').value.trim();
  if (!model) return toast('Choose a model.', 'error');

  state.generation.building = true;
  renderGenerationReferences();
  renderGenerationPrompts();
  const processId = startProcess('Building image prompts');
  try {
    const data = await api('/api/generation/build', {
      method: 'POST',
      body: { projectId, model },
    });
    if (state.generation.projectId !== projectId) return;
    state.generation.draft = (data.prompts || []).map((prompt, index) => ({
      id: newSceneId(),
      index,
      sceneId: '',
      action: prompt.action || '',
      locationSentence: prompt.locationSentence || '',
      characters: prompt.characters || [],
      locationName: prompt.locationName || '',
      locationDescription: prompt.locationDescription || '',
      prompt: prompt.prompt || '',
      approved: false,
      approvedAt: '',
      flags: [],
      image: null,
    }));
    state.generation.edits = {};
    const fallbackNote = data.fallback ? ` (${data.model} fallback)` : '';
    toast(`Built ${state.generation.draft.length} image prompt(s)${fallbackNote}. Save them or generate again.`, 'success');
  } catch (err) {
    if (err.code === 'NO_API_KEY') {
      state.user.hasApiKey = false;
      renderKeyState();
    }
    toast(err.message || 'Could not build the image prompts.', 'error');
  } finally {
    finishProcess(processId);
    state.generation.building = false;
    renderGeneration();
  }
}

async function saveGenerationPrompts() {
  const projectId = state.generation.projectId;
  if (!projectId) return toast('Select a Generation Stage project first.', 'error');
  if (!generationIsDraft()) return;

  const prompts = state.generation.draft.map((prompt) => ({
    id: prompt.id,
    index: prompt.index,
    action: prompt.action,
    locationSentence: prompt.locationSentence,
    characters: prompt.characters,
    locationName: prompt.locationName,
    locationDescription: prompt.locationDescription,
    prompt: state.generation.edits[prompt.id] !== undefined ? state.generation.edits[prompt.id] : prompt.prompt,
  }));

  state.generation.saving = true;
  renderGenerationReferences();
  renderGenerationPrompts();
  const processId = startProcess('Saving image prompts');
  try {
    const data = await api(`/api/generation/${encodeURIComponent(projectId)}/prompts`, {
      method: 'PUT',
      body: { prompts },
    });
    if (state.generation.projectId !== projectId) return;
    state.generation.task = data.task;
    state.generation.draft = null;
    state.generation.edits = {};
    refreshGenerationProject(data.project);
    toast('Image prompts saved. Approve each one to continue.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the image prompts.', 'error');
  } finally {
    finishProcess(processId);
    state.generation.saving = false;
    renderGeneration();
  }
}

async function saveGenerationPromptEdit(promptId, button) {
  const projectId = state.generation.projectId;
  if (!projectId) return;
  const text = state.generation.edits[promptId];
  if (text === undefined) return;
  button.disabled = true;
  try {
    const data = await api(`/api/generation/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(promptId)}`, {
      method: 'PUT',
      body: { prompt: text },
    });
    state.generation.task = data.task;
    delete state.generation.edits[promptId];
    toast('Image prompt updated. It needs approval again.', 'success');
    renderGeneration();
  } catch (err) {
    button.disabled = false;
    toast(err.message || 'Could not update the image prompt.', 'error');
  }
}

async function setGenerationApproval(promptId, approved, button) {
  const projectId = state.generation.projectId;
  if (!projectId) return;
  button.disabled = true;
  try {
    const data = await api(`/api/generation/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(promptId)}/approval`, {
      method: 'POST',
      body: { approved },
    });
    state.generation.task = data.task;
    renderGeneration();
  } catch (err) {
    button.disabled = false;
    toast(err.message || 'Could not update the approval.', 'error');
  }
}

async function dismissGenerationFlag(promptId, flagId, button) {
  const projectId = state.generation.projectId;
  if (!projectId) return;
  button.disabled = true;
  try {
    const data = await api(
      `/api/generation/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(promptId)}/flags/${encodeURIComponent(flagId)}`,
      { method: 'POST', body: { status: 'dismissed' } }
    );
    state.generation.task = data.task;
    renderGeneration();
  } catch (err) {
    button.disabled = false;
    toast(err.message || 'Could not dismiss the flag.', 'error');
  }
}

async function reviewGenerationProject() {
  const projectId = state.generation.projectId;
  if (!projectId) return toast('Select a Generation Stage project first.', 'error');
  const state$ = generationStepState();
  if (!state$.approvals) return toast('Approve every image prompt first.', 'error');

  state.generation.reviewing = true;
  renderGenerationReview();
  const processId = startProcess('Reviewing the project');
  try {
    const data = await api('/api/generation/review', { method: 'POST', body: { projectId } });
    state.generation.task = data.task;
    const count = data.review ? data.review.flagCount : 0;
    toast(count
      ? `Review finished with ${count} flag(s). Edit or dismiss each one.`
      : 'Review finished with no inconsistencies.', count ? '' : 'success');
  } catch (err) {
    toast(err.message || 'Could not review the prompts.', 'error');
  } finally {
    finishProcess(processId);
    state.generation.reviewing = false;
    renderGeneration();
  }
}

async function runGenerationImages() {
  const projectId = state.generation.projectId;
  if (!projectId) return toast('Select a Generation Stage project first.', 'error');
  if (generationIsDraft()) return toast('Save the image prompts first.', 'error');
  if (!state.user) return showAuth();
  if (!hasImageApiKey()) {
    toast(`Save your ${imageProviderLabel()} API key in Settings to generate images.`, 'error');
    switchTab('apis');
    $(imageKeySelector()).focus();
    return;
  }

  const state$ = generationStepState();
  if (!state$.review) {
    return toast('Approve every image prompt and finish the project review first.', 'error');
  }

  const size = $('#gen-image-size').value;
  const prompts = generationPrompts().slice();
  const targets = prompts.filter((prompt) => !prompt.image || generationImageStale(prompt));
  if (!targets.length) return toast('Every image is already generated.', 'success');

  state.generation.running = true;
  state.generation.runProgress = {};
  targets.forEach((prompt) => { state.generation.runProgress[prompt.id] = 'waiting'; });
  renderGenerationImages();

  const processId = startProcess('Running image generation process');
  let failed = 0;
  for (const prompt of targets) {
    state.generation.runProgress[prompt.id] = 'running';
    renderGenerationImages();
    try {
      const data = await api('/api/generation/images/one', {
        method: 'POST',
        body: { projectId, promptId: prompt.id, size },
      });
      state.generation.task = data.task;
      state.generation.runProgress[prompt.id] = 'done';
      refreshGenerationProject(data.project);
      updateProcess(processId, `Image ${prompt.index + 1} of ${targets.length} generated`);
    } catch (err) {
      state.generation.runProgress[prompt.id] = 'failed';
      state.generation.runProgress[`${prompt.id}:error`] = err.message || 'Image generation failed.';
      failed += 1;
      if (['NO_IMAGEGEN_KEY', 'NO_OPENAI_IMAGE_KEY', 'NO_DIRECT_OPENAI_KEY'].includes(err.code)) {
        handleMissingImageKey(err);
        switchTab('apis');
        $(imageKeySelector()).focus();
      } else if (err.code === 'INVALID_IMAGEGEN_KEY' || err.code === 'IMAGEGEN_KEY_UNREADABLE') {
        switchTab('apis');
        $(imageKeySelector()).focus();
      }
      toast(err.message || 'Image generation failed.', 'error');
      break;
    }
    renderGenerationImages();
  }

  finishProcess(processId);
  state.generation.running = false;
  renderGeneration();
  if (!failed) toast('Every image was generated and filed into the project and the Library.', 'success');
}

function refreshGenerationProject(project) {
  if (!project) return;
  const index = state.projects.findIndex((p) => p.id === project.id);
  if (index >= 0) state.projects[index] = project;
}

$('#gen-project').addEventListener('change', (event) => {
  if (event.target.value) selectGenerationProject(event.target.value);
});
$('#gen-build').addEventListener('click', buildGenerationPrompts);
$('#gen-generate-again').addEventListener('click', buildGenerationPrompts);
$('#gen-save-prompts').addEventListener('click', saveGenerationPrompts);
$('#gen-review').addEventListener('click', reviewGenerationProject);
$('#gen-run-images').addEventListener('click', runGenerationImages);

$('#gen-open-projects').addEventListener('click', () => {
  setStageFilter('Generation Stage');
  switchTab('projects');
});

function openModal(id) {
  state.editingId = id || null;
  const p = id ? state.projects.find((x) => x.id === id) : null;
  $('#modal-title').textContent = p ? 'Edit project' : 'New project';
  $('#pm-title').value = p ? p.title : '';
  $('#pm-idea').value = p ? p.idea || '' : '';
  $('#pm-description').value = p ? p.description : '';
  $('#pm-reference').value = p ? p.referenceMaterial || '' : '';
  $('#pm-stage').value = p ? p.stage || 'Idea Stage' : 'Idea Stage';
  $('#pm-status').value = p ? p.status || 'Not Started' : 'Not Started';
  $('#pm-priority').value = p ? p.priority : 'Medium';
  $('#modal').classList.remove('hidden');
  $('#pm-title').focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.editingId = null;
}

async function saveModal() {
  const title = $('#pm-title').value.trim();
  if (!title) return toast('Title is required.', 'error');

  const data = {
    title,
    idea: $('#pm-idea').value.trim(),
    description: $('#pm-description').value.trim(),
    referenceMaterial: $('#pm-reference').value.trim(),
    stage: $('#pm-stage').value,
    status: $('#pm-status').value,
    priority: $('#pm-priority').value,
  };

  const button = $('#modal-save');
  button.disabled = true;
  try {
    let saved;
    if (state.editingId) {
      const { project } = await api(`/api/projects/${encodeURIComponent(state.editingId)}`, {
        method: 'PUT',
        body: data,
      });
      const index = state.projects.findIndex((x) => x.id === project.id);
      if (index >= 0) state.projects[index] = project;
      saved = project;
    } else {
      const { project } = await api('/api/projects', {
        method: 'POST',
        body: { ...data, source: 'manual' },
      });
      state.projects.push(project);
      saved = project;
    }
    state.stageFilter = saved.status === 'Done' ? 'Completed' : (saved.stage || state.stageFilter);
    if (saved.status === 'Done') setStageFilter('Completed');
    else if (state.stageFilter === 'Completed') setStageFilter(saved.stage || 'Idea Stage');
    else setStageFilter(saved.stage || state.stageFilter);
    closeModal();
    renderProjects();
    toast('Project saved.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the project.', 'error');
  } finally {
    button.disabled = false;
  }
}

$('#new-project-btn').addEventListener('click', () => {
  openModal(null);
  const defaultStage = state.stageFilter === 'Generation Stage'
    ? 'Reference Stage'
    : state.stageFilter === 'Completed'
      ? 'Idea Stage'
      : state.stageFilter;
  $('#pm-stage').value = defaultStage;
});
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-save').addEventListener('click', saveModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
});

// ---------------------------------------------------------------------------
// PM filters + export
// ---------------------------------------------------------------------------
$('#pm-search').addEventListener('input', renderProjects);
$('#pm-filter').addEventListener('change', renderProjects);

$('#pm-export-btn').addEventListener('click', () => {
  if (!state.projects.length) return toast('No projects to export.', 'error');
  const lines = state.projects.map((p) => {
    const out = [`[${p.stage || 'Idea Stage'}] [${p.status}] (${p.priority}) ${p.title}`];
    if (p.idea) out.push(`    Idea: ${p.idea}`);
    if (p.description) out.push(`    Description: ${p.description}`);
    if (p.referenceMaterial) out.push(`    Reference Material:\n${p.referenceMaterial}`);
    if (Array.isArray(p.characterReferences) && p.characterReferences.length) {
      p.characterReferences.forEach((item) => {
        out.push(`    Character Reference — ${item.name || 'Character'} (${item.gender || ''}):\n${item.referenceMaterial || ''}`);
      });
    }
    return out.join('\n');
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`projects-${stamp}.txt`, lines.join('\n\n') + '\n');
  toast('Exported ' + state.projects.length + ' project(s).', 'success');
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// The pre-accounts version kept the DeepSeek key in plaintext localStorage.
// It is no longer used; remove it so the secret does not linger in the browser.
try {
  localStorage.removeItem('projectWorkflow.apiKey');
} catch (_) { /* ignore */ }

renderStageTabs();
renderCharacterFields();
renderReferenceProjects();
renderStoryProjects();
renderGenerationProjects();
renderIdeas();
renderProjects();
renderChat();

try {
  const lastTab = localStorage.getItem(AUTH_TAB_KEY);
  if (lastTab === 'register') setAuthMode('register');
} catch (_) { /* ignore */ }

initAuth();
