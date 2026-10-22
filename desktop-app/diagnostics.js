'use strict';
/*
 * diagnostics.js — the quick System Check (🩺), plus the small helpers the deep
 * Capability Test (🧪) shares with it.
 *
 * What it fixes (OP-14, "diagnostics are slow and their results are misleading"):
 *   - SLOW: every check used to run one after another, and the slow ones (finding
 *     a Python, `pip show` per package, nvidia-smi, `ollama --version`) stacked up.
 *     Now every check runs at the same time, and each has its own time limit, so
 *     the whole check takes about as long as its slowest single step — and a
 *     hung tool or a port that never answers becomes a clear "didn't answer
 *     within Ns" instead of a stall.
 *   - MISLEADING: a capability used to show ✅ just because it was switched on,
 *     even if nothing was listening at its address. Now a switched-on service is
 *     actually pinged, and the result says what was checked. Optional things that
 *     simply aren't installed are reported as "not set up (optional)" (⚪), never
 *     as an error (❌).
 *
 * Every result is { name, ok, status, detail }:
 *   ok === true   status "ok"          — checked and working
 *   ok === null   status "not-set-up"  — optional / not turned on / can't tell
 *   ok === false  status "failed"      — turned on but not working (detail says why)
 *
 * Electron-free: everything it looks at is passed in, so it is unit-testable.
 */

const DEFAULT_TIMEOUTS = {
  probe: 2500,     // one HTTP "is anything listening?" ping to a configured endpoint
  python: 12000,   // finding a usable Python (probes run in parallel, 6s each max)
  gpu: 6000,       // nvidia-smi (has its own 4s limit inside gpu-monitor)
  installs: 20000, // add-on install detection (pip show ×N in parallel + Ollama)
  check: 5000,     // anything else
};

const STATUS_OF = (ok) => (ok === true ? 'ok' : ok === false ? 'failed' : 'not-set-up');

function result(name, ok, detail) {
  return { name, ok, status: STATUS_OF(ok), detail: detail || '' };
}

function secs(ms) {
  return `${Math.round(ms / 10) / 100}s`; // 2500 → "2.5s", 150 → "0.15s"
}

/**
 * Resolve `promise`, or `onTimeout()` (default { ok:false, error:'TIMEOUT' }) if
 * it takes longer than `ms`. A rejection resolves { ok:false, error } — never
 * throws, so one broken step can't take down a whole sweep.
 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(typeof onTimeout === 'function' ? onTimeout() : { ok: false, error: 'TIMEOUT' });
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, error: String((e && e.message) || e) }); } }
    );
  });
}

/**
 * Ping a configured endpoint's host. `probe(url, timeoutMs)` must resolve
 * { reachable, base?, reason? } (endpoint-detect's test()). Never throws.
 * Resolves { reachable, base, why } where `why` is a plain-language reason on failure.
 */
async function pingEndpoint(probe, url, timeoutMs) {
  const ms = timeoutMs || DEFAULT_TIMEOUTS.probe;
  let base = url;
  try { const u = new URL(url); base = `${u.protocol}//${u.host}`; } catch (_) { /* keep as typed */ }
  if (typeof probe !== 'function') return { reachable: null, base, why: 'no way to ping it here' };
  // Give the probe its own limit plus a small margin, in case it ignores it.
  const r = await withTimeout(probe(url, ms), ms + 500, () => ({ reachable: false, reason: 'timeout' }));
  if (r && r.reachable) return { reachable: true, base: r.base || base, why: '' };
  const reason = (r && (r.reason || r.error)) || '';
  let why;
  if (reason === 'timeout' || reason === 'TIMEOUT') why = `no answer within ${secs(ms)}`;
  else if (reason === 'refused' || /ECONNREFUSED/i.test(reason)) why = 'connection refused (nothing is running there)';
  else if (reason === 'NO_URL') why = 'no address set';
  else if (reason) why = String(reason);
  else why = 'no answer';
  return { reachable: false, base: (r && r.base) || base, why };
}

// One "turned-on service with an address" check, shared by Run code / Voice /
// Image / Video: off → not set up; on with no address → failed; on → ping it.
async function serviceCheck(name, status, offDetail, probe, probeMs) {
  const s = status || {};
  if (!s.enabled) {
    return result(name, null, s.configured ? 'not set up (optional) — an address is saved but it is turned off' : `not set up (optional) — ${offDetail}`);
  }
  if (!s.endpoint) return result(name, false, 'turned on, but no address (endpoint) is set');
  const p = await pingEndpoint(probe, s.endpoint, probeMs);
  if (p.reachable === true) return result(name, true, `turned on · server answering at ${p.base} (not exercised — the Capability Test does that)`);
  if (p.reachable === null) return result(name, null, `turned on (${s.endpoint}) — couldn't check it: ${p.why}`);
  return result(name, false, `turned on, but ${p.base} isn't answering: ${p.why}. Is that server running?`);
}

/**
 * The quick System Check. All checks run at once, each with its own time limit.
 *
 * deps (all optional; a missing one is reported as "can't check" rather than crashing):
 *   managerConfig()    -> { endpoint, model }          the butler's brain
 *   interpreterStatus()-> { enabled, configured, endpoint }
 *   voiceStatus(), imageStatus(), videoStatus() — same shape
 *   pythonStatus()     -> Promise<{ missing, compatible, version, note }>
 *   toolList()         -> [{ name }]
 *   dbStatus()         -> { available, count, reason }
 *   modelsRoot()       -> string
 *   gpuRead()          -> Promise<{ available, gpus:[{ name, memTotal(MB) }], reason }>
 *   enabledSites()     -> ['chatgpt', ...]
 *   probe(url, ms)     -> Promise<{ reachable, base, reason }>
 *   installTargets()   -> [{ id, label, kind }]
 *   detectInstalls()   -> Promise<{ [id]: { installed, reason } }>
 *   onError(kind, err) -> void   (logging hook)
 *   now()              -> ms      (clock, for tests)
 * opts.timeouts overrides DEFAULT_TIMEOUTS per key.
 */
async function runSystemCheck(deps = {}, opts = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const T = Object.assign({}, DEFAULT_TIMEOUTS, opts.timeouts || {});
  const started = now();
  const probe = deps.probe;
  const call = (fn, ...args) => {
    if (typeof fn !== 'function') throw new Error('not available in this build');
    return fn(...args);
  };

  // Each entry: [name, timeoutMs, async () => result]. They all start together.
  const plan = [
    ['Brain (local model)', T.probe + 1000, async () => {
      const mc = call(deps.managerConfig) || {};
      if (!(mc.endpoint && mc.model)) return result('Brain (local model)', null, 'not set up (optional) — no model/endpoint saved yet; set one in the Butler settings');
      const p = await pingEndpoint(probe, mc.endpoint, T.probe);
      if (p.reachable === true) return result('Brain (local model)', true, `${mc.model} · server answering at ${p.base} (the model itself isn't exercised — the Capability Test does that)`);
      if (p.reachable === null) return result('Brain (local model)', null, `${mc.model} @ ${mc.endpoint} — couldn't check it: ${p.why}`);
      return result('Brain (local model)', false, `${mc.model} @ ${mc.endpoint} — ${p.base} isn't answering: ${p.why}. Is the model server (e.g. Ollama) running?`);
    }],
    ['Run code (Open Interpreter)', T.probe + 1000, async () =>
      serviceCheck('Run code (Open Interpreter)', call(deps.interpreterStatus), 'install it via Setup Wizard → Auto-setup', probe, T.probe)],
    ['Install toolchain (Python)', T.python, async () => {
      const py = (await call(deps.pythonStatus)) || {};
      if (py.missing) return result('Install toolchain (Python)', null, 'not installed (optional — only needed to auto-install Open Interpreter and the voice engine). Install Python 3.12 from python.org to use those.');
      if (!py.compatible) return result('Install toolchain (Python)', null, py.note || `Python ${py.version || '?'} found, but it is outside the supported 3.8–3.12 range`);
      return result('Install toolchain (Python)', true, py.note || `Using Python ${py.version}.`);
    }],
    ['Tools (USE_TOOL)', T.check, async () => {
      const t = call(deps.toolList) || [];
      return t.length
        ? result('Tools (USE_TOOL)', true, `${t.length} registered: ${t.map((x) => x.name).join(', ')}`)
        : result('Tools (USE_TOOL)', false, 'no tools are registered (the built-in ones should always be there)');
    }],
    ['Memory (remember/recall)', T.check, async () => {
      const d = call(deps.dbStatus) || {};
      return d.available
        ? result('Memory (remember/recall)', true, `database open (${d.count || 0} messages stored)`)
        : result('Memory (remember/recall)', false, `database not available: ${d.reason || 'unknown reason'}`);
    }],
    // Budget for the ping AND the voice service's own check after it (OP-12).
    ['Voice (speak & listen)', T.probe * 2 + 1500, async () => {
      const r = await serviceCheck('Voice (speak & listen)', call(deps.voiceStatus), 'install the voice engine via Setup Wizard → Auto-setup, then turn Voice on', probe, T.probe);
      // OP-12: when the voice service isn't answering, use its own plain
      // "not running — here's how to start it" message if it offers one.
      if (r.ok === false && typeof deps.voiceCheck === 'function') {
        try { const c = await deps.voiceCheck(T.probe); if (c && !c.ok && c.message) return result('Voice (speak & listen)', false, c.message); } catch (_) { /* keep the generic reason */ }
      }
      return r;
    }],
    ['Image generation', T.probe + 1000, async () =>
      serviceCheck('Image generation', call(deps.imageStatus), 'no Stable Diffusion address set (the Image panel’s Auto-detect can find one)', probe, T.probe)],
    ['Video generation', T.probe + 1000, async () =>
      serviceCheck('Video generation', call(deps.videoStatus), 'no text-to-video address set', probe, T.probe)],
    ['Models & content folder', T.check, async () => {
      const root = call(deps.modelsRoot);
      return root ? result('Models & content folder', true, root) : result('Models & content folder', false, 'the content folder could not be created or found');
    }],
    ['GPU monitor', T.gpu, async () => {
      const g = (await call(deps.gpuRead)) || {};
      if (!g.available) {
        return result('GPU monitor', null, `not available (optional) — the GPU usage meter needs an NVIDIA card with nvidia-smi${g.reason ? ` (${g.reason})` : ''}. This does not affect anything else.`);
      }
      const names = (g.gpus || []).map((x) => (x.memTotal ? `${x.name} (${(x.memTotal / 1024).toFixed(1)} GB VRAM)` : x.name));
      return result('GPU monitor', true, names.join(', ') || 'GPU found');
    }],
    ['Chat AIs (ChatGPT/Claude/Gemini)', T.check, async () => {
      const en = call(deps.enabledSites) || [];
      return en.length
        ? result('Chat AIs (ChatGPT/Claude/Gemini)', true, `enabled: ${en.join(', ')} (not pinged — the Capability Test does that)`)
        : result('Chat AIs (ChatGPT/Claude/Gemini)', null, 'none enabled — turn on at least one AI up top');
    }],
  ];

  const runOne = ([name, ms, fn]) => withTimeout(
    Promise.resolve().then(fn),
    ms,
    () => result(name, false, `this check didn't finish within ${secs(ms)}`)
  ).then((r) => {
    // A thrown error arrives as { ok:false, error } from withTimeout.
    if (r && typeof r.name === 'string' && 'status' in r) return r;
    const err = (r && r.error) || 'unknown error';
    if (typeof deps.onError === 'function') { try { deps.onError(`selfcheck-${name}`, err); } catch (_) {} }
    return result(name, false, `the check itself failed: ${err}`);
  });

  // Optional add-ons: what's installed vs not (all optional by definition).
  const installsP = (async () => {
    let targets = [];
    try { targets = call(deps.installTargets) || []; } catch (e) { return { installs: [], error: String((e && e.message) || e) }; }
    const all = await withTimeout(Promise.resolve().then(() => call(deps.detectInstalls)), T.installs, () => ({ __timeout: true }));
    const timedOut = !!(all && all.__timeout);
    const failedErr = (!timedOut && all && all.ok === false && all.error) ? all.error : null;
    if ((timedOut || failedErr) && typeof deps.onError === 'function') {
      try { deps.onError('selfcheck-installs-error', timedOut ? 'TIMEOUT' : failedErr); } catch (_) {}
    }
    const installs = targets.map((t) => {
      const d = (!timedOut && !failedErr && all && all[t.id]) || {};
      let detail = d.reason || '';
      if (timedOut) detail = `couldn't tell — the install check didn't finish within ${secs(T.installs)}`;
      else if (failedErr) detail = `couldn't tell — ${failedErr}`;
      return {
        id: t.id, label: t.label, kind: t.kind, optional: true,
        installed: (timedOut || failedErr) ? null : (d.installed === true ? true : d.installed === false ? false : null),
        installable: t.kind !== 'handoff',
        detail,
      };
    });
    return { installs };
  })();

  const [checks, inst] = await Promise.all([Promise.all(plan.map(runOne)), installsP]);
  const installs = inst.installs || [];
  const missing = installs.filter((i) => i.installed === false && i.installable).map((i) => i.id);
  // Add-ons whose install state couldn't be told (check timed out / server down):
  // never reported as "everything is installed".
  const unknown = installs.filter((i) => i.installed !== true && i.installed !== false && i.installable).map((i) => i.id);
  const okCount = checks.filter((c) => c.ok === true).length;
  const failCount = checks.filter((c) => c.ok === false).length;
  return {
    ok: true,
    checks,
    okCount,
    failCount,
    notSetUpCount: checks.length - okCount - failCount,
    total: checks.length,
    installs,
    missing,
    unknown,
    canInstall: missing.length > 0,
    elapsedMs: Math.max(0, now() - started),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { DEFAULT_TIMEOUTS, withTimeout, pingEndpoint, serviceCheck, runSystemCheck, result };
