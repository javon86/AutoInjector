// test/provider-accuracy.test.js — AI-002 & AI-005: provider status must be
// honest. A /models 404 is "reachable" but NOT connected; Ollama discovery must
// time out with a distinct reason rather than hang.
// Run: node test/provider-accuracy.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const lsi = require('../lsi-provider');
const ollama = require('../ollama-manager');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

async function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = orig; }
}

async function main() {
  console.log('\n== AI-002: LSI /models 404 is reachable but NOT connected ==');
  lsi.init(fs.mkdtempSync(path.join(os.tmpdir(), 'lsi-')));
  lsi.setSettings({ enabled: true, endpoint: 'http://sup.local/v1/chat/completions', model: 'm' });
  const r404 = await withFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }), () => lsi.testConnection());
  assert(r404.ok === false && r404.reachable === true && r404.status === 404,
    'a 404 reports reachable:true but ok:false (not a misleading green)');
  const r200 = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), () => lsi.testConnection());
  assert(r200.ok === true && r200.reachable === true, 'a 2xx reports connected');

  console.log('\n== AI-005: Ollama discovery times out / fails with a distinct reason ==');
  // A closed port fails fast with a reason; a black-hole would hit the abort
  // timeout — either way we must get a structured {ok:false, reason} not a hang.
  const started = Date.now();
  const res = await ollama.listInstalled('http://127.0.0.1:9', 1200);
  const took = Date.now() - started;
  assert(res.ok === false && !!res.reason, `discovery returns a structured failure with a reason ("${res.reason}")`);
  assert(took < 4000, `discovery does not hang (returned in ${took}ms, bounded by the timeout)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
