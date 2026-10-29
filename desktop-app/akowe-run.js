'use strict';
/*
 * akowe-run.js — the REAL state of Akọwe's "⚡ Make a book for me" run, for the 📚 Akọwe panel.
 *
 * Why: Akọwe's status push (POST /v1/status) carries the book's Make-my-book CHECKLIST (10 steps). On the first
 * real PC test the panel said "10/10 Done" for a book whose run had stopped at step 7 of 16 when Akọwe was closed
 * mid-run — the checklist and the run are two different things. This module reads the run itself from Akọwe's own
 * API (GET /api/autobook, the same call Alfred's book tools use) and turns it into one plain line:
 *
 *   "Writing — step 7 of 16"  ·  "Stopped when Akọwe closed — step 7 of 16"  ·  "Paused — needs your decision"
 *   "Finished"  ·  "Cancelled at step 3 of 16"
 *
 * Defensive on purpose: Akọwe may (in a newer build) push the run itself in its status body (`run`), may add
 * clearer fields (`step`, `steps_done`, `steps_total`, `state`), or may not answer at all. Every field is optional;
 * unknown statuses fall back to Akọwe's own phase text.
 *
 * Electron-free: createRunWatch({ api(method, path) -> {status, json}, now, minGapMs }) — main.js passes its
 * akoweApi(). Never throws, never logs prompts or book text (titles and step names only).
 */

const LIVE = new Set(['queued', 'running', 'waiting', 'pausing']);
const RESUMABLE = new Set(['paused', 'interrupted', 'error']);
const FINISHED_STEP = new Set(['done', 'skipped', 'complete', 'completed', 'approved']);

const str = (v, n) => (v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n || 200);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Step numbers of a run: { done, total, at } — at = the step it is on (1-based), or null. */
function stepsOf(run) {
  const steps = Array.isArray(run && run.steps) ? run.steps.filter((s) => s && typeof s === 'object') : [];
  let total = num(run && run.steps_total);
  let done = num(run && run.steps_done);
  if (steps.length) {
    if (total == null) total = steps.length;
    if (done == null) done = steps.filter((s) => FINISHED_STEP.has(String(s.state || '').toLowerCase())).length;
  }
  if (total == null) total = num(run && run.total);
  if (done == null) done = num(run && run.done);
  let at = num(run && run.step);
  if (at == null && steps.length) {
    const i = steps.findIndex((s) => /^(running|waiting|paused|failed)$/i.test(String(s.state || '')));
    at = i >= 0 ? i + 1 : null;
  }
  if (at == null && done != null && total != null && done < total) at = done + 1;
  if (total != null && done != null) done = Math.min(done, total);
  if (total != null && at != null) at = Math.min(Math.max(1, at), total);
  return { done, total, at, stepTitle: at && steps[at - 1] ? str(steps[at - 1].title, 80) : '' };
}

/**
 * One run (Akọwe's public run object, or the `run` a newer Akọwe pushes) -> what the panel shows:
 * { id, project_id, title, status, state, word, text, tone, done, total, at, stepTitle, resumable, needsDecision,
 *   live, phase }
 *   state: writing | waiting | pausing | needs_you | paused | interrupted | problem | finished | cancelled | unknown
 *   tone:  work | warn | err | ok | off   (the panel's colours)
 */
function summarizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  const status = str(run.status || run.state, 40).toLowerCase();
  const s = stepsOf(run);
  const stepNo = s.total ? (s.at || Math.min((s.done || 0) + 1, s.total)) : null;
  const of = s.total ? ` — step ${stepNo} of ${s.total}` : '';
  const ofAt = s.total ? ` at step ${stepNo} of ${s.total}` : '';
  const problem = run.problem && typeof run.problem === 'object' ? run.problem : null;
  const needsDecision = (status === 'paused' && !!(problem && (problem.record_id || problem.options))) || run.needs_decision === true;
  let state; let text; let tone;
  if (status === 'running' || status === 'queued') { state = 'writing'; text = `Writing${of}`; tone = 'work'; }
  else if (status === 'waiting') { state = 'waiting'; text = `Waiting for an AI${of}`; tone = 'work'; }
  else if (status === 'pausing') { state = 'pausing'; text = `Pausing after the current answer${of}`; tone = 'work'; }
  else if (status === 'paused' && needsDecision) { state = 'needs_you'; text = `Paused — needs your decision${s.total ? ` (step ${stepNo} of ${s.total})` : ''}`; tone = 'warn'; }
  else if (status === 'paused') { state = 'paused'; text = `Paused${ofAt} — ▶ Resume to continue`; tone = 'warn'; }
  else if (status === 'interrupted') { state = 'interrupted'; text = `Stopped when Akọwe closed${of} — ▶ Resume`; tone = 'warn'; }
  else if (status === 'error' || status === 'failed') { state = 'problem'; text = `Stopped by a problem${of} — ▶ Resume to try again`; tone = 'err'; }
  else if (status === 'done' || status === 'finished' || status === 'complete' || status === 'completed') { state = 'finished'; text = 'Finished'; tone = 'ok'; }
  else if (status === 'cancelled' || status === 'canceled') { state = 'cancelled'; text = `Cancelled${ofAt}`; tone = 'off'; }
  else { state = 'unknown'; text = str(run.phase, 160) || (status ? status.replace(/[_-]+/g, ' ') : 'Unknown'); tone = 'off'; }
  return {
    id: str(run.id || run.run_id, 80) || null, project_id: str(run.project_id, 100) || null, title: str(run.title, 160),
    status, state, text, tone, done: s.done, total: s.total, at: s.at, stepTitle: s.stepTitle,
    resumable: RESUMABLE.has(status) && !needsDecision, needsDecision, live: LIVE.has(status),
    phase: str(run.phase, 200), problem: problem ? str(problem.message, 200) : '',
    updated_at: str(run.updated_at || run.finished_at || run.started_at, 40) || null,
  };
}

/**
 * Pick the run that belongs to the book the panel shows: a live run first, then the newest run of that book,
 * then (no book known) the newest run. autobook: Akọwe's GET /api/autobook body { runs: [...], active: [...] }.
 */
function pickRun(autobook, projectId) {
  const j = autobook && typeof autobook === 'object' ? autobook : {};
  const active = (Array.isArray(j.active) ? j.active : []).filter((r) => r && typeof r === 'object');
  const runs = (Array.isArray(j.runs) ? j.runs : []).filter((r) => r && typeof r === 'object');
  const forBook = (r) => !projectId || !r.project_id || r.project_id === projectId;
  const stamp = (r) => String(r.updated_at || r.finished_at || r.started_at || r.created_at || '');
  const newestFirst = (list) => list.slice().sort((a, b) => stamp(b).localeCompare(stamp(a)));
  const live = active.find(forBook) || runs.find((r) => forBook(r) && LIVE.has(String(r.status)));
  if (live) return live;
  if (projectId) { const mine = newestFirst(runs.filter((r) => r.project_id === projectId)); if (mine.length) return mine[0]; }
  return newestFirst(runs)[0] || null;
}

/**
 * Keeps the latest run summary, refreshed in the background (at most every minGapMs, only while asked).
 *   peek(projectId, pushedRun) -> summary | null  (never waits; kicks a refresh when due)
 *   refresh(projectId)         -> Promise<summary | null>
 * A pushed run (Akọwe's own status body, newer Akọwe) wins over the fetched one when it is newer or the API
 * can't be reached. When Akọwe stops answering, the last summary is kept with stale: true.
 */
function createRunWatch(opts = {}) {
  const api = typeof opts.api === 'function' ? opts.api : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const minGapMs = Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : 5000;
  let last = null;          // summary
  let lastAt = 0;           // when it was read
  let lastTry = -Infinity;
  let inflight = null;
  let unreachable = false;

  async function refresh(projectId) {
    if (!api) return last;
    if (inflight) return inflight;
    lastTry = now();
    inflight = (async () => {
      let r = null;
      try { r = await api('GET', '/api/autobook'); } catch (_) { r = null; }
      if (!r || !(r.status >= 200 && r.status < 300) || !r.json) { unreachable = true; return last; }
      unreachable = false;
      const run = pickRun(r.json, projectId);
      last = run ? summarizeRun(run) : null;
      lastAt = now();
      return last;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  function peek(projectId, pushedRun) {
    if (api && !inflight && now() - lastTry >= minGapMs) refresh(projectId).catch(() => {});
    const pushed = pushedRun ? summarizeRun(pushedRun) : null;
    let out = last;
    if (pushed && (!out || unreachable || (pushed.id && out.id !== pushed.id && pushed.live))) out = pushed;
    if (out && projectId && out.project_id && out.project_id !== projectId && !out.live) out = pushed || null;
    if (!out) return null;
    return Object.assign({}, out, { checkedAt: lastAt || null, stale: !!(unreachable && out === last) });
  }

  return { peek, refresh, _state: () => ({ last, lastAt, unreachable }) };
}

module.exports = { summarizeRun, pickRun, stepsOf, createRunWatch };
