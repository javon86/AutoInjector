'use strict';
/*
 * voice-python.js — which Python runs the voice engine (integrations/voice/voice_shim.py).
 *
 * A voice set-up that already works must keep working. So the choice is:
 *   1. the Python used before (remembered in the voice settings) — if it still runs and has the voice packages;
 *   2. otherwise the first candidate that already has them (faster-whisper or piper): plain `python` / `python3`
 *      (what older versions started the engine with), then the installer's pick (e.g. `py -3.12`);
 *   3. nothing has them yet: the installer's pick (that is where the Setup Wizard installs them);
 *   4. else the first Python that runs (or the remembered one / plain python if none could be checked).
 * AUTOINJECTOR_VOICE_SPAWN overrides all of this (main.js). The probe is quick (`-c` with importlib find_spec, no
 * heavy import) and cached per candidate. Kokoro is installed into the chosen one.
 *
 * chooseVoicePython({ remembered, plain, installerPick, probe }) -> Promise<{ cmd, pre, why } | null>
 *   probe({ cmd, pre }) -> Promise<{ runs: bool, has: bool }>
 * Tested in test/voice-python.test.js.
 */
const childProcess = require('child_process');

const PROBE_CODE = 'import importlib.util as u;print("HAS" if (u.find_spec("faster_whisper") or u.find_spec("piper")) else "NONE")';

function norm(c) {
  if (!c || typeof c.cmd !== 'string' || !c.cmd.trim() || c.cmd.length > 500) return null;
  const pre = Array.isArray(c.pre) ? c.pre.filter((x) => typeof x === 'string' && x.length < 40).slice(0, 4) : [];
  return { cmd: c.cmd.trim(), pre };
}
const keyOf = (c) => `${c.cmd} ${c.pre.join(' ')}`.trim();

/** A real probe: run the candidate briefly. execFile is injectable for tests. */
function makeProbe(execFile = childProcess.execFile, timeoutMs = 6000) {
  const cache = new Map();
  const probe = (cand) => {
    const c = norm(cand);
    if (!c) return Promise.resolve({ runs: false, has: false });
    const k = keyOf(c);
    if (cache.has(k)) return cache.get(k);
    const p = new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const child = execFile(c.cmd, [...c.pre, '-c', PROBE_CODE], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
          if (err) return fin({ runs: false, has: false });
          const out = String(stdout || '');
          fin({ runs: /HAS|NONE/.test(out), has: /HAS/.test(out) });
        });
        if (child && child.on) child.on('error', () => fin({ runs: false, has: false }));
      } catch (_) { fin({ runs: false, has: false }); }
    });
    cache.set(k, p);
    return p;
  };
  probe.clear = () => cache.clear();
  return probe;
}

async function chooseVoicePython(opts = {}) {
  const probe = typeof opts.probe === 'function' ? opts.probe : makeProbe();
  const remembered = norm(opts.remembered);
  const pick = norm(opts.installerPick);
  const plain = (Array.isArray(opts.plain) ? opts.plain : []).map(norm).filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const c of [remembered, ...plain, pick]) { if (c && !seen.has(keyOf(c))) { seen.add(keyOf(c)); list.push(c); } }
  if (!list.length) return null;
  const results = await Promise.all(list.map((c) => Promise.resolve(probe(c)).catch(() => ({ runs: false, has: false }))));
  const at = (c) => results[list.findIndex((x) => keyOf(x) === keyOf(c))] || { runs: false, has: false };
  if (remembered && at(remembered).runs && at(remembered).has) return { ...remembered, why: 'remembered' };
  const withPkgs = list.find((c) => at(c).runs && at(c).has);
  if (withPkgs) return { ...withPkgs, why: 'has-voice-packages' };
  if (pick && at(pick).runs) return { ...pick, why: 'installer-pick' };
  if (remembered && at(remembered).runs) return { ...remembered, why: 'remembered' };
  const runs = list.find((c) => at(c).runs);
  if (runs) return { ...runs, why: 'runs' };
  return { ...(remembered || pick || list[0]), why: 'unchecked' };
}

module.exports = { chooseVoicePython, makeProbe, PROBE_CODE };
