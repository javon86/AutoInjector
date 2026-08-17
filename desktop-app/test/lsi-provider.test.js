// test/lsi-provider.test.js — LSI-001 local supervisor. Mocks the model endpoint
// (global.fetch) to verify the contract: schema-valid JSON verdict + confidence,
// input-hash/verdict/latency logging, one reparse attempt, timeout, and
// offline -> PG-only degradation with the caller's safe default.
// Run: node test/lsi-provider.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const lsi = require('../lsi-provider');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const realFetch = global.fetch;
function withFetch(impl, fn) { global.fetch = impl; return fn().finally(() => { global.fetch = realFetch; }); }
function chat(content) { return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' }; }
function initTmp() { lsi.init(fs.mkdtempSync(path.join(os.tmpdir(), 'lsi-'))); }

const CHECK = 'is this a duplicate acknowledgment?';
const ALLOWED = ['DUPLICATE', 'NEW'];

async function testOfflineDegrades() {
  console.log('\n== ask: offline supervisor -> PG-only mode with the caller\'s safe default ==');
  initTmp();
  lsi.setSettings({ enabled: false });
  let called = false;
  await withFetch(async () => { called = true; return chat('{}'); }, async () => {
    const r = await lsi.ask(CHECK, 'Standing by.', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.unavailable && !r.ok && r.verdict === 'NEW' && !called, 'disabled -> unavailable, verdict is the safe default, no network call');
  });
  const log = lsi.logs(1)[0];
  assert(log && log.inputHash && log.inputHash.length > 0 && typeof log.latencyMs === 'number', 'the call is still logged with an input HASH and latency');
  assert(log.inputHash !== 'Standing by.', 'the raw input is not stored — only its hash');
}

async function testHappyPath() {
  console.log('\n== ask: a valid JSON verdict is returned with a confidence score and logged ==');
  initTmp();
  lsi.setSettings({ enabled: true, endpoint: 'http://lsi.local/v1/chat/completions', model: 'qwen-small' });
  let seen = null;
  await withFetch(async (url, opts) => { seen = { url, opts }; return chat(JSON.stringify({ verdict: 'DUPLICATE', confidence: 0.92, reason: 'same as prior ack' })); }, async () => {
    const r = await lsi.ask(CHECK, 'Standing by.', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.ok && r.verdict === 'DUPLICATE' && r.confidence === 0.92, 'returns the schema-valid verdict and confidence');
    assert(!r.unavailable, 'a successful verdict is not marked unavailable');
  });
  assert(seen.url === 'http://lsi.local/v1/chat/completions' && seen.opts.method === 'POST', 'posts to the configured OpenAI-compatible endpoint');
  const body = JSON.parse(seen.opts.body);
  assert(body.model === 'qwen-small' && body.messages.length === 2, 'sends the configured model and a system+user message pair');
  assert(lsi.logs(1)[0].verdict === 'DUPLICATE', 'the verdict is recorded in the log');
}

async function testReparseThenGiveUp() {
  console.log('\n== ask: one reparse attempt on invalid JSON, then VERDICT_UNAVAILABLE + safe default ==');
  initTmp();
  lsi.setSettings({ enabled: true, endpoint: 'http://lsi.local/v1/chat/completions', model: 'm' });

  let calls = 0;
  await withFetch(async () => { calls++; return chat(calls === 1 ? 'uhh I think it is a duplicate?' : JSON.stringify({ verdict: 'NEW', confidence: 0.7 })); }, async () => {
    const r = await lsi.ask(CHECK, 'x', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.ok && r.verdict === 'NEW' && calls === 2, 'a bad first reply triggers exactly one reparse, which succeeds');
  });

  let calls2 = 0;
  await withFetch(async () => { calls2++; return chat('never valid json'); }, async () => {
    const r = await lsi.ask(CHECK, 'x', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.unavailable && r.verdict === 'NEW' && calls2 === 2, 'two invalid replies -> VERDICT_UNAVAILABLE with the safe default, and it stops after one reparse');
  });
}

async function testRejectsOutOfVocabAndTimeout() {
  console.log('\n== ask: a verdict outside the allowed set is invalid; a timeout degrades safely ==');
  initTmp();
  lsi.setSettings({ enabled: true, endpoint: 'http://lsi.local/v1/chat/completions', model: 'm', timeoutMs: 50 });
  await withFetch(async () => chat(JSON.stringify({ verdict: 'MAYBE', confidence: 0.9 })), async () => {
    const r = await lsi.ask(CHECK, 'x', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.unavailable && r.verdict === 'NEW', 'a verdict not in the allowed set is rejected -> safe default');
  });
  await withFetch(() => new Promise((_res, rej) => { const e = new Error('aborted'); e.name = 'AbortError'; setTimeout(() => rej(e), 5); }), async () => {
    const r = await lsi.ask(CHECK, 'x', { allowed: ALLOWED, safeDefault: 'NEW' });
    assert(r.unavailable && r.verdict === 'NEW', 'a timeout/network failure degrades to the safe default, never throws');
  });
}

async function main() {
  await testOfflineDegrades();
  await testHappyPath();
  await testReparseThenGiveUp();
  await testRejectsOutOfVocabAndTimeout();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
