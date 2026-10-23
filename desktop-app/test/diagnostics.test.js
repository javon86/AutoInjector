// test/diagnostics.test.js — the quick System Check (OP-14): checks run at the
// same time with per-check time limits (fast), and each result says what was
// actually checked: ✅ working / ❌ turned on but broken / ⚪ not set up
// (optional). Slow and hanging probes are simulated with timers; one real
// localhost server checks the ping path end to end.
// Run: node test/diagnostics.test.js
const http = require('http');
const net = require('net');
const diag = require('../diagnostics');
const ed = require('../endpoint-detect');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
const never = () => new Promise(() => {});
const byName = (r, re) => r.checks.find((c) => re.test(c.name));

// A machine where everything is set up and answering.
function healthyDeps(delayMs = 0) {
  const slow = (v) => (delayMs ? sleep(delayMs, v) : Promise.resolve(v));
  return {
    managerConfig: () => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2:3b' }),
    interpreterStatus: () => ({ enabled: true, configured: true, endpoint: 'http://127.0.0.1:8231/run' }),
    voiceStatus: () => ({ enabled: true, configured: true, endpoint: 'http://127.0.0.1:8240' }),
    imageStatus: () => ({ enabled: true, configured: true, endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img' }),
    videoStatus: () => ({ enabled: false, configured: false, endpoint: '' }),
    pythonStatus: () => slow({ missing: false, compatible: true, version: '3.12', note: 'Using Python 3.12.' }),
    toolList: () => [{ name: 'read-file' }],
    dbStatus: () => ({ available: true, count: 3 }),
    modelsRoot: () => '/tmp/stuff and thing',
    gpuRead: () => slow({ available: true, gpus: [{ name: 'RTX 3060', memTotal: 12288 }] }),
    enabledSites: () => ['chatgpt', 'claude'],
    probe: (url) => slow({ reachable: true, base: new URL(url).origin }),
    installTargets: () => [
      { id: 'open-interpreter', label: 'Open Interpreter', kind: 'pip' },
      { id: 'stability-matrix', label: 'Stability Matrix', kind: 'handoff' },
    ],
    detectInstalls: () => slow({ 'open-interpreter': { id: 'open-interpreter', installed: false }, 'stability-matrix': { installed: null, reason: 'external installer' } }),
  };
}

async function main() {
  console.log('\n== withTimeout: resolves, times out, and turns a rejection into a result ==');
  assert((await diag.withTimeout(Promise.resolve(5), 100)) === 5, 'a fast promise resolves with its value');
  const to = await diag.withTimeout(never(), 30);
  assert(to && to.ok === false && to.error === 'TIMEOUT', 'a hung promise resolves { ok:false, error:TIMEOUT } after the limit');
  const rej = await diag.withTimeout(Promise.reject(new Error('boom')), 100);
  assert(rej && rej.ok === false && rej.error === 'boom', 'a rejection resolves { ok:false, error } — never throws');

  console.log('\n== results say what was checked: working / broken / not set up (optional) ==');
  const r = await diag.runSystemCheck(healthyDeps());
  assert(r.ok === true && r.total === r.checks.length && r.total >= 10, 'returns a full list of checks');
  assert(r.checks.every((c) => ['ok', 'failed', 'not-set-up'].includes(c.status)), 'every check carries a status: ok / failed / not-set-up');
  assert(byName(r, /Image/).ok === true && /answering at http:\/\/127\.0\.0\.1:7860/.test(byName(r, /Image/).detail), 'a turned-on service that answers its ping is ✅, and says where it answered');
  assert(/not exercised/.test(byName(r, /Image/).detail), 'and it is honest that the quick check did not exercise it');
  assert(byName(r, /Video/).ok === null && /not set up \(optional\)/.test(byName(r, /Video/).detail), 'a service that is turned off is ⚪ "not set up (optional)", not ❌');
  assert(byName(r, /GPU/).ok === true && /12\.0 GB VRAM/.test(byName(r, /GPU/).detail), 'GPU VRAM is shown in GB (MB from nvidia-smi / 1024)');
  assert(r.okCount + r.failCount + r.notSetUpCount === r.total, 'the counts add up');
  assert(typeof r.elapsedMs === 'number' && typeof r.checkedAt === 'string', 'it reports how long it took and when it ran (no stale results passed off as current)');
  const oi = r.installs.find((i) => i.id === 'open-interpreter');
  assert(oi && oi.installed === false && oi.optional === true, 'a missing add-on is reported as not installed, and flagged optional');
  assert(r.missing.includes('open-interpreter') && !r.missing.includes('stability-matrix') && r.canInstall === true, 'only installable add-ons count as missing');

  console.log('\n== turned on but nothing listening → ❌ with the reason ==');
  const down = healthyDeps();
  down.probe = async (url) => ({ reachable: false, base: new URL(url).origin, reason: 'refused' });
  const rd = await diag.runSystemCheck(down);
  const im = byName(rd, /Image/);
  assert(im.ok === false && /isn't answering/.test(im.detail) && /connection refused/.test(im.detail), 'an enabled service with nothing listening is ❌ and says "connection refused"');
  assert(byName(rd, /Brain/).ok === false && /Ollama/.test(byName(rd, /Brain/).detail), 'an unreachable brain says so and suggests starting the model server');
  const noAddr = healthyDeps();
  noAddr.voiceStatus = () => ({ enabled: true, configured: false, endpoint: '' });
  assert(byName(await diag.runSystemCheck(noAddr), /Voice/).ok === false, 'turned on with no address is ❌ (not a false ✅)');

  console.log('\n== optional things that are simply absent are ⚪, never ❌ ==');
  const bare = healthyDeps();
  bare.managerConfig = () => ({});
  bare.pythonStatus = async () => ({ missing: true, compatible: false, note: 'No Python found.' });
  bare.gpuRead = async () => ({ available: false, reason: 'nvidia-smi not available' });
  bare.enabledSites = () => [];
  const rb = await diag.runSystemCheck(bare);
  assert(byName(rb, /Python/).ok === null && /optional/.test(byName(rb, /Python/).detail), 'no Python → ⚪ not installed (optional), not an error');
  assert(byName(rb, /GPU/).ok === null && /NVIDIA/.test(byName(rb, /GPU/).detail) && /optional/.test(byName(rb, /GPU/).detail), 'no nvidia-smi → ⚪ explains the meter is NVIDIA-only and optional');
  assert(byName(rb, /Brain/).ok === null, 'no brain configured → ⚪');
  assert(byName(rb, /Chat AIs/).ok === null, 'no chat AI enabled → ⚪');
  assert(rb.failCount === 0, 'a fresh install with nothing optional set up shows zero failures');

  console.log('\n== a check that throws is reported, the rest still run ==');
  const boom = healthyDeps();
  boom.dbStatus = () => { throw new Error('db locked'); };
  delete boom.toolList;
  const rx = await diag.runSystemCheck(boom);
  assert(byName(rx, /Memory/).ok === false && /db locked/.test(byName(rx, /Memory/).detail), 'a throwing check becomes ❌ with its error');
  assert(byName(rx, /Tools/).ok === false && /not available/.test(byName(rx, /Tools/).detail), 'a missing dependency is reported, not a crash');
  assert(byName(rx, /Image/).ok === true, 'the other checks are unaffected');

  console.log('\n== speed: checks run at the same time ==');
  // Every slow step (python, gpu, installs, 5 pings) takes 200ms. Serially that
  // was ≥ 8 × 200ms = 1.6s; concurrently it should be ~200ms.
  const D = 200;
  const t0 = Date.now();
  const rs = await diag.runSystemCheck(healthyDeps(D));
  const took = Date.now() - t0;
  const serialEstimate = 8 * D;
  console.log(`     (measured ${took}ms concurrently vs ~${serialEstimate}ms if run one after another)`);
  assert(rs.okCount >= 8 && took < serialEstimate / 2, `slow checks overlap (took ${took}ms, serial would be ≥${serialEstimate}ms)`);

  console.log('\n== speed: a hung tool or port can\'t stall the whole check ==');
  const hung = healthyDeps();
  hung.pythonStatus = never;          // a python.exe that never returns
  hung.detectInstalls = never;         // pip show hangs
  hung.probe = (url) => (/7860/.test(url) ? never() : Promise.resolve({ reachable: true, base: new URL(url).origin }));
  const th = Date.now();
  const rh = await diag.runSystemCheck(hung, { timeouts: { probe: 150, python: 250, installs: 300, gpu: 250, check: 250 } });
  const tookH = Date.now() - th;
  assert(tookH < 1200, `the check still finishes promptly with hung steps (took ${tookH}ms)`);
  assert(byName(rh, /Image/).ok === false && /no answer within 0\.15s/.test(byName(rh, /Image/).detail), 'a port that never answers is ❌ "no answer within …"');
  assert(byName(rh, /Python/).ok === false && /didn't finish within/.test(byName(rh, /Python/).detail), 'a hung Python lookup is reported as timed out');
  assert(rh.installs.every((i) => i.installed === null && /couldn't tell/.test(i.detail)) && rh.missing.length === 0, 'a hung install check says "couldn\'t tell" rather than claiming not installed');

  console.log('\n== pingEndpoint with the real endpoint-detect (localhost) ==');
  const probe = (u, ms) => ed.test(u, { timeoutMs: ms });
  const up = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((res) => up.listen(0, '127.0.0.1', res));
  const upPort = up.address().port;
  const pu = await diag.pingEndpoint(probe, `http://127.0.0.1:${upPort}/sdapi/v1/txt2img`, 1000);
  assert(pu.reachable === true && pu.base === `http://127.0.0.1:${upPort}`, 'a listening server (even a 404) counts as answering');
  // A port with nothing on it: grab a free port, then close it.
  const tmp = net.createServer(); await new Promise((res) => tmp.listen(0, '127.0.0.1', res));
  const deadPort = tmp.address().port; await new Promise((res) => tmp.close(res));
  const pd = await diag.pingEndpoint(probe, `http://127.0.0.1:${deadPort}/`, 1000);
  assert(pd.reachable === false && /refused/.test(pd.why), 'a closed port → not reachable, "connection refused"');
  // A server that accepts the connection and never replies (the Windows "hang").
  const sink = net.createServer(() => {}); await new Promise((res) => sink.listen(0, '127.0.0.1', res));
  const tp = Date.now();
  const ph = await diag.pingEndpoint(probe, `http://127.0.0.1:${sink.address().port}/`, 400);
  const tookP = Date.now() - tp;
  assert(ph.reachable === false && /no answer within 0\.4s/.test(ph.why) && tookP < 1500, `a server that accepts but never answers times out at the limit (${tookP}ms)`);
  up.close(); sink.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
