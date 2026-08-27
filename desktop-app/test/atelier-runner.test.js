'use strict';
/*
 * atelier-runner.test.js — drives a whole book through the ENGINE↔RELAY runner,
 * exercising the real dispatch/capture path (compose prompt → send to a pane →
 * pane replies → engine.capture validates → promote/approve/review/lock/assemble)
 * with placeholder panes. Proves the wiring drives to COMPLETE, that a rejected
 * reply is re-requested (not silently accepted or dropped), and that a reply from
 * a pane we didn't dispatch to is ignored.
 *
 * Run: node test/atelier-runner.test.js
 */
const E = require('../atelier-engine');
const { createRunner, SITE_ROLE } = require('../atelier-runner');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// A placeholder pane: given what the runner asked this pane for, produce a valid
// reply. `bad` optionally corrupts one specific (type,key) once.
function makePane(bad) {
  const badUsed = {};
  return function reply(runner, site) {
    const p = runner.pending[site];
    if (!p) return null;
    if (p.review) return 'VERDICT: PASS';
    const { type, key } = p.action;
    if (bad && bad.type === type && bad.key === key && !badUsed[type + key]) { badUsed[type + key] = true; return bad.text; }
    return body(type, key);
  };
}
function body(type, key) {
  const n = /CH-(\d+)/.exec(key || '') ? /CH-(\d+)/.exec(key)[1] : '';
  switch (type) {
    case 'STORY_DIRECTION': return 'Story Direction: a grounded psychological mystery; Elias returns to the town he fled after a package from a man twelve years dead.';
    case 'MASTER_OUTLINE': return 'Master Chapter Outline:\n1. The Package — the anomaly arrives and ties to Elias.\n2. The Road Back — he returns and the town contradicts his memory.';
    case 'BOOK_BIBLE': return 'Book Bible: canon — Elias Mercer 36; iron key opens the house; brother Theo missing; reservoir over the old settlement.';
    case 'VOICE_SAMPLE': return 'Voice Sample: spare, precise, unsettling third-person-limited past tense with restrained emotion.';
    case 'CHAPTER_SPEC': return `Chapter ${n} Spec: required results — establish the anomaly, bind it to Elias, end on a forcing decision. Target 3500-4200 words.`;
    case 'CHAPTER_ROADMAP': return [
      `Beat 1: Elias meets the chapter ${n} anomaly.`, 'Beat 2: He resists what it implies.',
      'Beat 3: A concrete clue makes it undeniable.', 'Beat 4: The town contradicts his memory.',
      'Beat 5: He commits to the action that forces the next chapter.'].join('\n');
    case 'CHAPTER_DRAFT': return `Chapter ${n}. ` + 'Elias Mercer had spent eleven years learning to hear the moment a story stopped being true, and in the doorway he heard it again. '.repeat(4);
    default: return `Placeholder ${type} ${key} ` + 'x'.repeat(60);
  }
}

// Drive the runner to a stop (COMPLETE or stuck), replying to every pending pane.
function drive(runner, pane, maxRounds = 300) {
  runner.advance();
  let rounds = 0;
  while (E.bookState(runner.getStore()) !== 'COMPLETE' && rounds++ < maxRounds) {
    const sites = Object.keys(runner.pending);
    if (!sites.length) { runner.advance(); if (!Object.keys(runner.pending).length) break; continue; }
    for (const site of sites) { if (runner.pending[site]) runner.onReply(site, pane(runner, site)); }
  }
  return rounds;
}

function main() {
  console.log('\n== A) The runner drives a whole book to COMPLETE over the real dispatch/capture path ==');
  const sent = [];
  const notes = [];
  const runner = createRunner({
    send: (site, prompt) => sent.push({ site, prompt }),
    persist: () => {},
    notify: (kind, data) => notes.push({ kind, data }),
    roleOf: (s) => SITE_ROLE[s],
  });
  runner.start('demo', E.newStore('demo'));
  runner.setRequirements('A psychological mystery: Elias returns to the town he fled after a package from a man twelve years dead.', []);

  const rounds = drive(runner, makePane(null));
  const st = runner.getStore();

  assert(E.bookState(st) === 'COMPLETE', `the runner drove the book to COMPLETE (state: ${E.bookState(st)})`);
  assert(rounds < 300, 'it converged (no runaway)');
  assert(E.isApproved(st, 'MANUSCRIPT', 'BOOK'), 'a MANUSCRIPT was assembled from the locked drafts');
  assert(Object.values(E.deriveBook(st).chapters).every((s) => s === 'LOCKED'), 'both chapters derived LOCKED');
  // The roadmap prompt actually instructs the 5-beat structural obligation (D-2).
  assert(sent.some((m) => m.site === 'gemini' && /EXACTLY FIVE/i.test(m.prompt)), 'the roadmap job is dispatched to CANON (gemini) with the 5-beat instruction');
  assert(sent.some((m) => m.site === 'claude' && /manuscript/i.test(m.prompt)), 'the draft job is dispatched to WRITING (claude)');
  assert(notes.some((n) => n.kind === 'captured') && notes.some((n) => n.kind === 'lock') && notes.some((n) => n.kind === 'assemble'), 'the runner emitted capture/lock/assemble notifications');
  // Derived, not stored.
  assert(!('step' in st) && !('currentStep' in st) && !('workflow' in st), 'the engine store has no writable current-step (advancement stays derived)');

  console.log('\n== B) A rejected reply is re-requested, not accepted or dropped ==');
  const sent2 = [];
  const notes2 = [];
  const r2 = createRunner({ send: (s, p) => sent2.push({ site: s, prompt: p }), persist: () => {}, notify: (k, d) => notes2.push({ kind: k, data: d }), roleOf: (s) => SITE_ROLE[s] });
  r2.start('b', E.newStore('b'));
  r2.setRequirements('requirements body for the rejection test, long enough to pass.', []);
  // First CH-1 roadmap reply is a prose summary (no 5 beats) → must be rejected.
  drive(r2, makePane({ type: 'CHAPTER_ROADMAP', key: 'CH-1', text: 'The chapter should introduce Elias, hint at the package, and end tense — one flowing summary.' }));
  const st2 = r2.getStore();
  assert(notes2.some((n) => n.kind === 'rejected' && n.data.code === 'E-CAP-060'), 'the bad roadmap was rejected E-CAP-060 (not silently accepted)');
  const gemRoadmaps = sent2.filter((m) => m.site === 'gemini' && /Chapter Roadmap for CH-1/i.test(m.prompt));
  assert(gemRoadmaps.length >= 2, `the roadmap job was re-requested after rejection (dispatched ${gemRoadmaps.length}x)`);
  assert(E.bookState(st2) === 'COMPLETE', 'after the good re-reply the book still reached COMPLETE');

  console.log('\n== C) A reply from a pane we did not dispatch to is ignored ==');
  const r3 = createRunner({ send: () => {}, persist: () => {}, notify: () => {}, roleOf: (s) => SITE_ROLE[s] });
  r3.start('c', E.newStore('c'));
  r3.setRequirements('requirements body for the stray-reply test, long enough.', []);
  r3.advance(); // dispatches STORY_DIRECTION to chatgpt
  const stray = r3.onReply('gemini', 'a reply from a pane that was never given this job');
  assert(stray.handled === false, 'a reply from a non-pending pane is ignored (the runner tracks who owes which job)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
