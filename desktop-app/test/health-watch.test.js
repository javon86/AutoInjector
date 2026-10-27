// test/health-watch.test.js — the 🩺 health watch with fakes: each check, the once-an-hour de-duplication,
// "it got worse" re-tells, the one "fixed" line, quiet flapping, checks that can't tell, and fix().
// Run: node test/health-watch.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const hw = require('../health-watch');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const GB = 1024 * 1024 * 1024, MB = 1024 * 1024;

/** A watch over a mutable fake world. */
function world(over = {}) {
  const w = {
    t: 1_000_000,
    alfred: { enabled: false },
    tags: { ok: true, models: ['qwen2.5:7b'] },
    installed: true,
    disks: { '/stuff': 100 * GB, '/stuff/models': 100 * GB },
    devices: { '/stuff': 1, '/stuff/models': 1 },
    sd: null, sdUp: true, sdCanStart: true,
    akowe: { enabled: true, phase: 'running', restarts: 0 },
    panes: [{ site: 'chatgpt', label: 'ChatGPT', active: true, state: 'ok' }, { site: 'claude', label: 'Claude', active: true, state: 'ok' }],
    logBytes: 10 * MB,
    told: [], fixes: [], logs: [], probed: [], listed: [],
  };
  Object.assign(w, over);
  w.watch = hw.createHealthWatch({
    now: () => w.t,
    noTimers: true,
    alfred: () => w.alfred,
    listModels: async (base) => { w.listed.push(base); return w.tags; },
    ollamaInstalled: async () => w.installed,
    diskPaths: () => [{ id: 'content', label: 'the "stuff and thing" folder', path: '/stuff' }, { id: 'models', label: 'the models folder', path: '/stuff/models' }],
    freeBytes: (p) => (p in w.disks ? w.disks[p] : null),
    deviceOf: (p) => w.devices[p],
    sd: () => w.sd,
    sdCanStart: () => w.sdCanStart,
    probe: async (u) => { w.probed.push(u); return w.sdUp; },
    akowe: () => w.akowe,
    panes: () => w.panes,
    logDirs: () => ['/stuff/logs'],
    dirSize: () => w.logBytes,
    notify: (e) => w.told.push(e),
    runFix: async (fix, p) => { w.fixes.push({ fix, code: p.code }); if (w.onFix) w.onFix(fix); return { ok: true, message: 'done' }; },
    log: (k, d) => w.logs.push({ k, d }),
  });
  return w;
}
const codes = (w) => w.watch.problems().map((p) => p.code).sort();
const toldCodes = (w, type) => w.told.filter((e) => !type || e.type === type).map((e) => e.problem.code);

(async () => {
  console.log('health-watch');

  // ---- all fine ----
  {
    const w = world();
    const st = await w.watch.runOnce();
    assert(st.ok && st.problems.length === 0 && w.told.length === 0, 'a healthy world: no problems, nothing told');
    assert(/Nothing is wrong/.test(st.summary) && st.checkedAt === w.t, 'status says nothing is wrong and when it looked');
    assert(w.listed.length === 0, 'Alfred off → his brain is not checked (no Ollama call)');
  }

  // ---- 🎩 Alfred's brain ----
  {
    const w = world({ alfred: { enabled: true, brain: 'local', endpoint: 'http://127.0.0.1:11435/v1', model: 'qwen2.5:7b' } });
    await w.watch.runOnce({ only: ['brain'] });
    assert(w.listed[0] === 'http://127.0.0.1:11435' && codes(w).length === 0, 'Alfred on + local model installed → asks /api/tags on his own endpoint, no problem');
    w.tags = { ok: false, models: [] };
    await w.watch.runOnce({ only: ['brain'] });
    const p = w.watch.problems()[0];
    assert(p && p.code === 'brain-ollama-down' && p.fix && /Start Ollama/.test(p.fix.label), 'Ollama not answering → brain-ollama-down with "▶ Start Ollama"');
    assert(w.told.length === 1 && w.told[0].type === 'problem' && /isn't answering/.test(w.told[0].text), 'told once, in one plain sentence');
    w.installed = false; w.t += 2 * 3600e3;
    await w.watch.runOnce({ only: ['brain'] });
    assert(/isn't installed/.test(w.watch.problems()[0].text) && /Set up/.test(w.watch.problems()[0].fix.label), 'Ollama not installed → the fix is "⚡ Set up his AI"');
    w.tags = { ok: true, models: ['llama3.1:8b', 'mistral:7b'] };
    await w.watch.runOnce({ only: ['brain'] });
    assert(codes(w).join() === 'brain-model-missing' && /Use llama3\.1:8b/.test(w.watch.problems()[0].fix.label), 'his model not installed → brain-model-missing, fix: use an installed one');
    assert(toldCodes(w, 'fixed').includes('brain-ollama-down'), 'Ollama answering again → told it is fixed');
    w.tags = { ok: true, models: [] };
    w.t += 2 * 3600e3;
    await w.watch.runOnce({ only: ['brain'] });
    assert(/Run setup/.test(w.watch.problems()[0].fix.label), 'no models at all → the fix is "⚡ Run setup"');
    w.tags = { ok: true, models: ['qwen2.5:7b'] };
    await w.watch.runOnce({ only: ['brain'] });
    assert(codes(w).length === 0 && toldCodes(w, 'fixed').includes('brain-model-missing'), 'model installed → fixed line');

    const remote = world({ alfred: { enabled: true, brain: 'local', endpoint: 'http://192.168.1.9:11434/v1', model: 'x' }, tags: { ok: false } });
    await remote.watch.runOnce({ only: ['brain'] });
    assert(remote.listed.length === 0 && codes(remote).length === 0, 'a model on another computer is not checked (localhost only)');
    const api = world({ alfred: { enabled: true, brain: 'auto', endpoint: '', model: 'x', hasApi: true }, tags: { ok: false } });
    await api.watch.runOnce({ only: ['brain'] });
    assert(api.listed.length === 0, 'automatic brain with a connected AI: not a local-model problem');
    const auto = world({ alfred: { enabled: true, brain: 'auto', endpoint: '', model: 'x', hasApi: false }, tags: { ok: false } });
    await auto.watch.runOnce({ only: ['brain'] });
    assert(auto.listed[0] === 'http://127.0.0.1:11434' && codes(auto).join() === 'brain-ollama-down', 'automatic brain without an API relies on Ollama → checked (default address)');
    // Alfred turned off while a problem stands: it goes away quietly (no "fixed")
    auto.alfred = { enabled: false };
    await auto.watch.runOnce({ only: ['brain'] });
    assert(codes(auto).length === 0 && toldCodes(auto, 'fixed').length === 0, 'Alfred turned off → his brain problem is dropped quietly');
  }

  // ---- 💾 disk ----
  {
    const w = world({ disks: { '/stuff': 12 * GB, '/stuff/models': 12 * GB } });
    await w.watch.runOnce({ only: ['disk'] });
    const p = w.watch.problems();
    assert(p.length === 1 && p[0].severity === 'warn' && /12 GB free/.test(p[0].text) && /"stuff and thing" folder and the models folder/.test(p[0].text), 'both folders on one drive under 15 GB → ONE warning naming both');
    assert(p[0].fix && /Open the folder/.test(p[0].fix.label), 'disk warning offers to open the folder');
    w.disks = { '/stuff': 3 * GB, '/stuff/models': 3 * GB }; w.t += 60e3;
    await w.watch.runOnce({ only: ['disk'] });
    assert(w.watch.problems()[0].severity === 'urgent' && w.told.length === 2 && /almost full/.test(w.told[1].text), 'under 5 GB → urgent, told again at once (it got worse) even within the hour');
    w.t += 60e3;
    await w.watch.runOnce({ only: ['disk'] });
    assert(w.told.length === 2, 'same urgent problem a minute later → not told again');
    w.t += 61 * 60e3;
    await w.watch.runOnce({ only: ['disk'] });
    assert(w.told.length === 3, 'still there an hour later → told once more');
    w.disks = { '/stuff': 50 * GB, '/stuff/models': 50 * GB };
    await w.watch.runOnce({ only: ['disk'] });
    assert(codes(w).length === 0 && w.told.length === 4 && w.told[3].type === 'fixed' && /enough free space/.test(w.told[3].text), 'space freed → exactly one "fixed" line');
    await w.watch.runOnce({ only: ['disk'] });
    assert(w.told.length === 4, '…and nothing more after that');

    const two = world({ devices: { '/stuff': 1, '/stuff/models': 2 }, disks: { '/stuff': 100 * GB, '/stuff/models': 4 * GB } });
    await two.watch.runOnce({ only: ['disk'] });
    assert(codes(two).join() === 'disk-low:models' && /models folder/.test(two.watch.problems()[0].text) && !/stuff and thing/.test(two.watch.problems()[0].text), 'models folder on another (full) drive → its own warning');
    const unknown = world({ disks: {} });
    await unknown.watch.runOnce({ only: ['disk'] });
    assert(codes(unknown).length === 0, 'free space unknown (old Node / no statfs) → no warning, no crash');
  }

  // ---- 🎨 Stable Diffusion ----
  {
    const w = world({ sd: { enabled: true, configured: true, base: 'http://127.0.0.1:7860', runnerPhase: 'idle' }, sdUp: false });
    await w.watch.runOnce({ only: ['sd'] });
    assert(codes(w).join() === 'sd-down' && w.probed[0] === 'http://127.0.0.1:7860' && /Start Stable Diffusion/.test(w.watch.problems()[0].fix.label), 'connected before but not answering → sd-down with "▶ Start"');
    w.sdUp = true;
    await w.watch.runOnce({ only: ['sd'] });
    assert(codes(w).length === 0 && toldCodes(w, 'fixed').join() === 'sd-down', 'answering again → fixed');
    // flapping: down again within the hour → kept quietly, not told twice
    w.sdUp = false; w.t += 5 * 60e3;
    await w.watch.runOnce({ only: ['sd'] });
    assert(codes(w).join() === 'sd-down' && toldCodes(w, 'problem').length === 1, 'down again within the hour → listed, but not told again (no flapping lines)');
    w.sdUp = true;
    await w.watch.runOnce({ only: ['sd'] });
    assert(toldCodes(w, 'fixed').length === 1, '…and its quiet recovery is not told either');
    const starting = world({ sd: { enabled: true, configured: true, base: 'http://127.0.0.1:7860', runnerPhase: 'starting' }, sdUp: false });
    await starting.watch.runOnce({ only: ['sd'] });
    assert(codes(starting).length === 0 && starting.probed.length === 0, 'Stable Diffusion still starting → not checked');
    const never = world({ sd: { enabled: false, configured: false, base: '' } });
    await never.watch.runOnce({ only: ['sd'] });
    assert(codes(never).length === 0 && never.probed.length === 0, 'never connected → not checked');
    const remote = world({ sd: { enabled: true, configured: true, base: 'http://10.0.0.5:7860' }, sdUp: false });
    await remote.watch.runOnce({ only: ['sd'] });
    assert(remote.probed.length === 0, 'a Stable Diffusion on another computer is not probed (localhost only)');
    const noStart = world({ sd: { enabled: true, configured: true, base: 'http://localhost:8188' }, sdUp: false, sdCanStart: false });
    await noStart.watch.runOnce({ only: ['sd'] });
    assert(noStart.watch.problems()[0].fix === null, 'nothing AutoInjector can start → no fix button');
  }

  // ---- 📖 Akọwe ----
  {
    const w = world({ akowe: { enabled: true, phase: 'restarting', restarts: 1 } });
    await w.watch.runOnce({ only: ['akowe'] });
    assert(codes(w).length === 0, 'one restart → quiet');
    w.akowe = { enabled: true, phase: 'restarting', restarts: 3 };
    await w.watch.runOnce({ only: ['akowe'] });
    assert(codes(w).join() === 'akowe-restarting' && /3 times/.test(w.watch.problems()[0].text), 'restarting again and again → akowe-restarting');
    w.akowe = { enabled: true, phase: 'failed', error: 'CRASHED', restarts: 5 };
    await w.watch.runOnce({ only: ['akowe'] });
    const p = w.watch.problems();
    assert(p.length === 1 && p[0].code === 'akowe-down' && p[0].severity === 'urgent' && /Try again/.test(p[0].fix.label), 'gave up → akowe-down (urgent) with "↻ Try again"; the restarting line is replaced');
    w.akowe = { enabled: true, phase: 'running', restarts: 0 };
    await w.watch.runOnce({ only: ['akowe'] });
    assert(codes(w).length === 0 && toldCodes(w, 'fixed').includes('akowe-down'), 'running again → fixed');
    const noApp = world({ akowe: { enabled: true, phase: 'failed', error: 'NO_APP' } });
    await noApp.watch.runOnce({ only: ['akowe'] });
    assert(codes(noApp).length === 0, 'Akọwe not installed at all → not a health problem');
    const off = world({ akowe: { enabled: false, phase: 'failed', error: 'CRASHED' } });
    await off.watch.runOnce({ only: ['akowe'] });
    assert(codes(off).length === 0, 'Akọwe server turned off by the user → quiet');
  }

  // ---- 💬 AI panes: only when self-repair gave up ----
  {
    const w = world();
    w.panes[1] = { site: 'claude', label: 'Claude', active: true, state: 'repairing' };
    await w.watch.runOnce({ only: ['panes'] });
    assert(codes(w).length === 0, 'self-repair still working → quiet');
    w.panes[1] = { site: 'claude', label: 'Claude', active: true, state: 'broken', problem: 'NO_INPUT' };
    w.panes[0] = { site: 'chatgpt', label: 'ChatGPT', active: false, state: 'broken' };
    await w.watch.runOnce({ only: ['panes'] });
    const p = w.watch.problems();
    assert(p.length === 1 && p[0].code === 'pane-broken:claude' && p[0].alfred === false, 'gave up on an active pane → pane-broken (not re-announced by Alfred, he already does); inactive panes ignored');
  }

  // ---- 🧾 logs folder ----
  {
    const w = world({ logBytes: 700 * MB });
    await w.watch.runOnce({ only: ['logs'] });
    assert(codes(w).join() === 'logs-big' && /700 MB/.test(w.watch.problems()[0].text) && /Open the logs folder/.test(w.watch.problems()[0].fix.label), 'logs folder over 500 MB → suggest cleanup');
  }

  // ---- checks that can't tell keep what they had; a check that throws is skipped ----
  {
    const w = world({ sd: { enabled: true, configured: true, base: 'http://127.0.0.1:7860' }, sdUp: false });
    await w.watch.runOnce({ only: ['sd'] });
    w.sd = null; // can't tell this time
    await w.watch.runOnce({ only: ['sd'] });
    assert(codes(w).join() === 'sd-down' && toldCodes(w, 'fixed').length === 0, 'a check that can\'t tell keeps the problem (no false "fixed")');
    const thrower = hw.createHealthWatch({ noTimers: true, sd: () => ({ enabled: true, configured: true, base: 'http://127.0.0.1:1' }), probe: () => { throw new Error('x'); }, notify: () => {} });
    const st = await thrower.runOnce();
    assert(st.ok && st.problems.length === 0, 'a check that throws is skipped (no crash, no false alarm)');
  }

  // ---- fix(code) ----
  {
    const w = world({ alfred: { enabled: true, brain: 'local', endpoint: 'http://127.0.0.1:11435/v1', model: 'qwen2.5:7b' }, tags: { ok: false, models: [] } });
    await w.watch.runOnce();
    w.onFix = (fix) => { if (fix.channel === 'llm:fix') w.tags = { ok: true, models: ['qwen2.5:7b'] }; };
    const r = await w.watch.fix('brain-ollama-down');
    assert(r.ok && r.fixed && w.fixes[0].fix.channel === 'llm:fix' && w.fixes[0].fix.args[0].action === 'start', 'fix(code) runs the fix (llm:fix start), looks again, reports fixed');
    assert(toldCodes(w, 'fixed').includes('brain-ollama-down'), '…and the fixed line is told');
    const none = await w.watch.fix('brain-ollama-down');
    assert(!none.ok && none.error === 'NO_SUCH_PROBLEM', 'fixing a problem that is gone → NO_SUCH_PROBLEM');
  }

  // ---- notify payload + log ----
  {
    const w = world({ logBytes: 3 * GB });
    await w.watch.runOnce();
    const e = w.told[0];
    assert(e && e.problem.code === 'logs-big' && e.problem.fix && e.problem.fix.label && !('open' in e.problem.fix) && e.problem.severity === 'urgent', 'notify gets the public problem (code, severity, fix label — not the folder path)');
    const l = w.logs.find((x) => x.k === 'health');
    assert(l && l.d.code === 'logs-big' && l.d.state === 'problem' && l.d.severity === 'error' && /logs folder/.test(l.d.summary), 'logged as kind "health" with a summary and an activity-log level');
    const st = w.watch.status();
    assert(/1 thing needs attention/.test(st.summary), 'status summary counts the problems');
  }

  // ---- the real helpers ----
  {
    assert(hw.isLocalUrl('http://127.0.0.1:7860') && hw.isLocalUrl('http://localhost:1') && hw.isLocalUrl('http://[::1]:3') && !hw.isLocalUrl('http://10.0.0.2:1') && !hw.isLocalUrl('nonsense'), 'isLocalUrl');
    assert(hw.ollamaBase('http://127.0.0.1:11434/v1/chat/completions') === 'http://127.0.0.1:11434' && hw.ollamaBase('http://127.0.0.1:11435/v1/') === 'http://127.0.0.1:11435', 'ollamaBase');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'x.log'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'y.log'), Buffer.alloc(500));
    assert(await hw.defaultDirSize(tmp) === 1500, 'defaultDirSize adds up files in sub-folders');
    assert(await hw.defaultDirSize(path.join(tmp, 'missing')) === null, 'defaultDirSize of a missing folder → null');
    const free = await hw.defaultFreeBytes(path.join(tmp, 'not', 'yet'));
    assert(free === null || (Number.isFinite(free) && free > 0), 'defaultFreeBytes works on a folder that does not exist yet (nearest parent)');
    fs.rmSync(tmp, { recursive: true, force: true });
    // timers: start/stop with a tiny delay
    let runs = 0;
    const t = hw.createHealthWatch({ firstDelayMs: 10, intervalMs: 20, panes: () => { runs++; return []; } });
    t.start();
    await new Promise((r) => setTimeout(r, 70));
    t.stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    assert(after >= 2 && runs === after, 'start() looks after the first delay and then on the interval; stop() stops it');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
