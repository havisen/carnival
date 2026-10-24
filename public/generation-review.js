'use strict';

// Shared by every Generate control. Server state is authoritative across tabs and refreshes.
let generationReviewRows = [];
const generationRequests = new Map();
let generationReviewsReady = false;
let generationReviewTimer;
let generationReviewRevision = 0;
let generationReviewLoad = 0;
const generationDecisions = new Set();

function generationScope(kind, projectId = '', target = '') {
  return { kind, projectId: projectId || '', target: target || '' };
}

function sameGenerationScope(a, b) {
  return a.kind === b.kind && a.projectId === b.projectId && a.target === b.target;
}

function generationRequestScope(path, body = {}) {
  const kinds = { '/api/generate': 'ideas', '/api/reference': 'reference',
    '/api/generation/prompts': 'prompts', '/api/generation/prompt': 'prompts', '/api/images/generate': 'images' };
  if (kinds[path]) return generationScope(kinds[path], body.projectId);
  const sheet = path.match(/^\/api\/story\/([^/]+)\/characters\/([^/]+)\/sheets\/generate$/);
  if (sheet) return generationScope('sheet', decodeURIComponent(sheet[1]), decodeURIComponent(sheet[2]));
  const worksheet = path.match(/^\/api\/story\/([^/]+)\/worksheet\/(actions|locations)\/generate$/);
  if (worksheet) return generationScope(worksheet[2], decodeURIComponent(worksheet[1]));
  const workspace = path.match(/^\/api\/story\/([^/]+)\/workspace\/generate$/);
  return workspace ? generationScope('workspace', decodeURIComponent(workspace[1])) : null;
}

function generationReviewFor(scope) {
  return generationReviewRows.find((row) => sameGenerationScope(row, scope));
}

function generationBlocked(scope) {
  return !generationReviewsReady || Boolean(generationReviewFor(scope)) ||
    Array.from(generationRequests.values()).some((request) => sameGenerationScope(request.scope, scope));
}

async function api(path, options = {}) {
  const scope = options.method === 'POST' ? generationRequestScope(path, options.body) : null;
  const userId = state.user?.id;
  if (scope && generationBlocked(scope)) {
    throw new ApiError('Approve or disapprove the generated result before generating again.', 409, 'GENERATION_REVIEW_REQUIRED');
  }
  const token = {};
  if (scope) { generationRequests.set(token, { scope }); refreshGenerationLocks(); }
  try {
    const data = await apiRequest(path, options);
    if (data.generationReview && state.user?.id === userId) {
      generationReviewRevision += 1;
      generationReviewRows = generationReviewRows.filter((row) => row.id !== data.generationReview.id);
      if (['running', 'pending'].includes(data.generationReview.status)) generationReviewRows.push(data.generationReview);
    }
    return data;
  } catch (err) {
    if ((err.code === 'GENERATION_REVIEW_REQUIRED' || (scope && err.status === 0)) && state.user?.id === userId) {
      if (err.status === 0) generationReviewsReady = false;
      await loadGenerationReviews();
    }
    throw err;
  } finally {
    generationRequests.delete(token);
    refreshGenerationLocks();
  }
}

async function loadGenerationReviews() {
  const userId = state.user?.id;
  if (!userId) return;
  const revision = generationReviewRevision;
  const load = ++generationReviewLoad;
  try {
    const { reviews } = await apiRequest('/api/generation/reviews');
    if (state.user?.id !== userId || revision !== generationReviewRevision || load !== generationReviewLoad) return;
    const arrived = reviews.filter((row) => row.status === 'pending' && !generationReviewRows.some((old) => old.id === row.id && old.status === 'pending'));
    generationReviewRows = reviews;
    generationReviewsReady = true;
    const ideas = reviews.find((row) => row.kind === 'ideas' && row.status === 'pending');
    if (ideas) { state.ideas = ideas.result.ideas || []; renderIdeas(); }
    if (arrived.length) {
      await loadProjects();
      if (arrived.some((row) => row.projectId === state.generation.projectId && ['prompts', 'images'].includes(row.kind))) selectGenerationProject(state.generation.projectId);
      if (state.story.projectId) await loadStory(state.story.projectId);
    } else if (state.story.data) renderWorksheet();
    refreshGenerationLocks();
    clearTimeout(generationReviewTimer);
    if (reviews.some((row) => row.status === 'running')) {
      generationReviewTimer = setTimeout(loadGenerationReviews, 1500);
    }
  } catch (err) {
    toast(err.message || 'Could not load pending generation decisions.', 'error');
  }
}

function resetGenerationReviews() {
  generationReviewRevision += 1;
  generationReviewLoad += 1;
  generationReviewRows = [];
  generationRequests.clear();
  generationReviewsReady = false;
  clearTimeout(generationReviewTimer);
}

function bindGenerationButton(button, scope, available = true) {
  if (!button) return;
  button.dataset.generationScope = JSON.stringify(scope);
  button.dataset.generationAvailable = String(available);
  button.disabled = !available || generationBlocked(scope);
  button.title = generationBlocked(scope) ? 'Approve or disapprove the generated result before generating again.' : '';
}

function generationDecisionControls(container, scope) {
  if (!container) return;
  container.querySelectorAll('.generation-review').forEach((item) => item.remove());
  const review = generationReviewFor(scope);
  if (!review || review.status !== 'pending') return;
  const controls = document.createElement('div');
  controls.className = 'generation-review';
  const hint = document.createElement('p');
  hint.className = 'hint';
  const scene = (state.generation.scenes || []).find((item) => item.id === review.result.image?.sceneId);
  hint.textContent = scene ? 'Review the generated image for "' + scene.title + '". Approve or disapprove it to unlock generation.'
    : 'Review this result. Approve or disapprove it to unlock generation.';
  controls.appendChild(hint);
  for (const decision of ['approved', 'disapproved']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm ' + (decision === 'approved' ? 'btn-primary' : 'btn-secondary');
    button.textContent = decision === 'approved' ? (scope.kind === 'sheet' ? 'Add this sheet' : 'Approve result') : 'Disapprove result';
    button.disabled = generationDecisions.has(review.id);
    button.addEventListener('click', async () => {
      if (generationDecisions.has(review.id)) return;
      generationDecisions.add(review.id);
      controls.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      try { await decideGenerationReview(review, decision); }
      catch (err) {
        toast(err.message || 'Could not save the decision.', 'error');
        controls.querySelectorAll('button').forEach((item) => { item.disabled = false; });
      } finally { generationDecisions.delete(review.id); refreshGenerationLocks(); }
    });
    controls.appendChild(button);
  }
  container.appendChild(controls);
}

async function decideGenerationReview(review, decision) {
  const userId = state.user?.id;
  if (['actions', 'locations'].includes(review.kind) && decision === 'approved') {
    await api('/api/story/' + encodeURIComponent(review.projectId) + '/worksheet/' + review.kind + '/save', {
      method: 'POST', body: { [review.kind]: review.result[review.kind] },
    });
  } else {
    await api('/api/generation/reviews/' + encodeURIComponent(review.id), { method: 'POST', body: { decision } });
  }
  if (state.user?.id !== userId) return;
  generationReviewRevision += 1;
  generationReviewRows = generationReviewRows.filter((row) => row.id !== review.id);
  if (review.kind === 'ideas' && decision === 'disapproved') { state.ideas = []; state.selected.clear(); renderIdeas(); }
  if (review.kind === 'actions' && decision === 'approved') await loadProjects();
  if (state.story.projectId === review.projectId) {
    if (review.kind === 'actions') state.story.actionDraft = null;
    if (['actions', 'locations'].includes(review.kind)) state.story.locationDraft = null;
    await loadStory(review.projectId);
  }
  if (review.kind === 'sheet' && state.generation.projectId === review.projectId) await loadGenerationCharacterSheets(review.projectId);
  refreshGenerationLocks();
  refreshSidebarStory(true);
  toast(decision === 'approved' ? 'Result approved. Generation unlocked.' : 'Result disapproved. Generation unlocked.', 'success');
}

function refreshGenerationLocks() {
  if (!state.user) return;
  const storyId = state.story.projectId;
  updateGenerateNextImageButton();
  const specs = [
    ['#generate-btn', generationScope('ideas'), true],
    ['#ref-generate', generationScope('reference', state.reference.projectId), Boolean(state.reference.projectId)],
    ['#ref-regenerate', generationScope('reference', state.reference.projectId), Boolean(state.reference.projectId)],
    ['#story-generate-workspace', generationScope('workspace', storyId), Boolean(storyId)],
    ['#story-generate-sheet', generationScope('sheet', storyId, state.story.sheetCharacterId), Boolean(state.story.sheetCharacterId)],
    ['#worksheet-generate-one', generationScope('sheet', storyId, $('#worksheet-character')?.value), Boolean($('#worksheet-character')?.value)],
    ['#worksheet-generate-actions', generationScope('actions', storyId), Boolean(storyId)],
    ['#worksheet-generate-locations', generationScope('locations', storyId), Boolean(state.story.data?.worksheet?.actions?.length)],
    ['#gen-generate-prompts', generationScope('prompts', state.generation.projectId), Boolean(state.generation.projectId)],
  ];
  for (const [selector, scope, available] of specs) bindGenerationButton($(selector), scope, available);
  const all = $('#worksheet-generate-all');
  if (all) {
    const characters = state.story.data?.characters || [];
    const blocked = characters.some((character) => generationBlocked(generationScope('sheet', storyId, character.id)));
    all.disabled = !$('#worksheet-character')?.value || blocked || all.dataset.generating === 'true';
    all.title = blocked ? 'Decide on each generated sheet before generating all again.' : '';
  }
  $$('[data-generation-scope]').forEach((button) => {
    bindGenerationButton(button, JSON.parse(button.dataset.generationScope), button.dataset.generationAvailable === 'true');
  });
  const nextImage = $('#gen-generate-next-image');
  if (nextImage && generationBlocked(generationScope('images', state.generation.projectId))) nextImage.disabled = true;
  for (const [id, scope] of [
    ['generation-review-ideas', generationScope('ideas')],
    ['generation-review-reference', generationScope('reference', state.reference.projectId)],
    ['generation-review-workspace', generationScope('workspace', storyId)],
    ['generation-review-actions', generationScope('actions', storyId)],
    ['generation-review-locations', generationScope('locations', storyId)],
    ['generation-review-prompts', generationScope('prompts', state.generation.projectId)],
    ['generation-review-images', generationScope('images', state.generation.projectId)],
  ]) generationDecisionControls($('#' + id), scope);
}

window.addEventListener('focus', () => { if (state.user) loadGenerationReviews(); });
