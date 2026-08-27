'use strict';
/*
 * atelier-runner.js — the bridge between the derived-state engine and the live
 * relay. The engine decides WHAT is allowed to happen next (nextActions); this
 * runner turns each allowed action into real traffic: it opens a JOB, composes a
 * prompt, sends it to the right AI pane, and — when that pane replies — runs the
 * captured text back through the engine's validator chain (the ONLY path from
 * text to artifact). Approvals/locks/assembly it applies directly.
 *
 * Dependency-injected (send / persist / notify / roleOf) so it can be driven in
 * a test without Electron. main.js wires the real sendTextTo + on-capture hook.
 */
const E = require('./atelier-engine');

const ROLE_SITE = { STORY: 'chatgpt', CANON: 'gemini', WRITING: 'claude' };
const SITE_ROLE = { chatgpt: 'STORY', gemini: 'CANON', claude: 'WRITING' };
// D-5: the honest read must not be done by the draft's author (WRITING/claude).
const HONEST_SITE = 'chatgpt';
function siteFor(fn) { return fn === 'HONEST' ? HONEST_SITE : ROLE_SITE[fn] || ROLE_SITE[E.REGISTRY[fn] && E.REGISTRY[fn].owner]; }
function ownerSite(type) { return ROLE_SITE[E.REGISTRY[type] ? E.REGISTRY[type].owner : 'STORY']; }

const MAX_REDISPATCH = 2; // re-send a rejected job at most twice, then park it

function createRunner(deps) {
  // deps: { send(site, prompt), persist(store), notify(kind, data), roleOf(site) }
  const send = deps.send || (() => {});
  const persist = deps.persist || (() => {});
  const notify = deps.notify || (() => {});
  const roleOf = deps.roleOf || ((s) => SITE_ROLE[s] || null);

  let st = null;
  const pending = {};       // site -> { job_id, action }
  const rejects = {};       // job_id -> count

  function save() { try { persist(st); } catch (_) {} }
  function status() { return st ? E.deriveBook(st) : null; }
  function getStore() { return st; }
  function setStore(store) { st = store; }

  function start(bookId, store) { st = store || E.newStore(bookId); for (const k of Object.keys(pending)) delete pending[k]; save(); return status(); }
  function setRequirements(body, mandatory) { E.supplyRequirements(st, { body, mandatory }); save(); return status(); }

  // Turn one allowed action into a dispatch to a pane (REQUEST/REVIEW), or apply
  // it directly (APPROVE/LOCK/ASSEMBLE). Returns 'dispatched' | 'applied' | 'busy'.
  function dispatch(action) {
    if (action.kind === 'APPROVE') {
      const r = E.approve(st, action.artifact_id);
      if (r.ok && action.type === 'MASTER_OUTLINE') E.setChapterCount(st, parseChapterCount(r.artifact.body));
      notify('approved', { artifact_id: action.artifact_id, type: action.type });
      return 'applied';
    }
    if (action.kind === 'LOCK') { const r = E.lockChapter(st, action.key); notify('lock', { key: action.key, ok: r.ok, reasons: r.reasons }); return 'applied'; }
    if (action.kind === 'ASSEMBLE') { const r = E.assemble(st); notify('assemble', { ok: r.ok, chapters: r.chapters, reasons: r.reasons }); return 'applied'; }
    if (action.kind === 'REQUEST' || action.kind === 'REVIEW') {
      const site = action.kind === 'REVIEW' ? siteFor(action.function) : ownerSite(action.type);
      if (pending[site]) return 'busy'; // that pane is already working on something
      if (action.kind === 'REVIEW') {
        pending[site] = { review: action };
        send(site, composeReview(action));
        notify('dispatch', { site, kind: 'REVIEW', function: action.function, key: action.key });
        return 'dispatched';
      }
      // REQUEST: reuse an already-OPEN job for the slot, else open one.
      let job = E.openJobFor(st, action.type, action.key);
      if (!job) { const oj = E.openJob(st, { type: action.type, key: action.key }); if (!oj.ok) { notify('request-blocked', { type: action.type, key: action.key, reason: oj.reason }); return 'applied'; } job = oj.job; }
      pending[site] = { job_id: job.job_id, action };
      send(site, composePrompt(action.type, action.key, job));
      notify('dispatch', { site, kind: 'REQUEST', type: action.type, key: action.key, job_id: job.job_id });
      return 'dispatched';
    }
    return 'applied';
  }

  // Drive as far as the records allow right now: apply every direct action and
  // dispatch to every free pane, then stop (waiting on replies). Idempotent.
  function advance() {
    let guard = 0;
    while (guard++ < 200) {
      const acts = E.nextActions(st);
      if (!acts.length) break;
      let progressed = false;
      for (const a of acts) {
        const r = dispatch(a);
        if (r === 'applied' || r === 'dispatched') progressed = true;
        // 'busy' just means that pane is occupied; keep scanning others.
      }
      save();
      // If nothing left is directly-applicable (all remaining need a reply), stop.
      const remaining = E.nextActions(st);
      const anyApplicable = remaining.some((a) => a.kind === 'APPROVE' || a.kind === 'LOCK' || a.kind === 'ASSEMBLE'
        || ((a.kind === 'REQUEST' || a.kind === 'REVIEW') && !pending[a.kind === 'REVIEW' ? siteFor(a.function) : ownerSite(a.type)]));
      if (!anyApplicable || !progressed) break;
    }
    save();
    return status();
  }

  // A pane replied. If it's the answer to something we dispatched to that pane,
  // run it through the engine (capture or review), then advance again.
  function onReply(site, rawText) {
    const p = pending[site];
    if (!p) return { handled: false };
    delete pending[site];
    if (p.review) {
      const a = p.review;
      const findings = parseReview(rawText);
      E.addReview(st, { function: a.function, subject: a.subject, findings });
      notify('review-captured', { site, function: a.function, key: a.key, findings: findings.length });
      save(); advance();
      return { handled: true, kind: 'REVIEW' };
    }
    const job = st.jobs.find((j) => j.job_id === p.job_id);
    if (!job) { advance(); return { handled: true, kind: 'stale-job' }; }
    const envelope = { job_id: job.job_id, seq: job.seq, node: roleOf(site) || job.target_node, artifact_target: `${job.produces.type}:${job.produces.key}:v${job.produces.version}`, content_hash: E.sha256(rawText), timestamp: 't' };
    const cap = E.capture(st, { job_id: job.job_id, raw_text: rawText, envelope });
    if (cap.ok) {
      rejects[job.job_id] = 0;
      notify('captured', { site, artifact_id: cap.artifact_id, type: job.produces.type, key: job.produces.key });
      save(); advance();
      return { handled: true, kind: 'REQUEST', ok: true, artifact_id: cap.artifact_id };
    }
    // Rejected: keep the job OPEN, surface the code, re-request up to the cap.
    const n = (rejects[job.job_id] = (rejects[job.job_id] || 0) + 1);
    notify('rejected', { site, type: job.produces.type, key: job.produces.key, code: cap.rejection_code, failed: cap.failed, attempt: n });
    if (n <= MAX_REDISPATCH) { save(); advance(); }
    else { notify('parked', { type: job.produces.type, key: job.produces.key, reason: `rejected ${n} times (${cap.rejection_code})` }); save(); }
    return { handled: true, kind: 'REQUEST', ok: false, code: cap.rejection_code };
  }

  return { start, setRequirements, advance, onReply, status, getStore, setStore, pending, _internals: { dispatch } };
}

// --- prompt composition ----------------------------------------------------
function composePrompt(type, key, job) {
  const head = `[ATELIER job ${job.job_id} · you are ${job.target_node}] Produce exactly one artifact: ${type} for ${key}.`;
  const tail = '\nReturn only the artifact content — no preamble, no "as discussed", no placeholders, no truncation. Everything the next step needs must be in the text itself.';
  const body = {
    STORY_DIRECTION: 'Write the Story Direction: premise, arc, tone, audience.',
    MASTER_OUTLINE: 'Write the Master Chapter Outline as a numbered list, one chapter per line ("1. ...", "2. ..."), each with its story function.',
    BOOK_BIBLE: 'Write the Book Bible: the canon facts and master records, summarized and linked by ID.',
    VOICE_SAMPLE: 'Write a Voice Sample that fixes the prose voice (register, tense, POV, rhythm).',
    CHAPTER_SPEC: `Write the Chapter Spec for ${key}: the required story results this chapter must achieve, and a target length range.`,
    CHAPTER_ROADMAP: `Write the Chapter Roadmap for ${key}. It MUST contain EXACTLY FIVE discrete, distinct, named beats, one per line, each prefixed "Beat N:" — each naming a required story result. Do not write a prose summary; five separable beats are the unit reviews and dependencies attach to.`,
    CHAPTER_DRAFT: `Write the full manuscript for ${key}, following its Spec, Roadmap (achieve each beat's result, arrange as the prose needs), the Book Bible, and the Voice Sample. Stay in canon; flag anything missing rather than inventing it.`,
  }[type] || `Produce the ${type} for ${key}.`;
  return `${head}\n${body}${tail}`;
}
function composeReview(a) {
  const map = {
    STORY: 'STORY review — does the chapter do its job in the book (function, progression, structure, requirement fulfilment)?',
    CANON: 'CANON review — facts, continuity, timeline, character knowledge, contradictions.',
    WRITING: 'WRITING review — prose, dialogue, voice, rhythm, description, emotional impact, repetition.',
    HONEST: 'HONEST READ — as a real reader with ONLY the manuscript in front of you, would you keep reading? Judge experience, not compliance.',
  };
  return `[ATELIER review · ${a.function} of ${a.key}] ${map[a.function] || ''}\n` +
    'Report each problem on its own line as "FINDING: <CRITICAL|MAJOR|MINOR> | <what and where>". If there is nothing to fix, reply "VERDICT: PASS". A canon contradiction, an unmet mandatory requirement, or a factual self-contradiction is always CRITICAL.';
}

// --- reply parsing ---------------------------------------------------------
function parseChapterCount(body) {
  const lines = String(body || '').split('\n');
  let max = 0, count = 0;
  for (const l of lines) { const m = /^\s*(\d+)[.)]\s+\S/.exec(l); if (m) { count++; max = Math.max(max, parseInt(m[1], 10)); } }
  return Math.max(count, max) || 1;
}
function parseReview(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /FINDING:\s*(CRITICAL|MAJOR|MINOR)\s*[|\-:]\s*(.+)/i.exec(l);
    if (m) out.push({ severity: m[1].toUpperCase(), description: m[2].trim(), location: '' });
  }
  return out;
}

module.exports = { createRunner, composePrompt, composeReview, parseChapterCount, parseReview, ROLE_SITE, SITE_ROLE };
