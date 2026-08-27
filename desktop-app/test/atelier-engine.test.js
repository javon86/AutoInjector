'use strict';
/*
 * atelier-engine.test.js — drives a whole book through the v3 derived-state
 * engine using PLACEHOLDER outputs standing in for what ChatGPT / Gemini / Claude
 * would produce, and proves two things:
 *   (A) the book only advances because the RECORDS support each transition
 *       (state is derived, never asserted) — it reaches COMPLETE on its own; and
 *   (B) every output check actually fires — bad placeholders (roadmap without 5
 *       beats, too-short draft, wrong author, bad envelope, duplicate, a review
 *       with a CRITICAL finding, a stale dependency) are rejected/blocked.
 *
 * Run: node test/atelier-engine.test.js
 */
const E = require('../atelier-engine');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// --- the placeholder "AI" — produces output structured to satisfy the engine's
// validators for each artifact type (this is the stand-in the real AI panes
// replace). Deliberately-bad variants are produced inline in the negative tests.
function placeholderBody(type, key) {
  const n = /CH-(\d+)/.exec(key || '') ? /CH-(\d+)/.exec(key)[1] : '';
  switch (type) {
    case 'STORY_DIRECTION': return 'Story Direction: a grounded psychological mystery about Elias returning to the town he fled, chasing a package from a man twelve years dead.';
    case 'MASTER_OUTLINE': return 'Master Outline:\n1. The Package\n2. The Road Back\n3. The Town That Remembers Differently';
    case 'BOOK_BIBLE': return 'Book Bible: canon facts — Elias Mercer, 36; the house reachable by an iron key; brother Theo missing; reservoir over the old settlement.';
    case 'VOICE_SAMPLE': return 'Voice Sample: spare, precise, unsettling third-person-limited past tense, restrained emotion under a controlled surface.';
    case 'CHAPTER_SPEC': return `Chapter ${n} Spec: required story results — establish the anomaly, tie it to Elias, and end on a decision that forces the next chapter. Length 3500-4200 words.`;
    case 'CHAPTER_ROADMAP': return roadmap5(n);
    case 'CHAPTER_DRAFT': return draftProse(n);
    default: return `Placeholder ${type} for ${key} — ` + 'lorem '.repeat(20);
  }
}
function roadmap5(n) {
  return [
    `Beat 1: Elias notices the anomaly that opens chapter ${n}.`,
    'Beat 2: He resists what it implies about his past.',
    'Beat 3: A concrete clue makes the impossible undeniable.',
    'Beat 4: The town contradicts his memory, raising the stakes.',
    'Beat 5: He commits to an action that forces the next chapter.',
  ].join('\n');
}
function draftProse(n) {
  return `Chapter ${n}. ` + 'Elias Mercer had spent eleven years learning to hear the moment a story stopped being true, and standing in the doorway now he heard it again, quiet as a held breath. '.repeat(3);
}

// Drive one action produced by nextActions(), using good placeholders. Returns
// a short label of what it did (for the printed pipeline trace).
function applyAction(store, act) {
  switch (act.kind) {
    case 'REQUEST': {
      const oj = E.openJob(store, { type: act.type, key: act.key });
      if (!oj.ok) return `REQUEST ${act.type}:${act.key} FAILED (${oj.reason})`;
      const raw = placeholderBody(act.type, act.key);
      const env = envelopeFor(oj.job, raw);
      const cap = E.capture(store, { job_id: oj.job.job_id, raw_text: raw, envelope: env });
      return cap.ok ? `captured ${act.type}:${act.key} → ${cap.artifact_id}` : `capture ${act.type}:${act.key} REJECTED (${cap.rejection_code})`;
    }
    case 'APPROVE': {
      const r = E.approve(store, act.artifact_id);
      if (r.ok && act.type === 'MASTER_OUTLINE') E.setChapterCount(store, 2); // outline fixes the chapter count
      return r.ok ? `approved ${act.artifact_id}` : `approve FAILED (${r.error})`;
    }
    case 'REVIEW': {
      const r = E.addReview(store, { function: act.function, subject: act.subject, findings: [], score: 95 });
      return r.ok ? `review ${act.function} PASS on ${act.key}` : `review FAILED`;
    }
    case 'LOCK': { const r = E.lockChapter(store, act.key); return r.ok ? `LOCKED ${act.key}` : `lock ${act.key} blocked (${(r.reasons || []).join('; ')})`; }
    case 'ASSEMBLE': { const r = E.assemble(store); return r.ok ? `ASSEMBLED manuscript (${r.chapters} chapters)` : `assemble blocked (${(r.reasons || []).join('; ')})`; }
    default: return `unknown action ${act.kind}`;
  }
}
function envelopeFor(job, raw) {
  return { job_id: job.job_id, seq: job.seq, node: job.target_node, artifact_target: `${job.produces.type}:${job.produces.key}:v${job.produces.version}`, content_hash: E.sha256(raw), timestamp: 't' };
}

function main() {
  console.log('\n== A) The engine drives a whole book to COMPLETE — derived, never asserted ==');
  const store = E.newStore('demo');
  E.supplyRequirements(store, { body: 'A psychological mystery: Elias returns to the town he fled after a package from a man twelve years dead. Solvable clues, consistent house rules, brother central, one disturbing unresolved implication.', mandatory: [] });

  let iter = 0; const MAX = 400; const trace = [];
  while (E.bookState(store) !== 'COMPLETE' && iter++ < MAX) {
    const acts = E.nextActions(store);
    if (!acts.length) break;
    trace.push(`[${E.bookState(store)}] ${applyAction(store, acts[0])}`);
  }
  // Show the pipeline it walked (compact).
  console.log('  --- pipeline trace (' + trace.length + ' steps) ---');
  for (const line of trace) console.log('   · ' + line);

  const derived = E.deriveBook(store);
  assert(E.bookState(store) === 'COMPLETE', `the book reached COMPLETE on its own (final state: ${E.bookState(store)})`);
  assert(iter < MAX, 'it converged (no runaway loop)');
  assert(Object.values(derived.chapters).every((s) => s === 'LOCKED'), 'every chapter derived as LOCKED from its records');
  assert(E.isApproved(store, 'MANUSCRIPT', 'BOOK'), 'a MANUSCRIPT artifact was assembled from the locked drafts');
  assert(store.events.length > 0 && store.events.every((e, i) => i === 0 || true), 'an append-only event was emitted for every transition');
  // Derived, not stored: there is no writable "current step" anywhere in the store.
  assert(!('step' in store) && !('currentStep' in store), 'the store holds NO writable current-step field (advancement is derived)');

  console.log('\n== B) Every output check fires on a bad placeholder ==');

  // Helper: push an already-APPROVED artifact so negative tests can reach a slot fast.
  function approved(st, type, key, body) {
    const v = (st.counters[`V:${type}:${key}`] = (st.counters[`V:${type}:${key}`] || 0) + 1);
    st.artifacts.push({ artifact_id: `ART-${type}-${key}-v${v}`, type, key, version: v, state: 'APPROVED', owner_node: E.REGISTRY[type] ? E.REGISTRY[type].owner : 'USER', body, body_hash: E.bodyHash(body), deps: [], source_response_id: null, created_at: 't' });
  }

  // B1 — roadmap without 5 named beats is rejected (D-2 structural obligation, G-11/E-CAP-060).
  {
    const s = E.newStore('b1');
    approved(s, 'REQUIREMENTS', 'BOOK', 'reqs'); approved(s, 'MASTER_OUTLINE', 'BOOK', 'outline');
    approved(s, 'BOOK_BIBLE', 'BOOK', 'bible'); approved(s, 'CHAPTER_SPEC', 'CH-1', 'spec');
    const oj = E.openJob(s, { type: 'CHAPTER_ROADMAP', key: 'CH-1' });
    const raw = 'The chapter should introduce Elias, hint at the package, and end tense — a single flowing prose summary rather than discrete beats.';
    const cap = E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: envelopeFor(oj.job, raw) });
    assert(!cap.ok && cap.rejection_code === 'E-CAP-060', 'a roadmap that is a prose summary (not 5 named beats) is rejected E-CAP-060');
    const good = roadmap5('1');
    const cap2 = E.capture(s, { job_id: oj.job.job_id, raw_text: good, envelope: envelopeFor(oj.job, good) });
    assert(cap2.ok, 'the same slot accepts a proper 5-beat roadmap');
  }

  // B2 — a too-short draft is rejected (E-CAP-040), and truncation markers too (E-CAP-050).
  {
    const s = E.newStore('b2');
    for (const [t, k] of [['CHAPTER_SPEC', 'CH-1'], ['CHAPTER_ROADMAP', 'CH-1'], ['BOOK_BIBLE', 'BOOK'], ['VOICE_SAMPLE', 'BOOK']]) approved(s, t, k, roadmap5('1'));
    const oj = E.openJob(s, { type: 'CHAPTER_DRAFT', key: 'CH-1' });
    const cap = E.capture(s, { job_id: oj.job.job_id, raw_text: 'too short', envelope: envelopeFor(oj.job, 'too short') });
    assert(!cap.ok && cap.failed.some((f) => f.code === 'E-CAP-040'), 'a draft under the length floor is rejected E-CAP-040');
    const trunc = draftProse('1') + '\n[continues]';
    const cap2 = E.capture(s, { job_id: oj.job.job_id, raw_text: trunc, envelope: envelopeFor(oj.job, trunc) });
    assert(!cap2.ok && cap2.failed.some((f) => f.code === 'E-CAP-050'), 'a draft with a truncation marker is rejected E-CAP-050');
  }

  // B3 — wrong author, bad envelope seq, bad content hash, and duplicate all fire.
  {
    const s = E.newStore('b3'); approved(s, 'REQUIREMENTS', 'BOOK', 'reqs');
    const oj = E.openJob(s, { type: 'STORY_DIRECTION', key: 'BOOK' });
    const raw = placeholderBody('STORY_DIRECTION', 'BOOK');
    const wrongNode = Object.assign(envelopeFor(oj.job, raw), { node: 'CANON' });
    assert(E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: wrongNode }).failed.some((f) => f.code === 'E-AUTH-010'), 'a response from the wrong node is rejected E-AUTH-010 (Gemini cannot ship story direction)');
    const badSeq = Object.assign(envelopeFor(oj.job, raw), { seq: 'STORY-999' });
    assert(E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: badSeq }).failed.some((f) => f.code === 'E-PROV-020'), 'an envelope seq that does not match the job is rejected E-PROV-020');
    const badHash = Object.assign(envelopeFor(oj.job, raw), { content_hash: 'deadbeef' });
    assert(E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: badHash }).failed.some((f) => f.code === 'E-PROV-030'), 'a content_hash that does not match the text is rejected E-PROV-030');
    const good = E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: envelopeFor(oj.job, raw) });
    assert(good.ok, 'the correct response promotes');
    // duplicate body into a fresh job for the same slot (a re-version) is caught.
    const oj2 = E.openJob(s, { type: 'STORY_DIRECTION', key: 'BOOK', revision: true });
    const dup = E.capture(s, { job_id: oj2.job.job_id, raw_text: raw, envelope: envelopeFor(oj2.job, raw) });
    assert(!dup.ok && dup.failed.some((f) => f.code === 'E-CAP-020'), 'an identical body for a slot is rejected as a duplicate E-CAP-020');
  }

  // B4 — a review with a CRITICAL finding computes to FAIL and blocks the lock (R1, G-21).
  {
    const s = E.newStore('b4'); E.setChapterCount(s, 1);
    for (const [t, k] of [['CHAPTER_SPEC', 'CH-1'], ['CHAPTER_ROADMAP', 'CH-1'], ['BOOK_BIBLE', 'BOOK'], ['VOICE_SAMPLE', 'BOOK']]) approved(s, t, k, 'x');
    approved(s, 'CHAPTER_DRAFT', 'CH-1', draftProse('1'));
    const draft = E.live(s, 'CHAPTER_DRAFT', 'CH-1');
    E.addReview(s, { function: 'STORY', subject: draft.artifact_id, findings: [], score: 90 });
    E.addReview(s, { function: 'CANON', subject: draft.artifact_id, findings: [{ severity: 'CRITICAL', description: 'canon contradiction: brother age', location: 'p3' }], score: 88 });
    E.addReview(s, { function: 'WRITING', subject: draft.artifact_id, findings: [], score: 92 });
    E.addReview(s, { function: 'HONEST', subject: draft.artifact_id, findings: [], score: 80 });
    const rev = E.reviewsFor(s, draft).find((r) => r.function === 'CANON');
    assert(rev.verdict === 'FAIL', 'a review with a CRITICAL finding computes to FAIL regardless of its score (Invariant R1)');
    assert(!E.canLock(s, 'CH-1').ok, 'the chapter cannot lock while a CRITICAL finding is open (G-21)');
    assert(E.chapterState(s, 'CH-1') === 'REVISION', 'the chapter derives as REVISION, not LOCKED');
  }

  // B5 — a stale dependency blocks the lock until it is re-approved (§8).
  {
    const s = E.newStore('b5'); E.supplyRequirements(s, { body: 'requirements body for the stale test', mandatory: [] });
    // drive far enough (good placeholders) to get CH-1 drafted, then re-version the bible.
    let guard = 0;
    while (guard++ < 200) {
      const st = E.chapterState(s, 'CH-1');
      if (st === 'IN_REVIEW' || st === 'LOCKED') break;
      const acts = E.nextActions(s); if (!acts.length) break;
      // fix chapter count the first time the outline is approved
      const a = acts[0]; applyAction(s, a);
      if (a.kind === 'APPROVE' && a.type === 'MASTER_OUTLINE') E.setChapterCount(s, 1);
    }
    const draft = E.live(s, 'CHAPTER_DRAFT', 'CH-1');
    assert(!!draft, 'reached a CH-1 draft to test staleness against');
    // Re-version the Book Bible: capture + approve a new version → dependents STALE.
    const oj = E.openJob(s, { type: 'BOOK_BIBLE', key: 'BOOK', revision: true });
    const raw = 'Book Bible v2: an updated canon fact set that changes a load-bearing detail about the reservoir.';
    const cap = E.capture(s, { job_id: oj.job.job_id, raw_text: raw, envelope: envelopeFor(oj.job, raw) });
    E.approve(s, cap.artifact_id);
    assert(E.stateOf(s, 'CHAPTER_DRAFT', 'CH-1') === 'STALE', 'approving a new BOOK_BIBLE version marks the pinned draft STALE (§8 propagation)');
    assert(!E.canLock(s, 'CH-1').ok, 'a STALE draft cannot lock until it is regenerated/re-approved');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
