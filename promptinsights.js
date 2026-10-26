'use strict';

const STOP = new Set('the and for with that this from into image photo character scene make have will their they are was were its not but you your one two use only should must all'.split(' '));
function terms(prompt) {
  const words = String(prompt || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [];
  const tokens = words.filter(word => !STOP.has(word));
  return new Set([...tokens, ...tokens.slice(0, -1).map((word, i) => `${word} ${tokens[i + 1]}`)]);
}
function analyze(samples) {
  const usable = samples.filter(sample => typeof sample.prompt === 'string' && sample.prompt.trim());
  const approved = usable.filter(x => x.decision === 'APPROVED');
  const unapproved = usable.filter(x => ['REJECT', 'REVISE', 'OWNER REVIEW'].includes(x.decision));
  const pending = usable.filter(x => !x.decision);
  function patterns(group, other) {
    const counts = new Map(); const opposite = new Map();
    group.forEach(item => terms(item.prompt).forEach(term => counts.set(term, (counts.get(term) || 0) + 1)));
    other.forEach(item => terms(item.prompt).forEach(term => opposite.set(term, (opposite.get(term) || 0) + 1)));
    return [...counts].filter(([, count]) => count >= 2).map(([term, count]) => ({
      term, count, rate: count / group.length, otherCount: opposite.get(term) || 0,
      otherRate: other.length ? (opposite.get(term) || 0) / other.length : 0,
      examples: group.filter(item => terms(item.prompt).has(term)).slice(0, 3).map(item => ({ id: item.id, title: item.title, decision: item.decision })),
    })).sort((a, b) => (b.rate - b.otherRate) - (a.rate - a.otherRate) || b.count - a.count || a.term.localeCompare(b.term)).slice(0, 18);
  }
  const pairs = [];
  const bounded = usable.filter(x => x.decision).slice(0, 250);
  const indexed = bounded.map(item => terms(item.prompt));
  for (let i = 0; i < bounded.length; i++) for (let j = i + 1; j < bounded.length; j++) {
    const a = indexed[i]; const b = indexed[j];
    const intersection = [...a].filter(term => b.has(term)).length;
    const similarity = intersection / (a.size + b.size - intersection || 1);
    if (similarity >= 0.25) pairs.push({ similarity, a: { id: bounded[i].id, title: bounded[i].title, decision: bounded[i].decision }, b: { id: bounded[j].id, title: bounded[j].title, decision: bounded[j].decision } });
  }
  return { counts: { total: usable.length, approved: approved.length, unapproved: unapproved.length, pending: pending.length },
    approvedPatterns: patterns(approved, unapproved), unapprovedPatterns: patterns(unapproved, approved),
    similarPrompts: pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 15),
    note: 'Patterns describe recorded human decisions, not causes or guarantees. Pending work is kept separate. No approvals or saved prompts are changed.' };
}
function samples(db, userId) {
  const images = db.prepare(`SELECT a.id, a.title, v.prompt, v.id AS version_id,
    (SELECT r.decision FROM review_records r WHERE r.user_id = ? AND r.asset_id = a.id
      AND r.asset_version_id = v.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS decision
    FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.user_id = ? AND v.prompt IS NOT NULL`).all(userId, userId);
  const prompts = db.prepare(`SELECT pd.id, p.title, pd.text AS prompt,
    (SELECT r.decision FROM review_records r WHERE r.user_id = ? AND r.prompt_draft_id = pd.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS decision
    FROM projects p JOIN prompt_drafts pd ON pd.project_id = p.id WHERE p.user_id = ? AND pd.user_id = p.user_id
    AND pd.version = (SELECT MAX(newer.version) FROM prompt_drafts newer WHERE newer.project_id = pd.project_id AND newer.scene_id = pd.scene_id)`).all(userId, userId);
  const tasks = db.prepare(`SELECT t.project_id, t.prompts_json, p.title FROM generation_tasks t
    JOIN projects p ON p.id = t.project_id WHERE t.user_id = ? AND p.user_id = ?`).all(userId, userId).flatMap(row => {
      let items; try { items = JSON.parse(row.prompts_json); } catch { return []; }
      return (Array.isArray(items) ? items : []).map(item => ({ id: `task:${row.project_id}:${item.id}`,
        title: row.title, prompt: item.prompt || '', decision: item.approved === true ? 'APPROVED' : null, kind: 'project-prompt' }));
    });
  return [...images.map(x => ({ ...x, kind: 'image' })), ...prompts.map(x => ({ ...x, kind: 'project-prompt' })), ...tasks];
}
module.exports = { terms, analyze, samples };
