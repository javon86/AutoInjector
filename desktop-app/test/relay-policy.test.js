// test/relay-policy.test.js — TR-05 ([TO: USER] stays with the user under Auto)
// and TR-06 (hop limit). Run: node test/relay-policy.test.js
const { meshTargetsFor, createHopCounter, DEFAULT_MAX_AUTO_HOPS } = require('../relay-policy');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const J = JSON.stringify;

console.log('\n== meshTargetsFor (TR-05) ==');
const routing = new Set(['chatgpt', 'gemini']);
assert(J(meshTargetsFor({ site: 'claude', tag: 'USER', routing })) === '[]', '[TO: USER] is not forwarded to the other AIs');
assert(J(meshTargetsFor({ site: 'claude', tag: 'user', routing })) === '[]', 'tag case does not matter');
assert(J(meshTargetsFor({ site: 'claude', tag: null, routing })) === '["chatgpt","gemini"]', 'an untagged reply is still forwarded (Auto behaves as before)');
assert(J(meshTargetsFor({ site: 'claude', tag: 'GEMINI', routing, alreadyCovered: new Set(['gemini']) })) === '["chatgpt"]', '[TO: GEMINI]: Gemini got it from the tag relay, Auto adds only ChatGPT');
assert(J(meshTargetsFor({ site: 'claude', tag: 'ALL', routing, alreadyCovered: new Set(['chatgpt', 'gemini']) })) === '[]', '[TO: ALL]: nobody gets it twice');
assert(J(meshTargetsFor({ site: 'claude', tag: 'USER', routing, stageActive: true })) === '["chatgpt","gemini"]', 'a House Rules stage keeps its own routing');
assert(J(meshTargetsFor({ site: 'claude', tag: null, routing: new Set(['claude', 'gemini']) })) === '["gemini"]', 'never forwards to itself');

console.log('\n== createHopCounter (TR-06) ==');
const h = createHopCounter({ max: 3 });
const r = [h.note(), h.note(), h.note(), h.note(), h.note()];
assert(r.slice(0, 3).every((x) => x.allowed), 'the first 3 hand-offs are allowed');
assert(r[3].allowed === false && r[3].justPaused === true, 'the 4th is blocked and flagged as the moment it paused');
assert(r[4].allowed === false && r[4].justPaused === false, 'later ones stay blocked without repeating the notice');
assert(h.status().paused === true && h.status().hops === 3, 'status shows paused at 3');
h.reset();
assert(h.status().paused === false && h.note().allowed === true, 'a user action resets it');
assert(createHopCounter().status().max === DEFAULT_MAX_AUTO_HOPS && DEFAULT_MAX_AUTO_HOPS >= 20, `default limit ${DEFAULT_MAX_AUTO_HOPS} leaves room for a 20-message run`);
assert(createHopCounter({ max: 'junk' }).status().max === DEFAULT_MAX_AUTO_HOPS, 'a bad setting falls back to the default');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
