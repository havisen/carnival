'use strict';

// ---------------------------------------------------------------------------
// Generation Stage workflow
//
// The Generation Stage is a short, fixed pipeline:
//
//   1. Build Image Prompts  – one image prompt per action reference, built from
//                             the shared Character References, the final
//                             Character Reference Sheets, the Action References,
//                             and the Location References.
//   2. Approve prompts      – every saved prompt needs an explicit human
//                             approval before the stage can move on.
//   3. Review the prompts   – the reviewer agent compares every image prompt
//                             with the references. Each inconsistency it raises
//                             must be edited away or dismissed.
//   4. Run image generation – every prompt is rendered one by one with its
//                             reference sheet images attached, and each result
//                             is filed into the project and the Library.
//
// This module owns the persisted prompt, approval, review-flag, and image state
// for that pipeline. It never calls a provider and never invents approvals:
// generation, human approval, and agent review stay separate.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

let rawDb = null;

const MAX_PROMPTS = 20;
const MAX_PROMPT_CHARS = 30000;
const MAX_FLAGS_PER_PROMPT = 50;
const MAX_FLAG_MESSAGE = 2000;
const FLAG_STATUSES = new Set(['open', 'dismissed', 'edited']);
const SEVERITIES = new Set(['error', 'warning', 'info']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FINAL_IMAGE_FIELDS = ['file', 'mime', 'size', 'model', 'prompt', 'createdAt', 'assetId', 'versionId', 'revision', 'promptDraftId'];

function now() {
  return new Date().toISOString();
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function safeId(value) {
  return ID_RE.test(String(value || '')) ? String(value) : crypto.randomUUID();
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function parseArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function schema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS generation_tasks (
      project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompts_json TEXT NOT NULL DEFAULT '[]',
      saved_at     TEXT NOT NULL DEFAULT '',
      reviewed_at  TEXT NOT NULL DEFAULT '',
      reviewed_by  TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `);
}

function projectForUser(userId, projectId) {
  return rawDb.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
}

function taskRow(userId, projectId) {
  return rawDb.prepare('SELECT * FROM generation_tasks WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId);
}

function normalizeFlag(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const message = text(item.message, MAX_FLAG_MESSAGE);
  if (!message) return null;
  const severity = SEVERITIES.has(text(item.severity, 20).toLowerCase())
    ? text(item.severity, 20).toLowerCase()
    : 'warning';
  const status = FLAG_STATUSES.has(text(item.status, 20)) ? text(item.status, 20) : 'open';
  return {
    id: safeId(item.id),
    severity,
    message,
    status,
    source: text(item.source, 60) || 'project-review',
    createdAt: text(item.createdAt, 40) || now(),
    resolvedAt: text(item.resolvedAt, 40),
  };
}

function normalizeFlags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const flag = normalizeFlag(raw);
    if (!flag) continue;
    const key = `${flag.severity}|${flag.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
    if (out.length >= MAX_FLAGS_PER_PROMPT) break;
  }
  return out;
}

function normalizeImage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const file = text(raw.file, 200);
  if (!file) return null;
  const image = {};
  for (const key of FINAL_IMAGE_FIELDS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    image[key] = typeof raw[key] === 'number' ? raw[key] : text(raw[key], MAX_PROMPT_CHARS);
  }
  image.file = file;
  image.mime = text(raw.mime, 100) || 'image/png';
  return image;
}

function normalizePrompt(raw, index) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const characters = Array.isArray(item.characters)
    ? item.characters.map((name) => text(name, 120)).filter(Boolean).slice(0, 12)
    : [];
  return {
    id: safeId(item.id),
    index: Number.isInteger(item.index) ? item.index : index,
    sceneId: ID_RE.test(String(item.sceneId || '')) ? String(item.sceneId) : '',
    action: text(item.action, 5000),
    locationSentence: text(item.locationSentence, 2000),
    characters,
    locationName: text(item.locationName, 200),
    locationDescription: text(item.locationDescription, 5000),
    prompt: text(item.prompt, MAX_PROMPT_CHARS),
    approved: item.approved === true,
    approvedAt: text(item.approvedAt, 40),
    flags: normalizeFlags(item.flags),
    image: normalizeImage(item.image),
  };
}

function normalizePrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROMPTS).map((raw, index) => normalizePrompt(raw, index));
}

/**
 * Derive the four step states from the persisted task. Image staleness is
 * computed here so an image rendered from an older prompt can never look
 * current after the prompt text was edited.
 */
function taskState(task) {
  const prompts = task.prompts || [];
  const openFlags = [];
  const staleImages = [];
  for (const prompt of prompts) {
    for (const flag of prompt.flags || []) {
      if (flag.status === 'open') openFlags.push({ promptId: prompt.id, flagId: flag.id });
    }
    if (prompt.image && prompt.image.prompt !== undefined && prompt.image.prompt !== prompt.prompt) {
      staleImages.push(prompt.id);
    }
  }
  const promptsSaved = prompts.length > 0 && Boolean(task.savedAt) && prompts.every((prompt) => prompt.prompt);
  const approvedCount = prompts.filter((prompt) => prompt.approved).length;
  const allApproved = promptsSaved && approvedCount === prompts.length;
  const reviewComplete = allApproved && Boolean(task.reviewedAt) && openFlags.length === 0;
  const imagesComplete = reviewComplete && prompts.every((prompt) => prompt.image && !staleImages.includes(prompt.id));
  return {
    prompts: promptsSaved,
    approvals: allApproved,
    review: reviewComplete,
    images: imagesComplete,
    promptCount: prompts.length,
    approvedCount,
    openFlagCount: openFlags.length,
    openFlags,
    staleImageCount: staleImages.length,
    imageCount: prompts.filter((prompt) => prompt.image).length,
    done: imagesComplete,
  };
}

function toTask(row, userId, projectId) {
  if (!row) {
    return {
      projectId,
      prompts: [],
      savedAt: '',
      reviewedAt: '',
      reviewedBy: '',
      createdAt: '',
      updatedAt: '',
      state: taskState({ prompts: [], savedAt: '', reviewedAt: '' }),
    };
  }
  const task = {
    projectId: row.project_id,
    prompts: normalizePrompts(parseArray(row.prompts_json)),
    savedAt: row.saved_at || '',
    reviewedAt: row.reviewed_at || '',
    reviewedBy: row.reviewed_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  task.state = taskState(task);
  return task;
}

function getTask(userId, projectId) {
  if (!projectForUser(userId, projectId)) return null;
  return toTask(taskRow(userId, projectId), userId, projectId);
}

function writeTask(userId, projectId, patch) {
  const current = taskRow(userId, projectId);
  const timestamp = now();
  if (!current) {
    rawDb.prepare(`
      INSERT INTO generation_tasks
        (project_id, user_id, prompts_json, saved_at, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      userId,
      JSON.stringify(patch.prompts || []),
      patch.savedAt || '',
      patch.reviewedAt || '',
      patch.reviewedBy || '',
      timestamp,
      timestamp
    );
  } else {
    rawDb.prepare(`
      UPDATE generation_tasks
      SET prompts_json = ?, saved_at = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
      WHERE project_id = ? AND user_id = ?
    `).run(
      JSON.stringify(patch.prompts !== undefined ? patch.prompts : parseArray(current.prompts_json)),
      patch.savedAt !== undefined ? patch.savedAt : current.saved_at,
      patch.reviewedAt !== undefined ? patch.reviewedAt : current.reviewed_at,
      patch.reviewedBy !== undefined ? patch.reviewedBy : current.reviewed_by,
      timestamp,
      projectId,
      userId
    );
  }
  return toTask(taskRow(userId, projectId), userId, projectId);
}

function mutate(userId, projectId, mutatePrompts) {
  if (!projectForUser(userId, projectId)) return null;
  const current = taskRow(userId, projectId);
  const task = toTask(current, userId, projectId);
  const result = mutatePrompts(task);
  if (!result) return null;
  return writeTask(userId, projectId, result.patch);
}

function sameContent(previous, next) {
  return previous
    && previous.prompt === next.prompt
    && previous.action === next.action
    && previous.sceneId === next.sceneId
    && previous.locationSentence === next.locationSentence
    && previous.locationName === next.locationName
    && previous.locationDescription === next.locationDescription
    && String(previous.characters.join(', ')) === String(next.characters.join(', '));
}

/**
 * Persist a freshly built set of image prompts. State that belongs to a prompt
 * whose text did not change is carried over; changing a prompt clears its
 * approval and its open review flags. Renderings are kept so a re-save never
 * silently deletes images, but an image rendered from older text stays stale.
 */
function savePrompts(userId, projectId, value) {
  const incoming = normalizePrompts(value);
  if (!incoming.length) throw Object.assign(new Error('Build at least one image prompt before saving.'), { status: 400, code: 'NO_PROMPTS' });
  return mutate(userId, projectId, (task) => {
    const byId = new Map(task.prompts.map((prompt) => [prompt.id, prompt]));
    const byShape = new Map(task.prompts.map((prompt) => [`${prompt.index}|${prompt.prompt}`, prompt]));
    const prompts = incoming.map((prompt, index) => {
      const previous = byId.get(prompt.id) || byShape.get(`${index}|${prompt.prompt}`) || null;
      const next = { ...prompt, index };
      if (previous && sameContent(previous, next)) {
        next.approved = previous.approved;
        next.approvedAt = previous.approvedAt;
        next.flags = previous.flags;
        next.image = previous.image;
      } else if (previous && previous.image) {
        next.image = previous.image;
      }
      return next;
    });
    return { patch: { prompts, savedAt: now(), reviewedAt: '', reviewedBy: '' } };
  });
}

function updatePrompt(userId, projectId, promptId, value) {
  const prompt = text(value, MAX_PROMPT_CHARS);
  if (!prompt) throw Object.assign(new Error('An image prompt cannot be empty.'), { status: 400, code: 'EMPTY_PROMPT' });
  return mutate(userId, projectId, (task) => {
    const target = task.prompts.find((item) => item.id === promptId);
    if (!target) return null;
    target.prompt = prompt;
    // Editing is a content change: the previous human approval no longer
    // applies, and any review flag for this prompt is answered by the edit.
    target.approved = false;
    target.approvedAt = '';
    for (const flag of target.flags) {
      if (flag.status === 'open') {
        flag.status = 'edited';
        flag.resolvedAt = now();
      }
    }
    return { patch: { prompts: task.prompts } };
  });
}

function setPromptApproval(userId, projectId, promptId, approved) {
  return mutate(userId, projectId, (task) => {
    const target = task.prompts.find((item) => item.id === promptId);
    if (!target) return null;
    target.approved = approved === true;
    target.approvedAt = target.approved ? now() : '';
    return { patch: { prompts: task.prompts } };
  });
}

/**
 * Store the reviewer agent's findings. Previously dismissed or edited flags are
 * kept as history; new findings are appended as open flags and de-duplicated by
 * severity and message.
 */
function setReviewFlags(userId, projectId, findings, reviewer) {
  return mutate(userId, projectId, (task) => {
    const byPrompt = new Map();
    for (const raw of Array.isArray(findings) ? findings : []) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const promptId = text(item.promptId, 80);
      if (!promptId) continue;
      if (!byPrompt.has(promptId)) byPrompt.set(promptId, []);
      byPrompt.get(promptId).push(item);
    }
    for (const prompt of task.prompts) {
      const resolved = prompt.flags.filter((flag) => flag.status !== 'open');
      const open = prompt.flags.filter((flag) => flag.status === 'open');
      const seen = new Set(prompt.flags.map((flag) => `${flag.severity}|${flag.message}`));
      const found = normalizeFlags(byPrompt.get(prompt.id) || []);
      for (const flag of found) {
        const key = `${flag.severity}|${flag.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        open.push(flag);
      }
      prompt.flags = [...resolved, ...open].slice(0, MAX_FLAGS_PER_PROMPT);
    }
    return { patch: { prompts: task.prompts, reviewedAt: now(), reviewedBy: text(reviewer, 120) } };
  });
}

function resolveFlag(userId, projectId, promptId, flagId, status) {
  if (status !== 'dismissed') {
    throw Object.assign(new Error('A review flag can only be dismissed or answered by editing the prompt.'), { status: 400, code: 'INVALID_FLAG_ACTION' });
  }
  return mutate(userId, projectId, (task) => {
    const target = task.prompts.find((item) => item.id === promptId);
    if (!target) return null;
    const flag = target.flags.find((item) => item.id === flagId);
    if (!flag) return null;
    flag.status = status;
    flag.resolvedAt = now();
    return { patch: { prompts: task.prompts } };
  });
}

function recordImage(userId, projectId, promptId, image) {
  const normalized = normalizeImage(image);
  if (!normalized) throw Object.assign(new Error('The generated image could not be recorded.'), { status: 500, code: 'INVALID_IMAGE' });
  return mutate(userId, projectId, (task) => {
    const target = task.prompts.find((item) => item.id === promptId);
    if (!target) return null;
    target.image = normalized;
    return { patch: { prompts: task.prompts } };
  });
}

function clearTask(userId, projectId) {
  if (!projectForUser(userId, projectId)) return null;
  rawDb.prepare('DELETE FROM generation_tasks WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  return toTask(null, userId, projectId);
}

function init(database) {
  rawDb = database;
  schema();
  return {
    MAX_PROMPTS,
    MAX_PROMPT_CHARS,
    getTask,
    taskState,
    savePrompts,
    updatePrompt,
    setPromptApproval,
    setReviewFlags,
    resolveFlag,
    recordImage,
    clearTask,
  };
}

module.exports = { init };