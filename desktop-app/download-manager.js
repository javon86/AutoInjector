'use strict';
/*
 * download-manager.js — a small background job queue for the Setup Wizard.
 *
 * The point: the user queues several big items (models, engines) and keeps
 * browsing while they download. A few run at once (a concurrency cap), the rest
 * wait their turn, and progress streams out as events. Because this lives in the
 * main process, jobs keep running even if the wizard window is closed.
 *
 * Runners are pluggable: each job has a `kind`, and init() is given a map of
 * kind -> runner(job, hooks). A runner starts the work and returns an optional
 * handle with a cancel() method. It reports back through hooks.progress() and
 * hooks.done(). The manager itself knows nothing about Ollama, HTTP, etc. — that
 * keeps it testable and lets new download types slot in later (SD models, etc.).
 */

let _jobs = [];
let _seq = 1;
let _concurrency = 2;
let _onChange = null;
let _runners = {};

/** Configure the manager. runners: { kind: (job, hooks) => ({ cancel? }) }. */
function init({ concurrency = 2, onChange = null, runners = {} } = {}) {
  _concurrency = Math.max(1, concurrency | 0 || 2);
  _onChange = onChange;
  _runners = runners || {};
}

/** The public view of a job (no internal handles). */
function _view(j) {
  return { id: j.id, kind: j.kind, model: j.model, label: j.label, category: j.category,
    status: j.status, progress: j.progress, detail: j.detail, error: j.error };
}
function list() { return _jobs.map(_view); }
function _emit() { if (typeof _onChange === 'function') { try { _onChange(list()); } catch (_) {} } }

/** Add a job. spec: { kind, model?, label?, category? }. Returns the job id. */
function enqueue(spec) {
  spec = spec || {};
  const job = {
    id: `job-${_seq++}`,
    kind: spec.kind,
    model: spec.model || null,
    url: spec.url || null,           // for http-download jobs
    filename: spec.filename || null, // for http-download jobs
    label: spec.label || spec.model || spec.kind || 'download',
    category: spec.category || '',
    status: 'queued',
    progress: 0,
    detail: 'queued',
    error: null,
    _handle: null,
  };
  _jobs.push(job);
  _emit();
  _pump();
  return job.id;
}

/** Start queued jobs up to the concurrency cap. */
function _pump() {
  let running = _jobs.filter((j) => j.status === 'running').length;
  for (const job of _jobs) {
    if (running >= _concurrency) break;
    if (job.status !== 'queued') continue;
    _start(job);
    running++;
  }
}

function _start(job) {
  const runner = _runners[job.kind];
  if (typeof runner !== 'function') {
    job.status = 'failed'; job.detail = 'failed'; job.error = `unknown download type: ${job.kind}`;
    _emit(); return;
  }
  job.status = 'running'; job.detail = 'starting…'; job.error = null;
  _emit();
  const hooks = {
    // pct: 0..100 or null (unknown); detail: short human string.
    progress: (pct, detail) => {
      if (job.status !== 'running') return;
      if (pct != null && !isNaN(pct)) job.progress = Math.max(0, Math.min(100, Math.round(pct)));
      if (detail) job.detail = String(detail).slice(0, 120);
      _emit();
    },
    done: (ok, err) => {
      if (job.status !== 'running') return; // already canceled
      job.status = ok ? 'done' : 'failed';
      job.progress = ok ? 100 : job.progress;
      job.detail = ok ? 'done' : (err ? String(err).slice(0, 120) : 'failed');
      job.error = ok ? null : (err ? String(err) : 'failed');
      _emit();
      _pump();
    },
  };
  try {
    job._handle = runner(job, hooks) || null;
  } catch (e) {
    hooks.done(false, (e && e.message) || String(e));
  }
}

/** Cancel a queued or running job. */
function cancel(id) {
  const job = _jobs.find((j) => j.id === id);
  if (!job) return false;
  if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return false;
  if (job._handle && typeof job._handle.cancel === 'function') {
    try { job._handle.cancel(); } catch (_) {}
  }
  job.status = 'canceled'; job.detail = 'canceled';
  _emit();
  _pump();
  return true;
}

/** Drop finished/failed/canceled jobs from the list (keep active + queued). */
function clearFinished() {
  _jobs = _jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  _emit();
}

/** Test/reset helper. */
function _reset() { _jobs = []; _seq = 1; }

module.exports = { init, enqueue, list, cancel, clearFinished, _reset };
