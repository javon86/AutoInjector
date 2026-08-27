'use strict';
/*
 * atelier-engine.js — the governed, derived-state book engine (ATELIER Engine
 * Spec v3.0). This is the state machine underneath Book Studio.
 *
 * GOVERNING PRINCIPLE: advancement is DERIVED, never asserted. Nothing stores a
 * writable "current step". The book's state is computed from the record set on
 * every read; if the records don't support a transition, the transition does not
 * exist. This is the single fix for the old defect (Book Studio advancing a
 * sequence with no captured/validated/approved response).
 *
 * This module is pure logic over a `store` (the record arrays). Persistence is a
 * non-goal here — atelier-store.js loads/saves the store as on-disk JSON. Panel
 * styling, prompt text and model wiring are also out of scope: the panel is a
 * projection of deriveBook() (§10), and jobs are surfaced to the human operator
 * who relays them to the AI panes (no dispatcher, no API — a clipboard relay).
 */
const crypto = require('crypto');

// ---- enums ----------------------------------------------------------------
const ARTIFACT_STATE = { ABSENT: 'ABSENT', REQUESTED: 'REQUESTED', CAPTURED: 'CAPTURED', REJECTED: 'REJECTED', CANDIDATE: 'CANDIDATE', APPROVED: 'APPROVED', STALE: 'STALE', LOCKED: 'LOCKED', SUPERSEDED: 'SUPERSEDED' };
const JOB_STATE = { DRAFTED: 'DRAFTED', OPEN: 'OPEN', RESPONDED: 'RESPONDED', EXPIRED: 'EXPIRED', CANCELLED: 'CANCELLED', CLOSED: 'CLOSED' };
const VERDICT = { PASS: 'PASS', PASS_WITH_NOTES: 'PASS_WITH_NOTES', FAIL: 'FAIL' };
const SEVERITY = { CRITICAL: 'CRITICAL', MAJOR: 'MAJOR', MINOR: 'MINOR' };
const NODE = { USER: 'USER', STORY: 'STORY', CANON: 'CANON', WRITING: 'WRITING' };
const REVIEW_FN = ['STORY', 'CANON', 'WRITING', 'HONEST'];

// ---- artifact type registry (§3) ------------------------------------------
// owner: which node may author it. scope: BOOK (one) / CH (per chapter) / GRP /
// BOOK-review. min_len: capture length floor. schema: structural validator id.
const REGISTRY = {
  REQUIREMENTS:     { scope: 'BOOK', owner: NODE.USER,    min_len: 20 },
  STORY_DIRECTION:  { scope: 'BOOK', owner: NODE.STORY,   min_len: 40 },
  MASTER_OUTLINE:   { scope: 'BOOK', owner: NODE.STORY,   min_len: 40 },
  BOOK_BIBLE:       { scope: 'BOOK', owner: NODE.CANON,   min_len: 40 },
  VOICE_SAMPLE:     { scope: 'BOOK', owner: NODE.WRITING, min_len: 40 },
  CHAPTER_SPEC:     { scope: 'CH',   owner: NODE.STORY,   min_len: 30 },
  CHAPTER_ROADMAP:  { scope: 'CH',   owner: NODE.CANON,   min_len: 30, schema: 'roadmap5beats' },
  CHAPTER_DRAFT:    { scope: 'CH',   owner: NODE.WRITING, min_len: 100 },
};

// Dependency resolution (§3 / §5). Returns the exact record slots that must be
// APPROVED (or LOCKED, flagged) before `type@key` can be requested — also the
// versions an artifact of this type pins its edges to (§1.5, §8).
function depsFor(type, key, store) {
  const n = chapterNum(key);
  switch (type) {
    case 'REQUIREMENTS': return [];
    case 'STORY_DIRECTION': return [{ type: 'REQUIREMENTS', key: 'BOOK' }];
    case 'MASTER_OUTLINE': return [{ type: 'STORY_DIRECTION', key: 'BOOK' }];
    case 'BOOK_BIBLE': return [{ type: 'MASTER_OUTLINE', key: 'BOOK' }, { type: 'REQUIREMENTS', key: 'BOOK' }];
    case 'VOICE_SAMPLE': return [{ type: 'BOOK_BIBLE', key: 'BOOK' }, { type: 'STORY_DIRECTION', key: 'BOOK' }];
    case 'CHAPTER_SPEC': return [{ type: 'MASTER_OUTLINE', key: 'BOOK' }];
    case 'CHAPTER_ROADMAP': {
      const d = [{ type: 'CHAPTER_SPEC', key }, { type: 'BOOK_BIBLE', key: 'BOOK' }];
      if (n > 1) d.push({ type: 'CHAPTER_DRAFT', key: `CH-${n - 1}`, needs: ARTIFACT_STATE.LOCKED });
      return d;
    }
    case 'CHAPTER_DRAFT': return [{ type: 'CHAPTER_SPEC', key }, { type: 'CHAPTER_ROADMAP', key }, { type: 'BOOK_BIBLE', key: 'BOOK' }, { type: 'VOICE_SAMPLE', key: 'BOOK' }];
    default: return [];
  }
}

// ---- small helpers --------------------------------------------------------
function sha256(s) { return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex'); }
function normalize(s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim(); }
function bodyHash(body) { return sha256(normalize(body)); }
function chapterNum(key) { const m = /CH-(\d+)/.exec(String(key || '')); return m ? parseInt(m[1], 10) : 0; }
function ownerNode(type) { return REGISTRY[type] ? REGISTRY[type].owner : NODE.USER; }

function newStore(bookId) {
  return { bookId: bookId || 'book', artifacts: [], jobs: [], responses: [], reviews: [], edges: [], events: [], overrides: [], counters: {}, chapterCount: 0, mandatoryReqs: [] };
}
function _seq(store, k) { store.counters[k] = (store.counters[k] || 0) + 1; return store.counters[k]; }
function _now(store) { return `t${_seq(store, '_clock')}`; } // monotonic logical time (no wall clock — replay-safe)
function _emit(store, actor, verb, subject_id, payload) {
  const ev = { event_id: `EV-${_seq(store, 'EV')}`, ts: _now(store), actor, verb, subject_id, payload_hash: sha256(JSON.stringify(payload || {})) };
  store.events.push(ev); return ev;
}

// ---- record queries (state is derived; these never mutate) ----------------
function artifactsOf(store, type, key) { return store.artifacts.filter((a) => a.type === type && a.key === key).sort((a, b) => a.version - b.version); }
function latest(store, type, key) { const a = artifactsOf(store, type, key); return a.length ? a[a.length - 1] : null; }
// The current "live" artifact for a slot: the highest-version one that is not
// SUPERSEDED/REJECTED (APPROVED/LOCKED/CANDIDATE/STALE).
function live(store, type, key) {
  const live = store.artifacts.filter((a) => a.type === type && a.key === key && a.state !== ARTIFACT_STATE.SUPERSEDED && a.state !== ARTIFACT_STATE.REJECTED);
  return live.length ? live.sort((a, b) => b.version - a.version)[0] : null;
}
function stateOf(store, type, key) { const a = live(store, type, key); return a ? a.state : ARTIFACT_STATE.ABSENT; }
function isApproved(store, type, key) { const a = live(store, type, key); return !!a && (a.state === ARTIFACT_STATE.APPROVED || a.state === ARTIFACT_STATE.LOCKED); }
function openJobFor(store, type, key) { return store.jobs.find((j) => j.produces.type === type && j.produces.key === key && j.state === JOB_STATE.OPEN) || null; }

// A dep is satisfied when its live artifact is APPROVED (or LOCKED if required),
// and not STALE. Returns { ok, missing:[...], stale:[...] }.
function depsSatisfied(store, type, key) {
  const missing = [], stale = [];
  for (const d of depsFor(type, key, store)) {
    const a = live(store, d.type, d.key);
    if (!a) { missing.push(`${d.type}:${d.key}`); continue; }
    if (a.state === ARTIFACT_STATE.STALE) { stale.push(`${d.type}:${d.key}`); continue; }
    if (d.needs === ARTIFACT_STATE.LOCKED) { if (a.state !== ARTIFACT_STATE.LOCKED) missing.push(`${d.type}:${d.key} (needs LOCKED)`); }
    else if (a.state !== ARTIFACT_STATE.APPROVED && a.state !== ARTIFACT_STATE.LOCKED) missing.push(`${d.type}:${d.key} (needs APPROVED, is ${a.state})`);
  }
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

// ---- structural schema validators (§6, check 10) --------------------------
// D-2: the roadmap is a STRUCTURAL obligation — CANON must supply exactly five
// discrete named beats (the unit reviews/deps attach to). WRITING may later
// deviate in the prose; that's an execution choice, not a roadmap requirement.
function checkRoadmapBeats(body) {
  const beats = String(body || '').split('\n').map((l) => l.trim())
    .filter((l) => /^(beat\s*\d+\s*[:\-]|[-*]\s+|\d+[.)]\s+)/i.test(l));
  const named = beats.filter((l) => l.replace(/^(beat\s*\d+\s*[:\-]|[-*]\s+|\d+[.)]\s+)/i, '').trim().length >= 3);
  const distinct = new Set(named.map((l) => l.toLowerCase().replace(/\s+/g, ' ')));
  if (named.length !== 5) return { ok: false, detail: `roadmap must contain exactly 5 named beats (found ${named.length})` };
  if (distinct.size !== 5) return { ok: false, detail: 'roadmap beats must be distinct' };
  return { ok: true };
}
const TRUNCATION_RE = /\[continues\]|\[truncated\]|…\s*$|\bTODO\b|```[^`]*$/i;
const PLACEHOLDER_RE = /^(loading|regenerate|new chat|send a message|thinking\.\.\.|copy code)$/i;

// ---- capture: validator chain (§6) → promote to CANDIDATE -----------------
// Every response runs the full chain. ALL failures are reported (don't stop at
// the first). Promotion is the only path from text to artifact.
function captureValidate(store, job, raw_text, envelope) {
  const fails = [];
  const type = job.produces.type;
  const reg = REGISTRY[type] || {};
  const body = normalize(raw_text);
  // 1 job_id matches an OPEN job
  if (!job || job.state !== JOB_STATE.OPEN) fails.push({ code: 'E-CAP-010', detail: 'job_id does not match an OPEN job' });
  // 2 envelope present & complete (§6.2)
  const need = ['job_id', 'seq', 'node', 'artifact_target', 'content_hash', 'timestamp'];
  const env = envelope || {};
  if (need.some((f) => env[f] == null || env[f] === '')) fails.push({ code: 'E-PROV-010', detail: 'provenance envelope missing/incomplete' });
  // 3 seq matches job seq exactly
  if (env.seq !== job.seq) fails.push({ code: 'E-PROV-020', detail: `envelope seq ${env.seq} != job seq ${job.seq}` });
  // 4 content_hash matches raw_text
  if (env.content_hash !== sha256(raw_text)) fails.push({ code: 'E-PROV-030', detail: 'content_hash does not match raw_text' });
  // 5 not a duplicate body_hash for this slot
  const bh = bodyHash(raw_text);
  if (store.artifacts.some((a) => a.type === type && a.key === job.produces.key && a.body_hash === bh)) fails.push({ code: 'E-CAP-020', detail: 'duplicate body for this slot' });
  // 6 placeholder / UI-chrome
  if (!body || PLACEHOLDER_RE.test(body)) fails.push({ code: 'E-CAP-030', detail: 'looks like placeholder / UI chrome, not real content' });
  // 7 length floor
  if (body.length < (reg.min_len || 1)) fails.push({ code: 'E-CAP-040', detail: `body too short (< ${reg.min_len} chars)` });
  // 8 truncation markers
  if (TRUNCATION_RE.test(raw_text)) fails.push({ code: 'E-CAP-050', detail: 'truncation marker / unbalanced fence detected' });
  // 9 node authority matches owner_node
  if (env.node && reg.owner && env.node !== reg.owner) fails.push({ code: 'E-AUTH-010', detail: `node ${env.node} may not author ${type} (owner ${reg.owner})` });
  // 10 structural schema for the type
  if (reg.schema === 'roadmap5beats') { const r = checkRoadmapBeats(body); if (!r.ok) fails.push({ code: 'E-CAP-060', detail: r.detail }); }
  // 11 deps in manifest still APPROVED, not STALE
  const ds = depsSatisfied(store, type, job.produces.key);
  if (!ds.ok) fails.push({ code: 'E-DEP-020', detail: `deps not satisfied: ${[...ds.missing, ...ds.stale.map((s) => s + ' (STALE)')].join(', ')}` });
  return fails;
}

// ---- public actions (each appends records + emits events) -----------------

// USER supplies the root requirements (authored, not captured). mandatory: the
// requirement ids that every chapter must satisfy (feed the hard-fail rule).
function supplyRequirements(store, { body, mandatory }) {
  const art = _mkArtifact(store, 'REQUIREMENTS', 'BOOK', body, NODE.USER, null);
  art.state = ARTIFACT_STATE.APPROVED; // USER-authored artifacts are self-approved
  store.mandatoryReqs = Array.isArray(mandatory) ? mandatory.slice() : [];
  _emit(store, NODE.USER, 'APPROVE', art.artifact_id, { type: 'REQUIREMENTS' });
  return art;
}
// Fix the chapter count (the outline decides it; in the real system this is
// parsed from MASTER_OUTLINE — here it's set explicitly once the outline lands).
function setChapterCount(store, n) { store.chapterCount = Math.max(0, n | 0); return store.chapterCount; }

function _mkArtifact(store, type, key, body, owner, source_response_id) {
  const version = _seq(store, `V:${type}:${key}`);
  const art = {
    artifact_id: `ART-${type}-${key}-v${version}`, type, key, version,
    state: ARTIFACT_STATE.CANDIDATE, owner_node: owner || ownerNode(type),
    body: String(body == null ? '' : body), body_hash: bodyHash(body),
    deps: [], source_response_id: source_response_id || null, stale_reason: null, created_at: _now(store),
  };
  // Supersede any prior live artifact for this slot and pin dep edges (§1.5, §8).
  const prior = live(store, type, key);
  if (prior && prior.state !== ARTIFACT_STATE.LOCKED) { prior.state = ARTIFACT_STATE.SUPERSEDED; _emit(store, NODE.USER, 'SUPERSEDE', prior.artifact_id, {}); }
  for (const d of depsFor(type, key, store)) { const dep = live(store, d.type, d.key); if (dep) { const e = { from_artifact_id: art.artifact_id, to_artifact_id: dep.artifact_id, kind: 'DERIVES_FROM' }; store.edges.push(e); art.deps.push(e); } }
  store.artifacts.push(art);
  _emit(store, art.owner_node, 'MATERIALIZE', art.artifact_id, { type, version });
  return art;
}

// Open a JOB for a requestable artifact slot (G-01..G-13 requestability).
// `revision: true` re-opens an already-approved slot for a new version (a
// USER-initiated revise); it still requires satisfied deps and no open job.
function openJob(store, { type, key, context_policy, revision }) {
  const rq = revision ? (depsSatisfied(store, type, key).ok ? { ok: true } : { ok: false, reason: 'deps not satisfied' }) : requestable(store, type, key);
  if (!rq.ok) return { ok: false, error: 'E-GATE-010', reason: rq.reason };
  if (openJobFor(store, type, key)) return { ok: false, error: 'E-JOB-010', reason: 'a job is already OPEN for this slot' };
  const owner = ownerNode(type);
  const seqNum = _seq(store, `SEQ:${owner}`);
  const nextV = (store.counters[`V:${type}:${key}`] || 0) + 1;
  const job = {
    job_id: `JOB-${_seq(store, 'JOB')}`, seq: `${owner}-${String(seqNum).padStart(3, '0')}`,
    target_node: owner, produces: { type, key, version: nextV },
    context_manifest: depsFor(type, key, store).map((d) => { const a = live(store, d.type, d.key); return a ? a.artifact_id : null; }).filter(Boolean),
    context_policy: context_policy || 'FULL', prompt_hash: sha256(`${type}:${key}:${nextV}`),
    state: JOB_STATE.OPEN, issued_at: _now(store), expires_at: null,
  };
  store.jobs.push(job);
  _emit(store, NODE.USER, 'JOB_OPEN', job.job_id, { type, key });
  return { ok: true, job };
}

// Capture a response against an OPEN job. Runs the full validator chain; on
// pass, a CANDIDATE artifact is created (the ONLY path from text to artifact);
// on any failure the response is QUARANTINED with all failed codes, and the job
// stays OPEN (§6.3). Idempotent by (job_id, body_hash).
function capture(store, { job_id, raw_text, envelope }) {
  const job = store.jobs.find((j) => j.job_id === job_id);
  if (!job) return { ok: false, rejection_code: 'E-JOB-020', detail: 'no such job' };
  const resp = { response_id: `RESP-${_seq(store, 'RESP')}`, job_id, raw_text: String(raw_text == null ? '' : raw_text), envelope: envelope || {}, state: 'QUARANTINED', rejection_code: null };
  store.responses.push(resp);
  _emit(store, job.target_node, 'RESPONSE_RECEIVED', resp.response_id, { job_id });
  const fails = captureValidate(store, job, raw_text, envelope);
  if (fails.length) {
    resp.state = 'REJECTED'; resp.rejection_code = fails[0].code; resp.failed = fails;
    _emit(store, job.target_node, 'RESPONSE_REJECTED', resp.response_id, { codes: fails.map((f) => f.code) });
    return { ok: false, rejection_code: fails[0].code, failed: fails };
  }
  const art = _mkArtifact(store, job.produces.type, job.produces.key, raw_text, job.target_node, resp.response_id);
  resp.state = 'PROMOTED';
  job.state = JOB_STATE.CLOSED;
  _emit(store, NODE.USER, 'PROMOTE', art.artifact_id, { response_id: resp.response_id });
  return { ok: true, artifact_id: art.artifact_id, artifact: art };
}

// Owner review + USER approval: CANDIDATE → APPROVED. (The spec separates owner
// review from user approval; the engine treats an approve as both, since only
// USER can call it. STALE artifacts cannot be approved without an override.)
function approve(store, artifact_id) {
  const art = store.artifacts.find((a) => a.artifact_id === artifact_id);
  if (!art) return { ok: false, error: 'no such artifact' };
  if (art.state === ARTIFACT_STATE.STALE) return { ok: false, error: 'E-DEP-020', reason: 'artifact is STALE; revalidate or override' };
  if (art.state !== ARTIFACT_STATE.CANDIDATE) return { ok: false, error: `cannot approve from ${art.state}` };
  if (!normalize(art.body)) return { ok: false, error: 'E-CAP-040', reason: 'empty body may never be approved (Invariant A1)' };
  art.state = ARTIFACT_STATE.APPROVED;
  _emit(store, NODE.USER, 'APPROVE', art.artifact_id, {});
  // A new APPROVED version invalidates dependents pinned to the prior version (§8).
  _propagateStale(store, art);
  if (art.type === 'MASTER_OUTLINE' && !store.chapterCount) { /* caller sets chapterCount from outline */ }
  return { ok: true, artifact: art };
}

// §8 staleness: dependents pinned to a superseded version of this slot go STALE.
function _propagateStale(store, approvedArt) {
  const superseded = store.artifacts.filter((a) => a.type === approvedArt.type && a.key === approvedArt.key && a.state === ARTIFACT_STATE.SUPERSEDED);
  const oldIds = new Set(superseded.map((a) => a.artifact_id));
  if (!oldIds.size) return;
  const queue = [...oldIds];
  const seen = new Set();
  while (queue.length) {
    const oldId = queue.shift(); if (seen.has(oldId)) continue; seen.add(oldId);
    for (const e of store.edges.filter((e) => e.to_artifact_id === oldId)) {
      const dep = store.artifacts.find((a) => a.artifact_id === e.from_artifact_id);
      if (dep && (dep.state === ARTIFACT_STATE.APPROVED || dep.state === ARTIFACT_STATE.CANDIDATE)) {
        dep.state = ARTIFACT_STATE.STALE; dep.stale_reason = `dependency ${oldId} superseded`;
        _emit(store, NODE.USER, 'STALE', dep.artifact_id, { because: oldId });
        queue.push(dep.artifact_id); // transitive (§8.3)
      }
    }
  }
}

// A REVIEW against a pinned draft version. verdict is COMPUTED from findings
// (Invariant R1): any CRITICAL ⇒ FAIL, regardless of score. Score is display-only.
function addReview(store, { function: fn, subject, findings, score }) {
  const art = store.artifacts.find((a) => a.artifact_id === subject);
  if (!art || art.type !== 'CHAPTER_DRAFT') return { ok: false, error: 'review subject must be a chapter draft' };
  if (!REVIEW_FN.includes(fn)) return { ok: false, error: 'unknown review function' };
  const f = Array.isArray(findings) ? findings : [];
  const hasCritical = f.some((x) => x.severity === SEVERITY.CRITICAL);
  const verdict = hasCritical ? VERDICT.FAIL : (f.length ? VERDICT.PASS_WITH_NOTES : VERDICT.PASS);
  const rev = { review_id: `REV-${_seq(store, 'REV')}`, function: fn, subject, subject_version: art.version, verdict, score: score == null ? 100 : score, findings: f };
  store.reviews.push(rev);
  _emit(store, ownerFor(fn), 'REVIEW', rev.review_id, { subject, verdict });
  return { ok: true, review: rev };
}
function ownerFor(fn) { return fn === 'STORY' ? NODE.STORY : fn === 'CANON' ? NODE.CANON : fn === 'WRITING' ? NODE.WRITING : NODE.USER; }
function reviewsFor(store, draft) { return store.reviews.filter((r) => r.subject === draft.artifact_id && r.subject_version === draft.version); }

// ---- gates (§5): pure predicates over records -----------------------------
// Requestability of an artifact slot (the "→ X requestable" gates + no open job
// + not already satisfied). Returns { ok, reason }.
function requestable(store, type, key) {
  if (!REGISTRY[type]) return { ok: false, reason: `unknown type ${type}` };
  const cur = live(store, type, key);
  if (cur && (cur.state === ARTIFACT_STATE.APPROVED || cur.state === ARTIFACT_STATE.LOCKED || cur.state === ARTIFACT_STATE.CANDIDATE)) return { ok: false, reason: `${type}:${key} already ${cur.state}` };
  const ds = depsSatisfied(store, type, key);
  if (!ds.ok) return { ok: false, reason: `deps: ${[...ds.missing, ...ds.stale.map((s) => s + ' STALE')].join(', ')}` };
  // roadmap extra gate: prior chapter draft LOCKED already covered by depsFor.
  return { ok: true };
}

// G-21: a chapter may LOCK when its draft has all four reviews against the same
// version, zero CRITICAL findings, all mandatory requirements met, deps not STALE.
function canLock(store, key) {
  const draft = live(store, 'CHAPTER_DRAFT', key);
  const reasons = [];
  if (!draft) return { ok: false, reasons: ['no draft'] };
  if (draft.state === ARTIFACT_STATE.LOCKED) return { ok: false, reasons: ['already locked'] };
  if (draft.state === ARTIFACT_STATE.STALE) reasons.push('draft is STALE');
  const revs = reviewsFor(store, draft);
  const fns = new Set(revs.map((r) => r.function));
  for (const need of REVIEW_FN) if (!fns.has(need)) reasons.push(`missing ${need} review`);
  if (revs.some((r) => r.verdict === VERDICT.FAIL)) reasons.push('a review FAILed');
  if (revs.some((r) => r.findings.some((f) => f.severity === SEVERITY.CRITICAL))) reasons.push('open CRITICAL finding');
  const met = new Set(revs.flatMap((r) => r.findings).map((f) => f.requirement_id).filter(Boolean));
  for (const req of store.mandatoryReqs) { if ([...met].includes(req)) reasons.push(`mandatory ${req} unmet (flagged)`); }
  const ds = depsSatisfied(store, 'CHAPTER_DRAFT', key);
  if (!ds.ok) reasons.push(`deps: ${[...ds.missing, ...ds.stale].join(', ')}`);
  return { ok: reasons.length === 0, reasons };
}
function lockChapter(store, key) {
  const g = canLock(store, key);
  if (!g.ok) return { ok: false, error: 'E-GATE-010', reasons: g.reasons };
  const draft = live(store, 'CHAPTER_DRAFT', key);
  draft.state = ARTIFACT_STATE.LOCKED;
  _emit(store, NODE.USER, 'LOCK', draft.artifact_id, { key });
  return { ok: true, artifact: draft };
}

// Assembly (§G-28): MANUSCRIPT = every locked chapter in order, hashes matching.
function assemble(store) {
  const reasons = [];
  const chapters = [];
  for (let n = 1; n <= store.chapterCount; n++) {
    const d = live(store, 'CHAPTER_DRAFT', `CH-${n}`);
    if (!d || d.state !== ARTIFACT_STATE.LOCKED) { reasons.push(`CH-${n} not LOCKED`); continue; }
    if (d.body_hash !== bodyHash(d.body)) { reasons.push(`CH-${n} body_hash mismatch`); continue; }
    chapters.push(d);
  }
  if (reasons.length) return { ok: false, error: 'E-ASM-010', reasons };
  const body = chapters.map((d, i) => `# Chapter ${i + 1}\n\n${d.body}`).join('\n\n');
  const man = _mkArtifact(store, 'MANUSCRIPT', 'BOOK', body, NODE.USER, null);
  man.state = ARTIFACT_STATE.APPROVED;
  _emit(store, NODE.USER, 'ASSEMBLE', man.artifact_id, { chapters: chapters.length });
  return { ok: true, artifact: man, chapters: chapters.length };
}

// ---- derived state (§4.3/§4.4) — computed, never stored -------------------
function chapterState(store, key) {
  if (!isApproved(store, 'CHAPTER_SPEC', key)) return 'BLOCKED';
  if (!isApproved(store, 'CHAPTER_ROADMAP', key)) return 'SPEC_READY';
  const draft = live(store, 'CHAPTER_DRAFT', key);
  if (!draft) return 'ROADMAP_READY';
  if (draft.state === ARTIFACT_STATE.LOCKED) return 'LOCKED';
  const revs = reviewsFor(store, draft);
  if (revs.some((r) => r.verdict === VERDICT.FAIL)) return 'REVISION';
  return 'IN_REVIEW';
}
function bookState(store) {
  if (!isApproved(store, 'REQUIREMENTS', 'BOOK')) return 'SETUP';
  const planningReady = isApproved(store, 'BOOK_BIBLE', 'BOOK') && isApproved(store, 'VOICE_SAMPLE', 'BOOK') && store.chapterCount > 0
    && allChapters(store).every((k) => isApproved(store, 'CHAPTER_SPEC', k));
  if (!planningReady) return 'PLANNING';
  const allLocked = store.chapterCount > 0 && allChapters(store).every((k) => stateOf(store, 'CHAPTER_DRAFT', k) === ARTIFACT_STATE.LOCKED);
  if (!allLocked) return 'PRODUCTION';
  if (!isApproved(store, 'MANUSCRIPT', 'BOOK')) return 'ASSEMBLY';
  const noOverrides = !store.overrides.some((o) => !o.expired);
  return noOverrides ? 'COMPLETE' : 'ASSEMBLY';
}
function allChapters(store) { return Array.from({ length: store.chapterCount }, (_, i) => `CH-${i + 1}`); }

// The panel projection (§10): blockers + the next safe actions, all derived.
function deriveBook(store) {
  const chapters = {}; for (const k of allChapters(store)) chapters[k] = chapterState(store, k);
  return { state: bookState(store), chapters, blockers: blockers(store), nextActions: nextActions(store) };
}
function blockers(store) {
  const out = [];
  const draftKeys = allChapters(store);
  for (const k of draftKeys) { const g = canLock(store, k); if (live(store, 'CHAPTER_DRAFT', k) && !g.ok && chapterState(store, k) !== 'LOCKED') out.push({ subject: k, gate: 'G-21', reasons: g.reasons }); }
  return out;
}
// Every possible next step whose gate currently PASSes — ranked by pipeline
// order. The panel offers ONLY these (Invariant G1); the driver loops over them.
function nextActions(store) {
  const acts = [];
  const push = (a) => acts.push(a);
  if (!isApproved(store, 'REQUIREMENTS', 'BOOK')) return [{ kind: 'SUPPLY_REQUIREMENTS' }];
  // book-level artifacts, in order
  const bookChain = ['STORY_DIRECTION', 'MASTER_OUTLINE', 'BOOK_BIBLE', 'VOICE_SAMPLE'];
  for (const type of bookChain) {
    const cur = live(store, type, 'BOOK');
    if (cur && cur.state === ARTIFACT_STATE.CANDIDATE) push({ kind: 'APPROVE', artifact_id: cur.artifact_id, type });
    else if (requestable(store, type, 'BOOK').ok) push({ kind: 'REQUEST', type, key: 'BOOK' });
  }
  // chapter specs (need chapter count fixed)
  for (const k of allChapters(store)) {
    const cur = live(store, 'CHAPTER_SPEC', k);
    if (cur && cur.state === ARTIFACT_STATE.CANDIDATE) push({ kind: 'APPROVE', artifact_id: cur.artifact_id, type: 'CHAPTER_SPEC', key: k });
    else if (requestable(store, 'CHAPTER_SPEC', k).ok) push({ kind: 'REQUEST', type: 'CHAPTER_SPEC', key: k });
  }
  // per-chapter production
  for (const k of allChapters(store)) {
    for (const type of ['CHAPTER_ROADMAP', 'CHAPTER_DRAFT']) {
      const cur = live(store, type, k);
      if (cur && cur.state === ARTIFACT_STATE.CANDIDATE) push({ kind: 'APPROVE', artifact_id: cur.artifact_id, type, key: k });
      else if (requestable(store, type, k).ok) push({ kind: 'REQUEST', type, key: k });
    }
    const draft = live(store, 'CHAPTER_DRAFT', k);
    if (draft && (draft.state === ARTIFACT_STATE.APPROVED || draft.state === ARTIFACT_STATE.CANDIDATE)) {
      const have = new Set(reviewsFor(store, draft).map((r) => r.function));
      for (const fn of REVIEW_FN) if (!have.has(fn)) push({ kind: 'REVIEW', function: fn, subject: draft.artifact_id, key: k });
      if (canLock(store, k).ok) push({ kind: 'LOCK', key: k });
    }
  }
  // assembly
  if (store.chapterCount > 0 && allChapters(store).every((k) => stateOf(store, 'CHAPTER_DRAFT', k) === ARTIFACT_STATE.LOCKED) && !isApproved(store, 'MANUSCRIPT', 'BOOK')) push({ kind: 'ASSEMBLE' });
  return acts;
}

module.exports = {
  ARTIFACT_STATE, JOB_STATE, VERDICT, SEVERITY, NODE, REVIEW_FN, REGISTRY,
  newStore, supplyRequirements, setChapterCount, openJob, capture, approve, addReview,
  lockChapter, canLock, assemble, requestable, depsSatisfied, openJobFor, reviewsFor,
  deriveBook, bookState, chapterState, nextActions, blockers,
  live, latest, stateOf, isApproved, sha256, bodyHash, normalize,
};
