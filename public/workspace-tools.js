'use strict';
const WORKSPACE_PROVIDERS = { deepseek: 'DeepSeek', 'openai-direct': 'OpenAI', openai: 'OpenAI-compatible', anthropic: 'Anthropic' };
let workspaceUserId = '', workspaceHistoryPromise = null, workspaceHistoryReady = false;
let workspaceChatImages = [], workspaceUploading = false, workspaceModels = [], workspaceChatModelDirty = false;

function hasTextApiKey() {
  const user = state.user; if (!user) return false;
  return Boolean(({ deepseek: user.hasApiKey, 'openai-direct': user.hasDirectOpenAIKey, openai: user.hasOpenAIKey, anthropic: user.hasAnthropicKey })[user.textProvider || 'deepseek']);
}
function workspaceReset() {
  workspaceUserId = ''; workspaceHistoryPromise = null; workspaceHistoryReady = false;
  workspaceChatImages = []; workspaceModels = []; workspaceChatModelDirty = false; state.library.section = 'all'; state.reference.chatDraft = null;
  ['#chat-attachments','#prompt-analysis-output','#drive-files'].forEach(id => $(id).replaceChildren());
  $('#library-image-content').classList.remove('hidden'); $('#library-analysis').classList.add('hidden'); $('#library-drive').classList.add('hidden');
  $('#character-mode').value = 'sheet';
}
async function ensureChatHistory() {
  if (!state.user || workspaceHistoryReady) return;
  if (workspaceHistoryPromise) return workspaceHistoryPromise;
  const owner = state.user.id;
  workspaceHistoryPromise = (async () => {
    try { const data = await api('/api/chat/history'); if (state.user?.id !== owner) return;
      state.chat.guide = data.guide || []; state.chat.reviewer = data.reviewer || []; workspaceHistoryReady = true; renderChat();
    } catch (error) { if (state.user?.id === owner) $('#chat-hint').textContent = 'History could not load. It is still saved; try again when connected.'; throw error; }
    finally { if (state.user?.id === owner) workspaceHistoryPromise = null; }
  })();
  return workspaceHistoryPromise;
}
function fillProviderOptions(select, selected) {
  if (!select.options.length) Object.entries(WORKSPACE_PROVIDERS).forEach(([id,label]) => { const option = document.createElement('option'); option.value = id; option.textContent = label; select.appendChild(option); });
  select.value = selected || 'deepseek';
}
function fillModels(list, provider) {
  list.replaceChildren();
  const rows = workspaceModels.find(item => item.provider === provider)?.models || CARNIVAL_CHAT_MODELS.seeds[provider].map(id => ({ id, vision: CARNIVAL_CHAT_MODELS.vision(provider,id) }));
  rows.forEach(model => { const option = document.createElement('option'); option.value = model.id; option.label = model.vision ? `${model.id} · image input` : model.id; list.appendChild(option); });
}
function renderWorkspaceModels() {
  if (!state.user) return;
  const provider = state.user.textProvider || 'deepseek';
  fillProviderOptions($('#global-text-provider'),provider); fillProviderOptions($('#text-provider-pref'),provider);
  $('#global-text-model').value = currentTextModel(); $('#global-text-label').textContent = `${WORKSPACE_PROVIDERS[provider]} · ${currentTextModel()}`;
  fillModels($('#all-chat-model-options'),provider);
  ['#model','#ref-model','#gen-model','#text-model-pref'].forEach(id => $(id)?.setAttribute('list','all-chat-model-options'));
  ['guide','reviewer'].forEach(mode => { $(`#${mode}-model`).setAttribute('list',`${mode}-model-options`); fillModels($(`#${mode}-model-options`),$(`#${mode}-provider`).value || 'deepseek'); });
  renderWorkspaceChat();
}
function chatVisionSupport() {
  const mode = state.chat.mode === 'reviewer' ? 'reviewer' : 'guide';
  const provider = state.user?.[`${mode}Provider`] || 'deepseek'; const model = state.user?.[`${mode}Model`] || state.user?.[`${mode}DefaultModel`] || CARNIVAL_CHAT_MODELS.defaults[provider];
  const saved = workspaceModels.find(item => item.provider === provider)?.models.find(item => item.id === model);
  return saved ? saved.vision : CARNIVAL_CHAT_MODELS.vision(provider,model);
}
function renderWorkspaceChat() {
  if (!state.user) return;
  const mode = state.chat.mode === 'reviewer' ? 'reviewer' : 'guide'; const provider = state.user[`${mode}Provider`] || 'deepseek'; const model = state.user[`${mode}Model`] || state.user[`${mode}DefaultModel`] || CARNIVAL_CHAT_MODELS.defaults[provider];
  if (!workspaceChatModelDirty) { fillProviderOptions($('#chat-provider'),provider); $('#chat-model').value = model; fillModels($('#chat-model-options'),provider); }
  $('#chat-model-summary').textContent = `${WORKSPACE_PROVIDERS[provider]} · ${model}`;
  const vision = chatVisionSupport();
  $('#chat-add-images').disabled = !vision || state.chat.busy || workspaceUploading;
  $('#chat-add-images').title = vision ? 'Attach up to 4 images, 4 MB each' : 'Choose a model with confirmed image-input support';
  $('#chat-clear-history').disabled = state.chat.busy; $('#chat-save-model').disabled = state.chat.busy;
  $('#chat-send').disabled = state.chat.busy || workspaceUploading || workspaceChatImages.length > 0 && !vision;
  $('#chat-hint').textContent = vision ? 'History saved to your account. Image input supported.' : 'History saved to your account. Select a vision model to add images.';
  const list = $('#chat-attachments'); list.replaceChildren();
  workspaceChatImages.forEach(image => { const chip = document.createElement('div'); const preview = document.createElement('img'); preview.src = image.url; preview.alt = image.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm'; remove.textContent = 'Remove'; remove.disabled = state.chat.busy;
    remove.addEventListener('click',() => { workspaceChatImages = workspaceChatImages.filter(item => item.id !== image.id); renderWorkspaceChat(); }); chip.append(preview,remove); list.appendChild(chip); });
}
async function loadWorkspaceModels(refresh = false) {
  const owner = state.user?.id; if (!owner) return; $('#model-discovery-status').textContent = 'Loading model lists…';
  try { const data = await api(`/api/chat/models${refresh ? '?refresh=1' : ''}`); if (state.user?.id !== owner) return; workspaceModels = data.providers || []; renderWorkspaceModels();
    $('#model-discovery-status').textContent = `${workspaceModels.reduce((total,item) => total + item.models.length,0)} choices. You can also enter a model ID.`;
  } catch { if (state.user?.id === owner) $('#model-discovery-status').textContent = 'Could not refresh lists. Saved models remain available.'; }
}
function referenceChatInputs() { return { context: $('#ref-context').value, setting: $('#ref-setting').value, characters: state.reference.characters || [], referenceMaterial: $('#ref-output').value }; }
function applyReferenceChatDraft(draft,projectId) {
  if (!state.user || !state.projects.some(project => project.id === projectId)) return;
  if (state.reference.projectId !== projectId) selectReferenceProject(projectId);
  state.reference.chatDraft = draft; state.reference.count = draft.characters.length; $('#ref-character-count').value = String(draft.characters.length);
  state.reference.characters = draft.characters.map(item => ({ name: item.name, gender: item.gender })); renderCharacterFields(); $('#ref-setting').value = draft.setting;
  setReferenceOutput(`${draft.referenceMaterial}\n\nSetting:\n${draft.setting}`,true); renderReferenceCharacterMaterial(draft.characters); state.reference.dirty = true; setReferenceButtons(true);
  $('#ref-hint').textContent = 'CarniChat filled all reference fields. Review the suggestions, then Save reference.';
}
function setLibrarySection(section) {
  state.library.section = section;
  $('#library-image-content').classList.toggle('hidden',section === 'analysis' || section === 'drive'); $('#library-analysis').classList.toggle('hidden',section !== 'analysis'); $('#library-drive').classList.toggle('hidden',section !== 'drive');
  $$('[data-library-section]').forEach(button => { const active = button.dataset.librarySection === section; button.classList.toggle('btn-secondary',active); button.classList.toggle('btn-ghost',!active); button.setAttribute('aria-current',active ? 'page' : 'false'); });
  if (section === 'sheets') { state.library.filters.projectId = ''; state.library.filters.episodeId = ''; loadLibrary(true); } else if (section === 'all') renderLibrary(); else if (section === 'drive') loadDriveStatus();
}
function analysisTable(title,rows) {
  const group = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = title; group.appendChild(heading);
  if (!rows.length) { const note = document.createElement('p'); note.textContent = 'No repeated patterns yet. Record decisions on more prompts or images to compare.'; group.appendChild(note); return group; }
  const table = document.createElement('table'); table.className = 'analysis-table'; const head = document.createElement('tr');
  ['Shared phrase','This group','Other group','Examples'].forEach(label => { const th = document.createElement('th'); th.textContent = label; head.appendChild(th); }); table.appendChild(head);
  rows.forEach(row => { const tr = document.createElement('tr'); [row.term,`${row.count} · ${Math.round(row.rate*100)}%`,`${row.otherCount} · ${Math.round(row.otherRate*100)}%`,row.examples.map(item => `${item.title} (${item.decision})`).join('; ')].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); }); table.appendChild(tr); }); group.appendChild(table); return group;
}
async function analyzeWorkspacePrompts() {
  const output = $('#prompt-analysis-output'); output.textContent = 'Comparing recorded decisions…'; const owner = state.user?.id; const button = $('#analyze-prompts'); button.disabled = true;
  try { const data = await api('/api/library/prompt-analysis'); if (state.user?.id !== owner) return; output.replaceChildren(); const summary = document.createElement('p');
    summary.textContent = `${data.counts.approved} approved · ${data.counts.unapproved} with unapproved decisions · ${data.counts.pending} awaiting review. ${data.note}`; output.append(summary,analysisTable('Patterns in approved prompts',data.approvedPatterns),analysisTable('Patterns in unapproved prompts',data.unapprovedPatterns));
    const heading = document.createElement('h3'); heading.textContent = 'Similar reviewed prompts'; output.appendChild(heading);
    data.similarPrompts.forEach(pair => { const p = document.createElement('p'); p.textContent = `${Math.round(pair.similarity*100)}% shared terms: ${pair.a.title} (${pair.a.decision}) ↔ ${pair.b.title} (${pair.b.decision})`; output.appendChild(p); });
    const label = document.createElement('label'); label.className = 'field'; label.textContent = 'Prompt to improve'; const input = document.createElement('textarea'); input.rows = 4; input.maxLength = 12000; input.id = 'analysis-prompt'; label.appendChild(input); output.appendChild(label);
    const improve = document.createElement('button'); improve.className = 'btn btn-secondary'; improve.type = 'button'; improve.textContent = 'Ask CarniChat to improve this prompt';
    improve.addEventListener('click',() => { if (!input.value.trim()) return toast('Paste a prompt to improve.','error'); switchChatMode('guide'); setMobileSidebar(true); sendChat({ prompt: `Suggest an improved prompt using these observed correlations, never approval guarantees. Do not change saved work or claim approval.\nApproved patterns: ${JSON.stringify(data.approvedPatterns.slice(0,6))}\nUnapproved patterns: ${JSON.stringify(data.unapprovedPatterns.slice(0,6))}\nPrompt: ${input.value}` }); }); output.appendChild(improve);
  } catch (error) { output.textContent = error.message || 'Could not analyze prompts.'; } finally { button.disabled = false; }
}
async function loadDriveStatus() {
  const owner = state.user?.id; if (!owner) return;
  try { const data = await api('/api/drive/status'); if (state.user?.id !== owner) return;
    $('#drive-status').textContent = data.connected ? 'Drive connected. Save images and prompt information from Library image details.' : data.configured ? 'Connect Google to save or import Carnival files.' : 'Google Drive requires server OAuth setup. Open Connection setup below.';
    $('#drive-connect').classList.toggle('hidden',data.connected); $('#drive-disconnect').classList.toggle('hidden',!data.connected); $('#drive-list').disabled = !data.connected;
    $('#drive-connect').textContent = data.configured ? 'Connect Google Drive' : 'Set up Google Drive'; $('#drive-connect').dataset.configured = String(data.configured);
  } catch (error) { $('#drive-status').textContent = error.message; }
}
function workspaceStarted() {
  if (!state.user) return;
  if (workspaceUserId === state.user.id && (workspaceHistoryPromise || workspaceHistoryReady)) { renderWorkspaceModels(); return; }
  if (workspaceUserId !== state.user.id) { workspaceHistoryReady = false; workspaceHistoryPromise = null; workspaceModels = []; workspaceChatImages = []; workspaceUserId = state.user.id; workspaceChatModelDirty = false; }
  renderWorkspaceModels(); ensureChatHistory().catch(() => {}); loadWorkspaceModels(); loadDriveStatus();
  const params = new URL(location.href).searchParams;
  if (params.has('drive')) { switchScreen('library'); setLibrarySection('drive'); if (params.get('drive') === 'error') toast('Drive connection was not completed. Check setup and connect again.','error'); history.replaceState(null,'',location.pathname); }
}
$('#chat-provider').addEventListener('change',() => { workspaceChatModelDirty = true; const provider = $('#chat-provider').value; $('#chat-model').value = CARNIVAL_CHAT_MODELS.defaults[provider]; fillModels($('#chat-model-options'),provider); });
$('#chat-model').addEventListener('input',() => { workspaceChatModelDirty = true; });
$('#chat-save-model').addEventListener('click',async () => { const mode = state.chat.mode; try { const {user} = await api('/api/me/chat-settings',{method:'PUT',body:{[`${mode}Provider`]:$('#chat-provider').value,[`${mode}Model`]:$('#chat-model').value.trim()}}); state.user = user; workspaceChatModelDirty = false; applyChatSettings(); renderChat(); } catch (error) { toast(error.message,'error'); } });
$('#global-text-provider').addEventListener('change',() => { const provider = $('#global-text-provider').value; $('#global-text-model').value = CARNIVAL_CHAT_MODELS.defaults[provider]; fillModels($('#all-chat-model-options'),provider); });
$('#text-provider-pref').addEventListener('change',() => { const provider = $('#text-provider-pref').value; $('#text-model-pref').value = CARNIVAL_CHAT_MODELS.defaults[provider]; fillModels($('#all-chat-model-options'),provider); });
['guide','reviewer'].forEach(mode => $(`#${mode}-provider`).addEventListener('change',() => { const provider = $(`#${mode}-provider`).value; $(`#${mode}-model`).value = CARNIVAL_CHAT_MODELS.defaults[provider]; fillModels($(`#${mode}-model-options`),provider); }));
$('#global-save-model').addEventListener('click',async () => { try { const {user} = await api('/api/me/ai-settings',{method:'PUT',body:{textProvider:$('#global-text-provider').value,textModel:$('#global-text-model').value.trim()}}); state.user = user; applyAiSettings(); renderWorkspaceModels(); toast('Text model saved for all text tools.','success'); } catch (error) { toast(error.message,'error'); } });
$('#refresh-chat-models').addEventListener('click',() => loadWorkspaceModels(true));
$('#chat-add-images').addEventListener('click',() => $('#chat-image-file').click());
$('#chat-image-file').addEventListener('change',async event => {
  const files = [...event.target.files]; event.target.value = ''; if (workspaceChatImages.length+files.length > 4) return toast('Attach up to 4 images.','error'); if (!chatVisionSupport()) return toast('Choose a model with image-input support.','error');
  const owner = state.user?.id; workspaceUploading = true; renderWorkspaceChat();
  try { for (const file of files) { if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 4*1024*1024) throw new Error('Choose PNG, JPEG, or WebP images up to 4 MB each.');
      const response = await fetch(`/api/chat/images?name=${encodeURIComponent(file.name)}`,{method:'POST',credentials:'same-origin',headers:{'content-type':file.type},body:file}); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Image upload failed.'); if (state.user?.id !== owner) return; workspaceChatImages.push(data.image); }
  } catch (error) { toast(error.message,'error'); } finally { workspaceUploading = false; renderWorkspaceChat(); }
});
$('#chat-clear-history').addEventListener('click',async () => { if (!confirm('Clear your saved CarniChat conversations?')) return; try { await api('/api/chat/history',{method:'DELETE'}); state.chat.guide = []; state.chat.reviewer = []; renderChat(); } catch (error) { toast(error.message,'error'); } });
const earlier = document.createElement('button'); earlier.type = 'button'; earlier.className = 'btn btn-ghost btn-sm'; earlier.textContent = 'Earlier'; earlier.title = 'Load earlier saved messages';
earlier.addEventListener('click', async () => { const mode = state.chat.mode; const first = state.chat[mode].find(message => message.sequence); if (!first) return;
  try { const data = await api(`/api/chat/history?mode=${mode}&before=${first.sequence}`); const older = data[mode] || []; state.chat[mode] = [...older,...state.chat[mode]]; renderChat(); if (!older.length) toast('You are at the start of this conversation.'); } catch (error) { toast(error.message,'error'); } });
$('#chat-clear-history').before(earlier);
$$('[data-library-section]').forEach(button => button.addEventListener('click',() => setLibrarySection(button.dataset.librarySection)));
$('#analyze-prompts').addEventListener('click',analyzeWorkspacePrompts);
$('#drive-connect').addEventListener('click',async () => { if ($('#drive-connect').dataset.configured !== 'true') { $('#drive-setup').open = true; return; } try { const {url} = await api('/api/drive/connect',{method:'POST'}); location.assign(url); } catch (error) { toast(error.message,'error'); } });
$('#drive-disconnect').addEventListener('click',async () => { try { await api('/api/drive/disconnect',{method:'DELETE'}); await loadDriveStatus(); $('#drive-files').replaceChildren(); } catch (error) { toast(error.message,'error'); } });
$('#drive-list').addEventListener('click',async () => { const output = $('#drive-files'); output.textContent = 'Loading Carnival files…'; try { const data = await api('/api/drive/files'); output.replaceChildren(); if (!data.files?.length) output.textContent = 'No Carnival images saved to this Drive account yet.';
    (data.files || []).forEach(file => { const row = document.createElement('div'); row.className = 'drive-file'; const name = document.createElement('span'); name.textContent = file.name; const button = document.createElement('button'); button.className = 'btn btn-secondary btn-sm'; button.type = 'button'; button.textContent = 'Import to Library';
      button.addEventListener('click',async () => { button.disabled = true; try { await api('/api/drive/import',{method:'POST',body:{fileId:file.id}}); await loadLibrary(true); toast('Drive image and prompt imported.','success'); } catch (error) { toast(error.message,'error'); } finally { button.disabled = false; } }); row.append(name,button); output.appendChild(row); });
  } catch (error) { output.textContent = error.message; } });
$('#library-save-drive').addEventListener('click',async () => { const asset = state.library.currentAsset; if (!asset) return; const button = $('#library-save-drive'); button.disabled = true;
  try { await api('/api/drive/export',{method:'POST',body:{assetId:asset.id}}); toast('Image and prompt information saved to Google Drive.','success'); } catch (error) { toast(error.message,'error'); } finally { button.disabled = false; } });
if (state.user) workspaceStarted();
