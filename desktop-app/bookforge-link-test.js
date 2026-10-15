'use strict';
// bookforge-link-test.js — the "🧪 Test BookForge link" self-test. It checks the
// whole BookForge ⇄ AutoInjector path FOR REAL, the same way BookForge uses it:
// through the bridge's own loopback HTTP API with the real connection key, into
// each Active AI's window and back — and documents every step.
//
// Steps (each PASS / FAIL / SKIPPED, timed, with a plain-English detail and a
// "how to fix" tip on failure):
//   bridge_on          the bridge is on and listening on 127.0.0.1:<port>
//   key_file           the connection key file exists
//   wrong_key          GET /v1/health with a WRONG key is refused (401)
//   right_key          GET /v1/health with the real key works (200)
//   pane:<site>        for each Active AI: its window is loaded and free
//   roundtrip:<site>   POST /v1/complete (request_id "selftest-<stamp>-<site>")
//                      with a tiny JSON_SCHEMA prompt like BookForge sends; the
//                      reply must be one JSON object echoing a random word
//   bookforge_running  GET http://127.0.0.1:8780/api/ping (optional; SKIPPED
//                      with instructions when BookForge isn't running)
//
// The report NEVER contains the connection key or the prompt text; for each
// reply it keeps only the last 80 characters (to show how the reply ended).
//
// Pure orchestration with injected deps (like feature-test.js), so it's
// unit-testable without Electron.
const http = require('http');
const crypto = require('crypto');

const DEFAULT_BOOKFORGE_URL = 'http://127.0.0.1:8780/api/ping';
const DEFAULT_REPLY_TIMEOUT_MS = 180000;
const ENDING_CHARS = 80;
const WORDS = ['maple', 'harbor', 'lantern', 'meadow', 'copper', 'violet', 'pebble', 'falcon', 'orchard', 'cobalt',
  'willow', 'saffron', 'glacier', 'thistle', 'ember', 'juniper', 'quartz', 'tundra', 'marble', 'sparrow'];

const STEP_NAMES = {
  bridge_on: 'The bridge is on and listening',
  key_file: 'The connection key exists',
  wrong_key: 'A wrong connection key is refused',
  right_key: 'The right connection key is accepted',
  bookforge_running: 'BookForge is running?',
};
const TIPS = {
  bridge_off: 'Tick “Turn the bridge on” in this panel, then run the test again.',
  port_in_use: 'Another program (often a second copy of AutoInjector) is using that port. Close it, then untick and tick “Turn the bridge on” again.',
  bridge_error: 'Untick and tick “Turn the bridge on” again. If it keeps failing, restart AutoInjector and look in the Activity Log for “bookforge-error”.',
  key_file: 'Turn the bridge off and on again — the app makes a new connection key automatically. Then copy it into BookForge again.',
  wrong_key: 'IMPORTANT: the bridge did not refuse a wrong key. Turn the bridge off and do not use it until this is fixed — report it.',
  right_key: 'The bridge did not accept its own key. Click “Make a new key”, paste the new key into BookForge, and run the test again.',
  pane_missing: 'Tick this AI as Active in the app and let its window finish loading (log in if it asks), then run the test again.',
  roundtrip_timeout: 'Look at that AI’s window: is it still typing, showing an error, or asking you to log in? Its reply must end with its [FROM: NAME] tag so the app knows it has finished. Let it go idle, then test again.',
  roundtrip_send: 'The app could not type into that AI’s window. Make sure it is logged in and no pop-up is covering the message box, or run that pane’s own 🧪 Test, then test again.',
  roundtrip_not_ready: 'That AI’s window is not loaded. Reload it (or log in), wait until it is idle, then test again.',
  roundtrip_auth: 'The connection key changed while the test was running. Run the test again.',
  roundtrip_json: 'The AI answered, but not with the one JSON object it was asked for. BookForge re-asks automatically when this happens, so occasional slips are OK; if it keeps happening, start a new chat in that AI’s window and test again.',
  roundtrip_word: 'The AI answered with JSON but did not repeat the test word — the reply may have come from an earlier message. Let the window go idle, then test again.',
  roundtrip_other: 'Run the test again. If it keeps failing, look in the Activity Log for “bookforge-” lines.',
};

function stampNow(d) {
  const t = d instanceof Date ? d : new Date();
  return t.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261015-140233
}
function fmtMs(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The test prompt: same shape BookForge's adapter sends (JSON_SCHEMA: block).
function buildPrompt(site, word) {
  const schema = {
    type: 'object', additionalProperties: false, required: ['ok', 'site', 'word'],
    properties: { ok: { type: 'boolean', const: true }, site: { type: 'string', const: site }, word: { type: 'string', const: word } },
  };
  return [
    'AutoInjector link test (automatic — this app is checking its BookForge connection; this is not a task).',
    '',
    `Reply with exactly this JSON object: {"ok": true, "site": "${site}", "word": "${word}"}`,
    '',
    'JSON_SCHEMA:',
    JSON.stringify(schema),
    'END_JSON_SCHEMA',
    '',
    'Answer with exactly one JSON object that validates against JSON_SCHEMA. Output only that JSON object: no explanations, no extra objects, no markdown other than an optional ```json fence.',
  ].join('\n');
}

// Find the JSON object in a reply and say how the reply was shaped.
function analyzeReply(text) {
  const raw = String(text == null ? '' : text);
  const t = raw.trim();
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (_) { return null; } };
  let obj = tryParse(t);
  if (obj) return { obj, how: 'just the JSON object (perfect)' };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && (obj = tryParse(fence[1].trim()))) {
    const outside = t.replace(fence[0], '').trim();
    return { obj, how: outside ? 'JSON in a code block, with extra words around it' : 'JSON in a ```json code block (fine)' };
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a && (obj = tryParse(t.slice(a, b + 1)))) return { obj, how: 'JSON with extra words around it (BookForge copes with this)' };
  return { obj: null, how: t ? 'no JSON object found in the reply' : 'an empty reply' };
}

// Default HTTP client (Node http, loopback). Resolves { status, json, text };
// rejects with an Error carrying .code (ECONNREFUSED, ETIMEDOUT, ...).
function nodeHttp({ method = 'GET', url, headers = {}, body, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(Object.assign(new Error('bad url'), { code: 'BAD_URL' })); return; }
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const h = Object.assign({}, headers);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

// deps:
//   sites: ['claude', ...]                   AIs that are Active in the app, in order
//   label(site) -> 'Claude'
//   getStatus() -> { enabled, listening, host, port, error }
//   keyFileExists() -> bool
//   readKey() -> string                      the real connection key ('' if none)
//   siteReady(site) -> bool
//   http({ method, url, headers, body, timeoutMs }) -> Promise<{ status, json, text }>  (default: nodeHttp)
//   bookforgeUrl (default http://127.0.0.1:8780/api/ping)
//   replyTimeoutMs (default 180000; clamped to the bridge's 10000..900000)
//   onProgress({ id, name, site, index, total, status, detail })
//   shouldStop() -> bool, now(), sleep(ms), pollMs, randomWord(), stamp
async function runLinkTest(deps) {
  const d = Object.assign({
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 250,
    onProgress: () => {},
    shouldStop: () => false,
    label: (s) => s,
    http: nodeHttp,
    bookforgeUrl: DEFAULT_BOOKFORGE_URL,
    replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
    randomWord: () => WORDS[crypto.randomInt(WORDS.length)],
    siteReady: () => true,
  }, deps || {});
  const sites = (d.sites || []).slice();
  const stamp = d.stamp || stampNow();
  const replyTimeoutMs = Math.min(900000, Math.max(10000, Math.round(Number(d.replyTimeoutMs) || DEFAULT_REPLY_TIMEOUT_MS)));
  const startedAt = d.now();

  const plan = ['bridge_on', 'key_file', 'wrong_key', 'right_key'];
  for (const s of sites) plan.push(`pane:${s}`, `roundtrip:${s}`);
  plan.push('bookforge_running');
  const total = plan.length;
  const results = [];
  let stopped = false;

  const nameOf = (id) => {
    const [kind, site] = id.split(':');
    if (kind === 'pane') return `${d.label(site)} — window loaded and ready`;
    if (kind === 'roundtrip') return `${d.label(site)} — real round trip through the bridge`;
    return STEP_NAMES[id] || id;
  };
  const progress = (p) => { try { d.onProgress(p); } catch (_) {} };
  const record = (id, status, detail, t0, extra) => {
    const site = id.includes(':') ? id.split(':')[1] : null;
    const r = Object.assign({ id, name: nameOf(id), site, status, detail: String(detail || ''), ms: Math.max(0, d.now() - t0) }, extra || {});
    if (status !== 'fail') delete r.tip;
    results.push(r);
    progress({ id, name: r.name, site, index: results.length, total, status, detail: r.detail, tip: r.tip || null, ms: r.ms });
    return r;
  };
  const begin = (id) => {
    progress({ id, name: nameOf(id), site: id.includes(':') ? id.split(':')[1] : null, index: results.length, total, status: 'running' });
    return d.now();
  };
  const checkStop = () => { if (!stopped && d.shouldStop()) stopped = true; return stopped; };
  // Run an HTTP call, but give up waiting (not the request) when the user stops.
  const httpOrStop = async (req) => {
    let done = false;
    const call = Promise.resolve().then(() => d.http(req)).then((res) => ({ res }), (err) => ({ err }));
    const watch = (async () => {
      while (!done) {
        if (d.shouldStop()) return { stopped: true };
        await d.sleep(d.pollMs);
      }
      return { finished: true };
    })();
    const out = await Promise.race([call, watch]);
    done = true;
    if (out.stopped) stopped = true;
    return out;
  };

  const st = (() => { try { return d.getStatus() || {}; } catch (_) { return {}; } })();
  const host = st.host || '127.0.0.1';
  const port = st.port;
  const base = `http://${host}:${port}`;
  let bridgeOk = false;
  let key = '';
  let rightKeyOk = false;
  let health = null;

  // 1. bridge on + listening
  if (!checkStop()) {
    const t0 = begin('bridge_on');
    if (!st.enabled) record('bridge_on', 'fail', 'The bridge is turned off, so BookForge cannot reach this app.', t0, { tip: TIPS.bridge_off });
    else if (!st.listening) {
      const inUse = st.error === 'EADDRINUSE';
      record('bridge_on', 'fail', inUse ? `Port ${port} is already being used by another program, so the bridge could not start.` : `The bridge is turned on but is not listening (${st.error || 'still starting'}).`, t0, { tip: inUse ? TIPS.port_in_use : TIPS.bridge_error });
    } else { bridgeOk = true; record('bridge_on', 'pass', `On and listening on ${host}:${port} (this computer only).`, t0); }
  }
  // 2. key file
  if (!checkStop()) {
    const t0 = begin('key_file');
    let exists = false;
    try { exists = !!d.keyFileExists(); } catch (_) { exists = false; }
    try { key = exists ? String(d.readKey() || '') : ''; } catch (_) { key = ''; }
    if (exists && key) record('key_file', 'pass', 'The connection key file exists (the key itself is never written to this report).', t0);
    else record('key_file', 'fail', exists ? 'The key file exists but could not be read or is too short.' : 'There is no connection key yet.', t0, { tip: TIPS.key_file });
  }
  // 3. wrong key refused
  if (!checkStop()) {
    const t0 = begin('wrong_key');
    if (!bridgeOk) record('wrong_key', 'skip', 'Skipped — needs the bridge to be on and listening.', t0);
    else {
      const wrong = `wrong-${crypto.randomBytes(18).toString('base64url')}`;
      const out = await httpOrStop({ method: 'GET', url: `${base}/v1/health`, headers: { Authorization: `Bearer ${wrong}`, 'X-AutoInjector-Selftest': '1' }, timeoutMs: 8000 });
      if (out.stopped) record('wrong_key', 'skip', 'Stopped by you.', t0);
      else if (out.err) record('wrong_key', 'fail', `Could not reach the bridge (${out.err.code || out.err.message}).`, t0, { tip: TIPS.bridge_error, http_status: null });
      else if (out.res.status === 401) record('wrong_key', 'pass', 'A made-up key was refused (HTTP 401), so only your BookForge can connect.', t0, { http_status: 401 });
      else record('wrong_key', 'fail', `A made-up key was NOT refused (HTTP ${out.res.status}).`, t0, { tip: TIPS.wrong_key, http_status: out.res.status });
    }
  }
  // 4. right key accepted
  if (!checkStop()) {
    const t0 = begin('right_key');
    if (!bridgeOk || !key) record('right_key', 'skip', !bridgeOk ? 'Skipped — needs the bridge to be on and listening.' : 'Skipped — there is no connection key.', t0);
    else {
      const out = await httpOrStop({ method: 'GET', url: `${base}/v1/health`, headers: { Authorization: `Bearer ${key}`, 'X-AutoInjector-Selftest': '1' }, timeoutMs: 8000 });
      if (out.stopped) record('right_key', 'skip', 'Stopped by you.', t0);
      else if (out.err) record('right_key', 'fail', `Could not reach the bridge (${out.err.code || out.err.message}).`, t0, { tip: TIPS.bridge_error });
      else if (out.res.status === 200 && out.res.json && out.res.json.ok === true) {
        rightKeyOk = true;
        health = out.res.json;
        record('right_key', 'pass', `Your connection key works (HTTP 200, bridge version ${health.bridge_version || '?'}).`, t0, { http_status: 200 });
      } else record('right_key', 'fail', `The bridge answered HTTP ${out.res.status} to its own key.`, t0, { tip: TIPS.right_key, http_status: out.res.status });
    }
  }
  // 5. each Active AI: pane ready, then a real round trip
  for (const site of sites) {
    const L = d.label(site);
    let paneOk = false;
    let paneSkipReason = null;
    if (!checkStop()) {
      const t0 = begin(`pane:${site}`);
      let ready = false;
      try { ready = !!d.siteReady(site); } catch (_) { ready = false; }
      const hs = health && health.sites ? health.sites[site] : null;
      if (hs && hs.ready === false) ready = false;
      if (!ready) record(`pane:${site}`, 'fail', `${L}'s window is missing or still loading.`, t0, { tip: TIPS.pane_missing });
      else if (hs && hs.busy) { paneSkipReason = `${L} is busy answering a BookForge request right now.`; record(`pane:${site}`, 'skip', `${paneSkipReason} Run the test again when it's done.`, t0); }
      else { paneOk = true; record(`pane:${site}`, 'pass', `${L}'s window is loaded and free.`, t0); }
    }
    if (checkStop()) break;
    const id = `roundtrip:${site}`;
    const t0 = begin(id);
    if (!rightKeyOk) { record(id, 'skip', 'Skipped — the bridge or the connection key check did not pass.', t0); continue; }
    if (!paneOk) { record(id, 'skip', paneSkipReason ? `Skipped — ${paneSkipReason}` : `Skipped — ${L}'s window is not ready.`, t0); continue; }
    const word = String(d.randomWord() || 'maple');
    const requestId = `selftest-${stamp}-${site}`;
    const out = await httpOrStop({
      method: 'POST', url: `${base}/v1/complete`,
      headers: { Authorization: `Bearer ${key}`, 'X-AutoInjector-Selftest': '1' },
      body: { site, prompt: buildPrompt(site, word), request_id: requestId, timeout_ms: replyTimeoutMs },
      timeoutMs: replyTimeoutMs + 20000,
    });
    const extra = { request_id: requestId };
    if (out.stopped) { record(id, 'skip', `Stopped by you while waiting for ${L}. (${L} may still answer; the bridge keeps that answer to itself.)`, t0, extra); break; }
    if (out.err) { record(id, 'fail', `Could not reach the bridge (${out.err.code || out.err.message}).`, t0, Object.assign(extra, { tip: TIPS.bridge_error })); continue; }
    const res = out.res;
    const j = res.json || {};
    extra.http_status = res.status;
    if (res.status === 200 && j.ok === true) {
      const text = String(j.text == null ? '' : j.text);
      const a = analyzeReply(text);
      extra.elapsed_ms = typeof j.elapsed_ms === 'number' ? j.elapsed_ms : null;
      extra.how_ended = a.how;
      extra.ending = text.slice(-ENDING_CHARS);
      extra.reply_chars = text.length;
      const took = fmtMs(extra.elapsed_ms != null ? extra.elapsed_ms : d.now() - t0);
      if (!a.obj) record(id, 'fail', `${L} answered in ${took}, but the reply had ${a.how}.`, t0, Object.assign(extra, { tip: TIPS.roundtrip_json }));
      else if (String(a.obj.word || '').trim().toLowerCase() !== word.toLowerCase()) record(id, 'fail', `${L} answered in ${took} with JSON, but did not repeat the test word.`, t0, Object.assign(extra, { tip: TIPS.roundtrip_word }));
      else if (a.obj.ok !== true) record(id, 'fail', `${L} answered in ${took}, but "ok" was not true.`, t0, Object.assign(extra, { tip: TIPS.roundtrip_json }));
      else record(id, 'pass', `${L} answered in ${took} with the right JSON (${a.how}).`, t0, extra);
    } else if (res.status === 504) record(id, 'fail', `Sent, but ${L} had not finished answering after ${fmtMs(replyTimeoutMs)} (timed out).`, t0, Object.assign(extra, { tip: TIPS.roundtrip_timeout }));
    else if (res.status === 503) record(id, 'fail', `${L}'s window was not ready when the test asked.`, t0, Object.assign(extra, { tip: TIPS.roundtrip_not_ready }));
    else if (res.status === 502) record(id, 'fail', `The test question could not be typed into ${L}'s window.`, t0, Object.assign(extra, { tip: TIPS.roundtrip_send }));
    else if (res.status === 409) record(id, 'skip', `${L} is busy with a BookForge request right now — run the test again when it's done.`, t0, extra);
    else if (res.status === 401) record(id, 'fail', 'The bridge refused the connection key during the test.', t0, Object.assign(extra, { tip: TIPS.roundtrip_auth }));
    else record(id, 'fail', `Unexpected answer from the bridge (HTTP ${res.status}${j.error ? `, ${j.error}` : ''}).`, t0, Object.assign(extra, { tip: TIPS.roundtrip_other }));
  }
  // 6. is BookForge itself running? (optional)
  if (!checkStop()) {
    const t0 = begin('bookforge_running');
    const url = d.bookforgeUrl || DEFAULT_BOOKFORGE_URL;
    const out = await httpOrStop({ method: 'GET', url, headers: {}, timeoutMs: 5000 });
    const where = (() => { try { const u = new URL(url); return `${u.hostname}:${u.port || 80}`; } catch (_) { return url; } })();
    if (out.stopped) record('bookforge_running', 'skip', 'Stopped by you.', t0);
    else if (out.err) record('bookforge_running', 'skip', `BookForge isn't running right now (nothing answered at ${where}). That's fine for this test — start BookForge (bookforge/run-bookforge.bat) and run the test again to check it too.`, t0, { url });
    else if (out.res.status === 200 && out.res.json && out.res.json.app === 'bookforge') {
      const v = out.res.json.version ? ` version ${out.res.json.version}` : '';
      record('bookforge_running', 'pass', `BookForge${v} is running at ${where}.`, t0, { url, http_status: 200 });
    } else record('bookforge_running', 'skip', `Something answered at ${where} (HTTP ${out.res.status}) but it didn't say it is BookForge — an older BookForge without /api/ping, or another program. Update BookForge, or check what uses that port.`, t0, { url, http_status: out.res.status });
  }
  // Anything the stop cut short is recorded as skipped so the report is complete.
  if (stopped) {
    const t = d.now();
    for (const id of plan) if (!results.some((r) => r.id === id)) record(id, 'skip', 'Stopped by you before this step ran.', t);
  }

  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const skipCount = results.filter((r) => r.status === 'skip').length;
  const trips = results.filter((r) => r.id.startsWith('roundtrip:'));
  let headline;
  if (stopped) headline = 'Test stopped before the end.';
  else if (failCount === 0 && trips.length && trips.every((r) => r.status === 'pass')) headline = 'Everything works — BookForge can use your AIs.';
  else if (failCount === 0 && !sites.length) headline = 'The bridge works, but no AI is Active in the app, so nothing was sent.';
  else if (failCount === 0) headline = 'No problems found, but some checks were skipped.';
  else headline = `${failCount} problem${failCount === 1 ? '' : 's'} found — see “how to fix” below.`;
  return { ok: true, stamp, stopped, startedAt, finishedAt: d.now(), sites, bridge: { host, port }, replyTimeoutMs, results, passCount, failCount, skipCount, total: results.length, headline };
}

const ICON = { pass: '✅ PASS', fail: '❌ FAIL', skip: '⚪ SKIPPED' };
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');

// meta: { appVersion, env: { os, arch, node, electron }, bookforgeUrl, activity: [{ at, say }], when }
function formatReport(r, meta = {}) {
  const when = meta.when instanceof Date ? meta.when : new Date(r.startedAt || Date.now());
  const env = meta.env || {};
  const L = [];
  L.push(`# BookForge link test — ${when.toLocaleString()}`, '');
  L.push(`**${r.headline}**`, '');
  L.push(`${r.passCount} passed · ${r.failCount} failed · ${r.skipCount} skipped${r.stopped ? ' · stopped early' : ''} · took ${fmtMs((r.finishedAt || 0) - (r.startedAt || 0))}`, '');
  L.push('## Environment', '');
  L.push(`- Date: ${when.toISOString()}`);
  L.push(`- AutoInjector version: ${meta.appVersion || '?'}`);
  L.push(`- Operating system: ${env.os || '?'}${env.arch ? ` (${env.arch})` : ''}`);
  if (env.electron || env.node) L.push(`- Electron ${env.electron || '?'} · Node ${env.node || '?'}`);
  L.push(`- Bridge: http://${(r.bridge && r.bridge.host) || '127.0.0.1'}:${(r.bridge && r.bridge.port) || '?'} (this computer only)`);
  L.push(`- BookForge checked at: ${meta.bookforgeUrl || DEFAULT_BOOKFORGE_URL}`);
  L.push(`- AIs Active in the app: ${(r.sites || []).length ? r.sites.join(', ') : 'none'}`);
  L.push(`- Reply time limit per AI: ${fmtMs(r.replyTimeoutMs)}`, '');
  L.push('## Steps', '', '| # | Step | Result | What happened | Time |', '|---|---|---|---|---|');
  r.results.forEach((x, i) => L.push(`| ${i + 1} | ${cell(x.name)} | ${ICON[x.status] || x.status} | ${cell(x.detail)} | ${(x.ms / 1000).toFixed(1)}s |`));
  const fails = r.results.filter((x) => x.status === 'fail');
  if (fails.length) {
    L.push('', '## How to fix', '');
    for (const f of fails) L.push(`- **${f.name}** — ${f.tip || TIPS.roundtrip_other}`);
  }
  const trips = r.results.filter((x) => x.id.startsWith('roundtrip:') && (x.ending != null || x.http_status != null));
  if (trips.length) {
    L.push('', '## How each reply ended', '',
      `Only the last ${ENDING_CHARS} characters of each test reply are kept (never the question or the full reply).`, '');
    for (const t of trips) {
      L.push(`### ${t.name.split(' — ')[0]}`, '');
      L.push(`- Request: \`${t.request_id || '?'}\` · HTTP ${t.http_status != null ? t.http_status : '—'}${t.elapsed_ms != null ? ` · answered in ${fmtMs(t.elapsed_ms)}` : ''}${t.reply_chars != null ? ` · ${t.reply_chars} characters` : ''}`);
      if (t.how_ended) L.push(`- Shape: ${t.how_ended}`);
      if (t.ending != null) L.push('', '```', String(t.ending).replace(/```/g, "'''"), '```');
      L.push('');
    }
  }
  const act = Array.isArray(meta.activity) ? meta.activity : [];
  L.push('', '## Recent bridge activity', '');
  if (!act.length) L.push('_No bridge activity recorded this session._');
  for (const a of act) L.push(`- ${a.at ? new Date(a.at).toLocaleTimeString() : '?'} — ${cell(a.say || a.kind)}`);
  L.push('');
  return L.join('\n');
}

// The machine-readable twin of the Markdown report.
function reportJson(r, meta = {}) {
  return {
    kind: 'bookforge-link-test',
    version: 1,
    date: new Date(r.startedAt || Date.now()).toISOString(),
    app_version: meta.appVersion || null,
    environment: Object.assign({ bridge_host: (r.bridge && r.bridge.host) || '127.0.0.1', bridge_port: (r.bridge && r.bridge.port) || null, bookforge_url: meta.bookforgeUrl || DEFAULT_BOOKFORGE_URL }, meta.env || {}),
    headline: r.headline,
    stopped: !!r.stopped,
    counts: { passed: r.passCount, failed: r.failCount, skipped: r.skipCount, total: r.total },
    duration_ms: (r.finishedAt || 0) - (r.startedAt || 0),
    sites: r.sites || [],
    reply_timeout_ms: r.replyTimeoutMs,
    steps: r.results.map((x) => {
      const o = { id: x.id, name: x.name, site: x.site, result: x.status, detail: x.detail, ms: x.ms };
      for (const k of ['tip', 'http_status', 'request_id', 'elapsed_ms', 'how_ended', 'ending', 'reply_chars', 'url']) if (x[k] !== undefined && x[k] !== null) o[k] = x[k];
      return o;
    }),
    activity: (Array.isArray(meta.activity) ? meta.activity : []).map((a) => ({ at: a.at ? new Date(a.at).toISOString() : null, kind: a.kind, site: a.site || null, outcome: a.outcome || null, http_status: a.http_status != null ? a.http_status : null, say: a.say || null })),
  };
}

const REPORT_NAME_RE = /^bookforge-link-test-[0-9A-Za-z-]+\.(md|json)$/;

module.exports = { runLinkTest, formatReport, reportJson, buildPrompt, analyzeReply, nodeHttp, stampNow, fmtMs, STEP_NAMES, TIPS, REPORT_NAME_RE, DEFAULT_BOOKFORGE_URL, DEFAULT_REPLY_TIMEOUT_MS, ENDING_CHARS };
