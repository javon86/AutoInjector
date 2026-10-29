'use strict';
/*
 * health-watch.js — warn the user BEFORE something breaks, instead of them finding out mid-task.
 *
 * A few CHEAP checks (no AI calls, no network beyond 127.0.0.1 / localhost), run a minute after the app
 * starts and then every ~10 minutes; main.js can also "poke" one check when an app event says something
 * changed (Akọwe's server restarting, an AI pane that self-repair gave up on).
 *
 *   brain   Alfred's brain — when he is on with a local model: is Ollama answering? is his model installed?
 *   disk    free space on the drive(s) holding the "stuff and thing" folder and the models folder
 *           (warn < 15 GB, urgent < 5 GB — one model is 5–20 GB)
 *   sd      Stable Diffusion was connected (Images module enabled with a local address) but isn't answering —
 *           or answers with NO picture model loaded (empty Checkpoint list)
 *   akowe   Akọwe's server gave up (failed) or keeps restarting
 *   panes   an AI pane self-repair gave up on (state "broken"); while it is still repairing we stay quiet
 *   logs    the logs folder grew huge (> 500 MB)
 *
 * Each problem: { code, check, severity: 'warn'|'urgent', text (one plain-English sentence), fix?: { label,
 * channel, args } | { label, open }, okText, alfred (false = Alfred already announces it himself) }.
 * De-duplicated: the same problem is told at most once per hour (sooner only when it gets worse), and once
 * more when it is fixed. Electron-free; everything outside is injected:
 *
 *   createHealthWatch({
 *     alfred()        -> { enabled, brain, endpoint, model, hasApi } | null
 *     listModels(base)-> { ok, models: [names] }            (GET <base>/api/tags, localhost only)
 *     ollamaInstalled()-> bool | null
 *     diskPaths()     -> [{ id, label, path }]
 *     freeBytes(path) -> number | null   (default: fs.statfs; null when unknown)
 *     deviceOf(path)  -> id | null       (default: fs.stat().dev — two folders on one drive = one warning)
 *     sd()            -> { enabled, configured, base, runnerPhase } | null;  sdCanStart() -> bool (only asked when down)
 *     sdModels()      -> { noModels, label, fix, canRestart } | null   (only asked when it answers)
 *     probe(url)      -> bool            (any HTTP answer = up)
 *     akowe()         -> { enabled, phase, error, message, restarts } | null
 *     panes()         -> [{ site, label, active, state, problem }]
 *     logDirs()       -> [path]
 *     dirSize(path)   -> bytes | null    (default: a capped walk)
 *     notify({ type: 'problem'|'fixed', problem, text })
 *     runFix(fix, problem) -> result
 *     log(kind, detail), now(), intervalMs, firstDelayMs, repeatMs, noTimers
 *   }) -> { start, stop, runOnce({ only }), poke(check), status(), problems(), fix(code) }
 */
const fs = require('fs');
const path = require('path');

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DISK_WARN = 15 * GB;
const DISK_URGENT = 5 * GB;
const LOGS_BIG = 500 * MB;
const REPEAT_MS = 60 * 60 * 1000;      // the same problem at most once per hour
const INTERVAL_MS = 10 * 60 * 1000;    // every ~10 minutes
const FIRST_DELAY_MS = 60 * 1000;      // a minute after start (Ollama / Akọwe / SD get time to come up)
const CHECKS = ['brain', 'disk', 'sd', 'akowe', 'panes', 'logs', 'content'];
const SEVERITY_RANK = { warn: 1, urgent: 2 };

function gbText(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '?';
  const g = bytes / GB;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}
function isLocalUrl(u) {
  try { const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return h === '127.0.0.1' || h === 'localhost' || h === '::1'; } catch (_) { return false; }
}
/** "http://127.0.0.1:11434/v1/chat/completions" → "http://127.0.0.1:11434" */
function ollamaBase(endpoint) {
  return String(endpoint || '').replace(/\/chat\/completions.*$/, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}
const modelKey = (m) => { const t = String(m || '').trim().toLowerCase(); return t && !t.includes(':') ? `${t}:latest` : t; };
const sameModel = (a, b) => !!a && !!b && modelKey(a) === modelKey(b);

/** Free bytes on the drive holding p (the nearest existing parent). null when this Node can't tell. */
async function defaultFreeBytes(p) {
  let dir = p;
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) break; dir = up; }
  try {
    if (fs.promises && typeof fs.promises.statfs === 'function') { const st = await fs.promises.statfs(dir); return Number(st.bavail) * Number(st.bsize); }
    if (typeof fs.statfsSync === 'function') { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); }
  } catch (_) { /* unknown */ }
  return null;
}
function defaultDeviceOf(p) {
  let dir = p;
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) break; dir = up; }
  try { return fs.statSync(dir).dev; } catch (_) { return null; }
}
/** Total size of a folder (files only), a capped walk: stops counting after maxFiles / maxDepth. */
async function defaultDirSize(dir, { maxFiles = 20000, maxDepth = 4 } = {}) {
  let total = 0, files = 0;
  async function walk(d, depth) {
    if (files >= maxFiles || depth > maxDepth) return;
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (files >= maxFiles) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) { files++; try { total += (await fs.promises.stat(p)).size; } catch (_) {} }
    }
  }
  if (!dir || !fs.existsSync(dir)) return null;
  await walk(dir, 0);
  return total;
}

function createHealthWatch(deps = {}) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const log = (k, d) => { try { if (deps.log) deps.log(k, d || {}); } catch (_) {} };
  const call = async (name, ...a) => { if (typeof deps[name] !== 'function') return undefined; try { return await deps[name](...a); } catch (_) { return undefined; } };
  const freeBytes = (p) => (typeof deps.freeBytes === 'function' ? Promise.resolve().then(() => deps.freeBytes(p)).catch(() => null) : defaultFreeBytes(p));
  const deviceOf = (p) => { try { return typeof deps.deviceOf === 'function' ? deps.deviceOf(p) : defaultDeviceOf(p); } catch (_) { return null; } };
  const dirSize = (p) => (typeof deps.dirSize === 'function' ? Promise.resolve().then(() => deps.dirSize(p)).catch(() => null) : defaultDirSize(p));
  const repeatMs = deps.repeatMs || REPEAT_MS;
  const OFF = { off: true }; // a check that doesn't apply now: its problems go away quietly (no "fixed" line)

  const active = new Map(); // code -> { problem, since, toldAt, toldSeverity, quiet }
  const lastTold = new Map(); // code -> { at, severity } of the last time it was told (survives a fix: no flapping lines)
  let lastRun = null;
  let chain = Promise.resolve();
  let timer = null, firstTimer = null;
  const pokeTimers = new Map();

  // ---------------------------------------------------------------------------------------- the checks
  const checks = {
    async brain() {
      const a = await call('alfred');
      if (!a) return null; // couldn't tell
      if (!a.enabled) return OFF;
      const local = a.brain === 'local' || (a.brain === 'auto' && !a.hasApi);
      if (!local) return OFF;
      const base = ollamaBase(a.endpoint || 'http://127.0.0.1:11434/v1');
      if (!isLocalUrl(base)) return OFF; // a model on another computer: not ours to check
      const model = String(a.model || '').trim();
      const l = await call('listModels', base);
      if (!l) return null; // couldn't tell
      if (!l.ok) {
        const installed = await call('ollamaInstalled');
        return [{
          code: 'brain-ollama-down', check: 'brain', severity: 'warn',
          text: installed === false
            ? '🎩 Alfred\'s brain isn\'t set up: Ollama (the program that runs his local model) isn\'t installed, so he can\'t answer.'
            : '🎩 Alfred\'s brain (Ollama) isn\'t answering, so he can\'t think until it\'s running again.',
          fix: installed === false ? { label: '⚡ Set up his AI', channel: 'llm:fix', args: [{ action: 'setup' }] } : { label: '▶ Start Ollama', channel: 'llm:fix', args: [{ action: 'start' }] },
          okText: '✔ Alfred\'s brain (Ollama) is answering again.',
        }];
      }
      const models = Array.isArray(l.models) ? l.models.map(String) : [];
      if (model && !models.some((m) => sameModel(m, model))) {
        const other = models[0];
        return [{
          code: 'brain-model-missing', check: 'brain', severity: 'warn',
          text: other
            ? `🎩 Alfred is set to the model "${model}", which isn't downloaded — his questions would fail. ${models.length === 1 ? `"${other}" is installed.` : `${models.length} other models are installed.`}`
            : `🎩 Alfred is set to the model "${model}", but Ollama has no models downloaded yet — his questions would fail.`,
          fix: other ? { label: `Use ${other}`, channel: 'llm:fix', args: [{ action: 'use', model: other }] } : { label: '⚡ Run setup', channel: 'llm:fix', args: [{ action: 'setup' }] },
          okText: `✔ Alfred's model is installed now.`,
        }];
      }
      return [];
    },

    async disk() {
      const list = (await call('diskPaths')) || [];
      const groups = new Map(); // one warning per drive
      for (const d of list) {
        if (!d || !d.path) continue;
        const dev = deviceOf(d.path);
        const key = dev != null ? `dev:${dev}` : `path:${d.path}`;
        if (!groups.has(key)) groups.set(key, { items: [], path: d.path });
        groups.get(key).items.push(d);
      }
      const out = [];
      let known = false;
      for (const g of groups.values()) {
        const free = await freeBytes(g.path);
        if (free == null || !Number.isFinite(free)) continue;
        known = true;
        if (free >= DISK_WARN) continue;
        const what = g.items.map((x) => x.label || x.id).join(' and ');
        const urgent = free < DISK_URGENT;
        out.push({
          code: `disk-low:${g.items[0].id || 'folder'}`, check: 'disk', severity: urgent ? 'urgent' : 'warn',
          text: urgent
            ? `💾 The drive with ${what} is almost full — only ${gbText(free)} left. Downloads, pictures and books can start failing; free some space now.`
            : `💾 The drive with ${what} has ${gbText(free)} free. One AI model needs 5–20 GB, so free some space before downloading more.`,
          fix: { label: '📂 Open the folder', open: g.path },
          okText: `✔ There's enough free space again on the drive with ${what}.`,
          freeBytes: free,
        });
      }
      return known || !list.length ? out : null;
    },

    async sd() {
      const s = await call('sd');
      if (!s) return null; // couldn't tell
      if (!s.enabled || !s.configured || !s.base) return OFF;
      if (!isLocalUrl(s.base)) return OFF; // only this computer
      if (['starting', 'restarting', 'stopped'].includes(s.runnerPhase)) return OFF; // coming up, or the user stopped it
      const up = await call('probe', s.base);
      if (up === undefined) return null;
      if (up) {
        // Answering is not enough: with no picture model loaded every picture fails ("Failed to find available model")
        // while the Images tab used to say "Connected ✓" (PC test). sdModels() -> { noModels, fix, canRestart, label }.
        const m = await call('sdModels');
        if (m && m.noModels) {
          return [{
            code: 'sd-no-model', check: 'sd', severity: 'warn',
            text: `🎨 ${m.label || 'Stable Diffusion'} is connected, but it has no picture model loaded, so every picture fails (“Failed to find available model”). ${m.fix || 'Point it at a folder with a model (.safetensors) and press Refresh on the 🎨 Images tab.'}`,
            fix: m.canRestart ? { label: `↻ Restart ${m.label || 'it'} with my models`, channel: 'sd:restart-with-models', args: [] } : null,
            okText: `✔ ${m.label || 'Stable Diffusion'} has a picture model now.`,
          }];
        }
        return [];
      }
      const canStart = s.canStart != null ? !!s.canStart : !!(await call('sdCanStart')); // looked up only when it's down
      return [{
        code: 'sd-down', check: 'sd', severity: 'warn',
        text: '🎨 Stable Diffusion was connected before but isn\'t answering now, so pictures will fail until it\'s running again.',
        fix: canStart ? { label: '▶ Start Stable Diffusion', channel: 'sd:start', args: [{}] } : null,
        okText: '✔ Stable Diffusion is answering again.',
      }];
    },

    async akowe() {
      const a = await call('akowe');
      if (!a) return null; // couldn't tell
      if (a.enabled === false) return OFF;
      if (a.phase === 'failed' && a.error !== 'NO_APP' && a.error !== 'NO_PYTHON') {
        return [{
          code: 'akowe-down', check: 'akowe', severity: 'urgent',
          text: `📖 Akọwe's server is down and AutoInjector stopped restarting it${a.error === 'CRASHED' ? ' (it kept crashing)' : ''} — the book tools won't work until it runs again.`,
          fix: { label: '↻ Try again', channel: 'akowe-server:retry', args: [] },
          okText: '✔ Akọwe\'s server is running again.',
        }];
      }
      if (a.phase === 'restarting' && Number(a.restarts) >= 2) {
        return [{
          code: 'akowe-restarting', check: 'akowe', severity: 'warn',
          text: `📖 Akọwe's server keeps stopping (restarted ${Number(a.restarts)} times in a row). AutoInjector is restarting it; its log says why.`,
          fix: { label: '📄 Open its log', channel: 'akowe-server:open-log', args: [] },
          okText: '✔ Akọwe\'s server is steady again.',
        }];
      }
      if (a.phase === 'running' || a.phase === 'idle' || a.phase === 'stopped' || a.phase === 'failed') return [];
      return null; // starting / checking …: wait and see
    },

    async panes() {
      const list = await call('panes');
      if (!Array.isArray(list)) return null;
      return list.filter((p) => p && p.active && p.state === 'broken').map((p) => ({
        code: `pane-broken:${p.site}`, check: 'panes', severity: 'warn',
        text: `💬 ${p.label || p.site} isn't working and self-repair couldn't fix it by itself${p.problem ? ` (${String(p.problem).slice(0, 80)})` : ''} — the other AIs carry on.`,
        fix: { label: '🩺 Check it again', channel: 'selfrepair:probe', args: [{ sites: [p.site] }] },
        okText: `✔ ${p.label || p.site} works again.`,
        alfred: false, // Alfred already announces broken panes himself (alfred.js onAppEvent)
      }));
    },

    async logs() {
      const dirs = ((await call('logDirs')) || []).filter(Boolean);
      if (!dirs.length) return null;
      let total = 0, known = false;
      for (const d of [...new Set(dirs)]) { const n = await dirSize(d); if (n != null) { known = true; total += n; } }
      if (!known) return null;
      if (total < LOGS_BIG) return [];
      return [{
        code: 'logs-big', check: 'logs', severity: total > 4 * LOGS_BIG ? 'urgent' : 'warn',
        text: `🧾 The logs folder has grown to ${gbText(total)}. Old reports and log bundles can go — delete the ones you no longer need.`,
        fix: { label: '📂 Open the logs folder', open: dirs[0] },
        okText: '✔ The logs folder is a sensible size again.',
        bytes: total,
      }];
    },

    // Your downloads are in ANOTHER AutoInjector folder (an earlier copy): offer to use them instead of downloading again.
    async content() {
      const c = await call('contentRoots');
      if (!c) return null;
      const other = Array.isArray(c.others) ? c.others[0] : null;
      if (!other || c.reason === 'chosen' || c.reason === 'found-earlier') return []; // you picked it / already using the earlier copy's
      return [{
        code: 'content-elsewhere', check: 'content', severity: 'warn',
        text: `📁 Your earlier downloads (${other.what.join(', ')}${other.bytes ? `, about ${gbText(other.bytes)}` : ''}) are in another AutoInjector folder: ${other.dir}. Use that folder so nothing has to be downloaded again.`,
        fix: { label: '📁 Use that folder (restarts the app)', channel: 'content:use-root', args: [{ root: other.root }] },
        okText: '✔ AutoInjector uses the folder with your downloads.',
      }];
    },
  };

  // ------------------------------------------------------------------------------------- run + dedupe
  function tell(type, problem, text) {
    // severity = the activity log's level (its "⚠ Errors only" filter); urgency = ours
    log('health', { state: type, code: problem.code, urgency: problem.severity, severity: type === 'fixed' ? 'info' : problem.severity === 'urgent' ? 'error' : 'warn', summary: String(text).slice(0, 300) });
    try { if (deps.notify) deps.notify({ type, problem: publicProblem(problem), text }); } catch (_) {}
  }
  function publicProblem(p) {
    const fix = p.fix ? { label: p.fix.label } : null;
    return { code: p.code, check: p.check, severity: p.severity, text: p.text, fix, alfred: p.alfred !== false, since: (active.get(p.code) || {}).since || null };
  }

  /** Run the checks (all, or opts.only), one run at a time. Resolves to status(). */
  function runOnce(opts = {}) {
    const next = chain.then(() => runChecks(opts), () => runChecks(opts));
    chain = next.catch(() => {});
    return next;
  }
  async function runChecks(opts) {
    const only = Array.isArray(opts.only) ? opts.only.filter((c) => CHECKS.includes(c)) : CHECKS;
    const t = now();
    for (const name of only) {
      let res;
      try { res = await checks[name](); } catch (_) { res = null; }
      if (res == null) continue; // couldn't tell: keep what we had
      const found = res === OFF ? [] : res;
      const codes = new Set(found.map((p) => p.code));
      // fixed (or no longer applies)
      for (const [code, a] of [...active]) {
        if (a.problem.check !== name || codes.has(code)) continue;
        active.delete(code);
        if (res !== OFF && !a.quiet) tell('fixed', a.problem, a.problem.okText || `✔ Fixed: ${a.problem.text}`);
      }
      // new / still there
      for (const p of found) {
        const a = active.get(p.code);
        if (!a) {
          // back within the hour after it was told (flapping): keep it, but quietly — no second line, no second "fixed"
          const prev = lastTold.get(p.code);
          const quiet = !!prev && t - prev.at < repeatMs && (SEVERITY_RANK[p.severity] || 0) <= (SEVERITY_RANK[prev.severity] || 0);
          active.set(p.code, { problem: p, since: t, toldAt: quiet ? prev.at : t, toldSeverity: quiet ? prev.severity : p.severity, quiet });
          if (!quiet) { lastTold.set(p.code, { at: t, severity: p.severity }); tell('problem', p, p.text); }
          continue;
        }
        a.problem = p;
        const worse = (SEVERITY_RANK[p.severity] || 0) > (SEVERITY_RANK[a.toldSeverity] || 0);
        if (worse || t - a.toldAt >= repeatMs) { a.toldAt = t; a.toldSeverity = p.severity; a.quiet = false; lastTold.set(p.code, { at: t, severity: p.severity }); tell('problem', p, p.text); }
      }
    }
    lastRun = t;
    return status();
  }

  function problems() { return [...active.values()].map((a) => publicProblem(a.problem)); }
  function status() {
    const list = problems();
    return {
      ok: true, problems: list, checkedAt: lastRun, watching: !!timer || !!firstTimer, checks: CHECKS.slice(),
      summary: lastRun == null ? 'Not checked yet.' : list.length ? `${list.length} thing${list.length === 1 ? '' : 's'} need${list.length === 1 ? 's' : ''} attention: ${list.map((p) => p.text).join(' ')}` : '✓ Nothing is wrong right now.',
    };
  }

  async function fix(code) {
    const a = active.get(String(code || ''));
    if (!a) return { ok: false, error: 'NO_SUCH_PROBLEM', message: 'That problem isn\'t there any more.', status: status() };
    const p = a.problem;
    if (!p.fix) return { ok: false, error: 'NO_FIX', message: 'There is no one-click fix for this one.', status: status() };
    log('health-fix', { code: p.code });
    let result;
    try { result = typeof deps.runFix === 'function' ? await deps.runFix(p.fix, publicProblem(p)) : { ok: false, error: 'NO_RUNNER' }; }
    catch (e) { result = { ok: false, error: 'FIX_FAILED', message: String((e && e.message) || e).slice(0, 200) }; }
    const st = await runOnce({ only: [p.check] });
    const ok = !!(result && result.ok !== false);
    return { ok, code: p.code, fixed: !active.has(p.code), message: (result && (result.message || result.error)) || (ok ? 'Done.' : 'That didn\'t work.'), result, status: st };
  }

  /** Run one check soon (an app event said something changed). Debounced. */
  function poke(name, delayMs) {
    if (!CHECKS.includes(name) || deps.noTimers) return;
    if (pokeTimers.has(name)) return;
    const t = setTimeout(() => { pokeTimers.delete(name); runOnce({ only: [name] }).catch(() => {}); }, delayMs == null ? 2000 : delayMs);
    if (t.unref) t.unref();
    pokeTimers.set(name, t);
  }
  function start() {
    stop();
    if (deps.noTimers) return;
    firstTimer = setTimeout(() => {
      firstTimer = null;
      runOnce().catch(() => {});
      timer = setInterval(() => { runOnce().catch(() => {}); }, deps.intervalMs || INTERVAL_MS);
      if (timer.unref) timer.unref();
    }, deps.firstDelayMs != null ? deps.firstDelayMs : FIRST_DELAY_MS);
    if (firstTimer.unref) firstTimer.unref();
  }
  function stop() {
    if (firstTimer) clearTimeout(firstTimer); firstTimer = null;
    if (timer) clearInterval(timer); timer = null;
    for (const t of pokeTimers.values()) clearTimeout(t); pokeTimers.clear();
  }

  return { start, stop, runOnce, poke, status, problems, fix };
}

module.exports = { createHealthWatch, gbText, isLocalUrl, ollamaBase, defaultFreeBytes, defaultDirSize, DISK_WARN, DISK_URGENT, LOGS_BIG, REPEAT_MS, INTERVAL_MS, CHECKS };
