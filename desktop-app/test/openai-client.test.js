// test/openai-client.test.js — AI-006: the shared OpenAI-compatible client.
// Run: node test/openai-client.test.js
const c = require('../openai-client');

let passed = 0, failed = 0;
function assert(cond, m) { if (cond) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return cond; }
async function withFetch(stub, fn) { const o = global.fetch; global.fetch = stub; try { return await fn(); } finally { global.fetch = o; } }

async function main() {
  console.log('\n== redaction + JSON extraction ==');
  assert(c.redactSecrets('key is sk-abc123 here', 'sk-abc123') === 'key is [REDACTED] here', 'redactSecrets masks the key');
  assert(c.redactSecrets('no key', '') === 'no key' && c.redactSecrets(42, 'x') === 42, 'redactSecrets is a no-op without a key / non-string');
  assert(c.extractJsonObject('{"a":1}').a === 1, 'extractJsonObject parses clean JSON');
  assert(c.extractJsonObject('```json\n{"b":2}\n``` trailing').b === 2, 'extractJsonObject digs JSON out of fences/prose');
  assert(c.extractJsonObject('nope') === null && c.extractJsonObject(null) === null, 'extractJsonObject returns null when there is nothing to parse');

  console.log('\n== chatCompletion maps outcomes structurally ==');
  const okRes = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"action":"WAIT"}' } }] }) }),
    () => c.chatCompletion({ endpoint: 'http://x', model: 'm', messages: [] }));
  assert(okRes.ok && okRes.content === '{"action":"WAIT"}', 'a 2xx returns {ok, content}');
  const httpRes = await withFetch(async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    () => c.chatCompletion({ endpoint: 'http://x', model: 'm', messages: [] }));
  assert(!httpRes.ok && httpRes.kind === 'http' && httpRes.status === 500 && httpRes.detail === 'boom', 'a non-2xx returns kind:http with status + body');
  const badBody = await withFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    () => c.chatCompletion({ endpoint: 'http://x', model: 'm', messages: [] }));
  assert(!badBody.ok && badBody.kind === 'bad-body', 'a 2xx with unparseable body returns kind:bad-body');
  const netRes = await withFetch(async () => { throw new Error('ECONNREFUSED'); },
    () => c.chatCompletion({ endpoint: 'http://x', model: 'm', messages: [] }));
  assert(!netRes.ok && netRes.kind === 'network' && /ECONNREFUSED/.test(netRes.detail), 'a thrown fetch returns kind:network with the raw detail');
  const toRes = await withFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    () => c.chatCompletion({ endpoint: 'http://x', model: 'm', messages: [] }));
  assert(!toRes.ok && toRes.kind === 'timeout', 'an abort returns kind:timeout');

  console.log('\n== probeModels reachability (AI-002) ==');
  const p404 = await withFetch(async (url) => { assert(/\/models$/.test(url), 'probe hits the /models route'); return { ok: false, status: 404 }; },
    () => c.probeModels({ endpoint: 'http://x/v1/chat/completions' }));
  assert(p404.reachable === true && p404.ok === false && p404.status === 404, '404 = reachable but not ok');
  const p200 = await withFetch(async () => ({ ok: true, status: 200 }), () => c.probeModels({ endpoint: 'http://x' }));
  assert(p200.ok === true && p200.reachable === true, '2xx = ok + reachable');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
