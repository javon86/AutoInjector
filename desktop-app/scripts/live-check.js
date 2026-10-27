#!/usr/bin/env node
'use strict';
/*
 * scripts/live-check.js — checks every outside website the app depends on, so a
 * site that changed (a new page layout, a renamed file, a moved download) is
 * caught by us before a user hits it. Plain Node (no Electron); needs internet.
 *
 *   node scripts/live-check.js                 # table on stdout
 *   node scripts/live-check.js --markdown f.md # also write a Markdown table
 *   node scripts/live-check.js --json f.json   # also write the raw results
 *   node scripts/live-check.js --only ollama   # just the checks whose group matches
 *
 * Every check has a timeout, is retried once when it fails, and never throws.
 * Each ends as:
 *   ok           works as the app expects
 *   CHANGED      the site answered, but not the way the app expects (page layout
 *                changed, file renamed/removed, size differs) — the app needs a fix
 *   UNREACHABLE  no usable answer (network, timeout, 5xx, rate limit) — maybe temporary
 * Exit code: 0 all required checks ok; 1 something CHANGED; 2 only UNREACHABLE
 * failures. "info" checks (sites the app only opens in a browser pane, optional
 * paid APIs, the GitHub release API the app has a fallback for) are reported but
 * never fail the run.
 *
 * URLs are read from the app's own modules (model-catalog, llm-setup,
 * sd-installer, video-installer, setup-manager, selectors, manager-provider), so
 * when the app changes a URL this script follows. Nothing big is downloaded:
 * files are checked with HEAD, or a 1-byte ranged GET when HEAD isn't enough.
 * The pure parts (classify, parseContentRange, verdicts, table) are exported and
 * tested in test/live-check.test.js.
 */
const path = require('path');

const APP = path.join(__dirname, '..');
const UA = 'AutoInjector-live-check (+https://github.com/javon86/AutoInjector)';

// ------------------------------------------------------------------ pure helpers
/** "bytes 0-0/12345" → 12345 (null if unknown). */
function parseContentRange(v) {
  const m = /\/(\d+)\s*$/.exec(String(v || ''));
  return m ? Number(m[1]) : null;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n == null) return '?';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Turn one HTTP probe into a verdict.
 * probe: { status?, bytes?, error?, finalUrl? }
 * expect: { bytes? (exact), minBytes?, site? (bot-protected browser site: any non-404 answer is fine) }
 * → { status: 'ok'|'CHANGED'|'UNREACHABLE', reason }
 */
function classify(probe, expect) {
  const p = probe || {}; const e = expect || {};
  if (p.error || typeof p.status !== 'number') return { status: 'UNREACHABLE', reason: `no answer (${p.error || 'unknown error'})` };
  const s = p.status;
  if (s === 404 || s === 410) return { status: 'CHANGED', reason: `HTTP ${s}: the file/page is gone or was renamed` };
  if (e.site) {
    if (s >= 500) return { status: 'UNREACHABLE', reason: `HTTP ${s}: the site is having trouble` };
    return { status: 'ok', reason: s >= 400 ? `reachable (HTTP ${s} to a script is normal for this site)` : `reachable (HTTP ${s})` };
  }
  if (s === 429 || s >= 500) return { status: 'UNREACHABLE', reason: `HTTP ${s}: busy or broken right now` };
  if (s === 401 || s === 403) return { status: 'CHANGED', reason: `HTTP ${s}: now needs permission/login` };
  if (s < 200 || s >= 300) return { status: 'CHANGED', reason: `unexpected HTTP ${s}` };
  const size = Number.isFinite(p.bytes) ? p.bytes : null;
  if (e.bytes != null && size != null && size !== e.bytes) {
    return { status: 'CHANGED', reason: `size is now ${size} bytes, the app expects ${e.bytes} (its size check would reject the download)` };
  }
  if (e.minBytes != null && size != null && size < e.minBytes) {
    return { status: 'CHANGED', reason: `only ${fmtBytes(size)}, the app expects at least ${fmtBytes(e.minBytes)}` };
  }
  const sz = size != null ? `, ${fmtBytes(size)}` : (e.bytes != null || e.minBytes != null ? ', size not reported' : '');
  return { status: 'ok', reason: `HTTP ${s}${sz}` };
}

/** Verdict for catalog.searchOllama(): needs ≥min models with names, sizes, capabilities. */
function ollamaVerdict(r, net, min) {
  const need = min || 5;
  const nr = netVerdict(r, net, 'The Ollama search page');
  if (nr) return nr;
  const models = (r && r.models) || [];
  const named = models.filter((m) => m && m.name);
  const sized = named.filter((m) => m.variants && m.variants.some((v) => v.params));
  const caps = named.filter((m) => m.tools || m.vision || m.thinking || m.embedding);
  if (named.length < need) return { status: 'CHANGED', reason: `only ${named.length} model(s) read from the search page (need ${need}) — the page layout probably changed; see parseOllamaSearchHtml` };
  if (sized.length < Math.ceil(named.length / 2)) return { status: 'CHANGED', reason: `${named.length} models but only ${sized.length} with sizes (e.g. 7b) — the size labels moved` };
  if (!caps.length) return { status: 'CHANGED', reason: `${named.length} models but none with capabilities (tools/vision/thinking) — the capability labels moved` };
  return { status: 'ok', reason: `${named.length} models, ${sized.length} with sizes, ${caps.length} with capabilities (e.g. ${named.slice(0, 3).map((m) => m.name).join(', ')})` };
}

/** Verdict for catalog.searchHf(). */
function hfSearchVerdict(r, net, min) {
  const need = min || 3;
  const nr = netVerdict(r, net, 'Hugging Face search');
  if (nr) return nr;
  const models = ((r && r.models) || []).filter((m) => m && m.repo);
  if (models.length < need) return { status: 'CHANGED', reason: `only ${models.length} GGUF model(s) found (need ${need}) — the search API answer changed` };
  const withDl = models.filter((m) => m.downloads != null).length;
  if (!withDl) return { status: 'CHANGED', reason: `${models.length} models but no download counts — the API fields changed` };
  return { status: 'ok', reason: `${models.length} models (e.g. ${models.slice(0, 2).map((m) => m.repo).join(', ')})` };
}

/** Verdict for catalog.hfFiles(). */
function hfFilesVerdict(r, net, min) {
  const need = min || 3;
  const nr = netVerdict(r, net, 'Hugging Face file list');
  if (nr) return nr;
  const vs = (r && r.variants) || [];
  const sized = vs.filter((v) => Number(v.sizeBytes) > 0);
  if (!r || !r.ok || vs.length < need) return { status: 'CHANGED', reason: `${vs.length} GGUF variant(s) read (need ${need})${r && r.error ? `: ${r.error}` : ''}` };
  if (sized.length < vs.length) return { status: 'CHANGED', reason: `${vs.length} variants but ${vs.length - sized.length} without a size — the blobs=true answer changed` };
  const q4 = vs.find((v) => /Q4_K_M/i.test(v.quant || v.tag || ''));
  return { status: 'ok', reason: `${vs.length} variants with sizes${q4 ? ` (Q4_K_M ${fmtBytes(q4.sizeBytes)})` : ''}` };
}

// Shared: did the request itself fail? net = { status, error } of the last fetch.
function netVerdict(r, net, what) {
  const n = net || {};
  if (n.error) return { status: 'UNREACHABLE', reason: `${what}: no answer (${n.error})` };
  if (typeof n.status === 'number' && (n.status < 200 || n.status >= 300)) {
    const c = classify({ status: n.status }, {});
    return { status: c.status, reason: `${what}: ${c.reason}` };
  }
  if (r && r.ok === false && !(r.models || r.variants || []).length && typeof n.status !== 'number') {
    return { status: 'UNREACHABLE', reason: `${what}: ${r.error || 'failed'}` };
  }
  return null;
}

/** Verdict for the ComfyUI GitHub release: every asset the app downloads must be attached. */
function releaseVerdict(json, assets) {
  const list = json && Array.isArray(json.assets) ? json.assets : null;
  if (!list) return { status: 'CHANGED', reason: 'GitHub release answer has no assets list' };
  const names = new Set(list.map((a) => a && a.name));
  const missing = assets.filter((a) => !names.has(a));
  if (missing.length) return { status: 'CHANGED', reason: `release ${json.tag_name || '?'} is missing ${missing.join(', ')} — sd-installer BUILDS needs updating` };
  return { status: 'ok', reason: `release ${json.tag_name || '?'} has all ${assets.length} Windows portable builds` };
}

/** Several alternative URLs (e.g. .tgz or .tar.zst): ok if any is ok. */
function anyOf(results) {
  const ok = results.find((r) => r.status === 'ok');
  const desc = results.map((r) => `${r.label}: ${r.status === 'ok' ? r.reason : r.status}`).join('; ');
  if (ok) return { status: 'ok', reason: desc };
  const allChanged = results.every((r) => r.status === 'CHANGED');
  return { status: allChanged ? 'CHANGED' : 'UNREACHABLE', reason: desc };
}

function exitCode(results) {
  const req = results.filter((r) => !r.info);
  if (req.some((r) => r.status === 'CHANGED')) return 1;
  if (req.some((r) => r.status !== 'ok')) return 2;
  return 0;
}

function summary(results) {
  const c = { ok: 0, CHANGED: 0, UNREACHABLE: 0 };
  for (const r of results) c[r.status] = (c[r.status] || 0) + 1;
  return `${results.length} checks: ${c.ok} ok, ${c.CHANGED} CHANGED, ${c.UNREACHABLE} UNREACHABLE`;
}

function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return max && t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Plain-text table for the terminal / CI log. */
function formatTable(results) {
  const rows = results.map((r) => [r.status + (r.info ? ' (info)' : ''), r.group, r.name, oneLine(r.reason, 140)]);
  const head = ['RESULT', 'GROUP', 'CHECK', 'REASON'];
  const w = [0, 1, 2].map((i) => Math.max(head[i].length, ...rows.map((x) => x[i].length)));
  const line = (x) => [0, 1, 2].map((i) => x[i].padEnd(w[i])).join('  ') + '  ' + x[3];
  return [line(head), line(w.map((n) => '-'.repeat(n)).concat('------')), ...rows.map(line), '', summary(results)].join('\n');
}

/** Markdown table (for the GitHub issue). Problems first. */
function formatMarkdown(results, meta) {
  const order = { CHANGED: 0, UNREACHABLE: 1, ok: 2 };
  const sorted = results.slice().sort((a, b) => (order[a.status] - order[b.status]) || ((a.info ? 1 : 0) - (b.info ? 1 : 0)));
  const esc = (s) => oneLine(s, 300).replace(/\|/g, '\\|');
  const icon = (r) => (r.status === 'ok' ? 'ok' : `**${r.status}**`) + (r.info ? ' (info)' : '');
  const lines = [
    `${summary(results)}${meta && meta.when ? ` — ${meta.when}` : ''}`,
    '',
    '| Result | Group | Check | Reason | URL |',
    '|---|---|---|---|---|',
    ...sorted.map((r) => `| ${icon(r)} | ${esc(r.group)} | ${esc(r.name)} | ${esc(r.reason)} | ${r.url ? `<${r.url}>` : ''} |`),
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ network (injectable)
function timeoutSignal(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}
function errText(e) {
  const parts = [e && e.name === 'AbortError' ? 'timed out' : null, e && e.cause && e.cause.code, e && e.message].filter(Boolean);
  return oneLine(parts.join(': ') || String(e), 120);
}
async function drop(res) { try { if (res && res.body && res.body.cancel) await res.body.cancel(); } catch (_) {} }

/**
 * Probe a file URL without downloading it: HEAD (following redirects); if HEAD
 * is refused or gives no length, a GET for byte 0 only.
 * → { status, bytes, finalUrl } | { error }
 */
async function probe(url, opts) {
  const o = opts || {};
  const f = o.fetch || fetch;
  const ms = o.timeoutMs || 20000;
  const headers = Object.assign({ 'User-Agent': UA }, o.headers || {});
  let head = null;
  const t1 = timeoutSignal(ms);
  try {
    const res = await f(url, { method: 'HEAD', redirect: 'follow', headers, signal: t1.signal });
    const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    const linked = Number(res.headers && res.headers.get && res.headers.get('x-linked-size'));
    head = { status: res.status, bytes: Number.isFinite(linked) && linked > 0 ? linked : (Number.isFinite(len) && len > 0 ? len : null), finalUrl: res.url || url };
    await drop(res);
  } catch (e) {
    head = { error: errText(e) };
  } finally { t1.done(); }
  if (o.headOnly || (head.status >= 200 && head.status < 300 && head.bytes != null) || head.status === 404 || head.status === 410) return head;
  const t2 = timeoutSignal(ms);
  try {
    const res = await f(url, { method: 'GET', redirect: 'follow', headers: Object.assign({ Range: 'bytes=0-0' }, headers), signal: t2.signal });
    const cr = parseContentRange(res.headers && res.headers.get && res.headers.get('content-range'));
    const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    const out = { status: res.status === 206 ? 200 : res.status, bytes: cr != null ? cr : (res.status === 200 && Number.isFinite(len) && len > 0 ? len : (head.bytes || null)), finalUrl: res.url || url, ranged: res.status === 206 };
    await drop(res);
    return out;
  } catch (e) {
    return head.status ? head : { error: errText(e) };
  } finally { t2.done(); }
}

async function getJson(url, opts) {
  const o = opts || {};
  const f = o.fetch || fetch;
  const t = timeoutSignal(o.timeoutMs || 20000);
  try {
    const res = await f(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, o.headers || {}), signal: t.signal });
    if (!res.ok) { await drop(res); return { status: res.status }; }
    try { return { status: res.status, json: await res.json() }; } catch (_) { return { status: res.status, badJson: true }; }
  } catch (e) { return { error: errText(e) }; } finally { t.done(); }
}

/** fetch wrapper that remembers the last answer's status / error (for the catalog checks). */
function recordingFetch(f) {
  const net = { status: null, error: null };
  const wrapped = async (url, init) => {
    net.status = null; net.error = null;
    const headers = Object.assign({ 'User-Agent': UA }, (init && init.headers) || {});
    try { const r = await f(url, Object.assign({}, init, { headers })); net.status = r.status; return r; } catch (e) { net.error = errText(e); throw e; }
  };
  return { fetch: wrapped, net };
}

// ------------------------------------------------------------------ the checks
/** Every check, built from the app's own modules. → [{ group, name, url?, info?, run(ctx) → {status, reason} }] */
function buildChecks(mods) {
  const m = mods || loadModules();
  const checks = [];
  const add = (c) => checks.push(c);
  const fileCheck = (group, name, url, expect, extra) => add(Object.assign({ group, name, url, run: async (ctx) => classify(await probe(url, ctx), expect) }, extra || {}));

  // 1. Model finder (model-catalog.js) — the part that broke once already.
  const catalogCheck = (name, url, call, verdict) => add({
    group: 'model finder', name, url,
    run: async (ctx) => {
      const rec = recordingFetch(ctx.fetch || fetch);
      const cat = m.catalog.createCatalog({ fetch: rec.fetch, timeoutMs: ctx.timeoutMs, hfToken: ctx.hfToken || '' });
      let r;
      try { r = await call(cat); } catch (e) { return { status: 'CHANGED', reason: `the catalog threw: ${errText(e)}` }; }
      return verdict(r, rec.net);
    },
  });
  catalogCheck('Ollama search "qwen" (searchOllama)', 'https://ollama.com/search?q=qwen', (c) => c.searchOllama('qwen'), (r, n) => ollamaVerdict(r, n, 5));
  catalogCheck('Ollama search "qwen" tools-only', 'https://ollama.com/search?q=qwen&c=tools', (c) => c.searchOllama('qwen', { toolsOnly: true }), (r, n) => ollamaVerdict(r, n, 3));
  catalogCheck('Hugging Face search "qwen gguf" (searchHf)', 'https://huggingface.co/api/models?search=qwen%20gguf&filter=gguf', (c) => c.searchHf('qwen gguf'), (r, n) => {
    // "qwen gguf" as one phrase may match few repos; fall back is not the app's
    // behaviour, so judge exactly what the app gets.
    return hfSearchVerdict(r, n, 3);
  });
  catalogCheck('Hugging Face search "qwen" (searchHf)', 'https://huggingface.co/api/models?search=qwen&filter=gguf', (c) => c.searchHf('qwen'), (r, n) => hfSearchVerdict(r, n, 5));
  const repo = 'bartowski/Qwen2.5-7B-Instruct-GGUF';
  catalogCheck(`GGUF file list ${repo} (hfFiles)`, `https://huggingface.co/api/models/${repo}?blobs=true`, (c) => c.hfFiles(repo), (r, n) => hfFilesVerdict(r, n, 3));

  // 2. Ollama installers (llm-setup.js installOllama).
  const ob = m.llmSetup.DOWNLOAD_BASE.replace(/\/+$/, '');
  fileCheck('ollama installer', 'Windows OllamaSetup.exe', `${ob}/OllamaSetup.exe`, { minBytes: 50 * 1024 * 1024 });
  fileCheck('ollama installer', 'macOS Ollama-darwin.zip', `${ob}/Ollama-darwin.zip`, { minBytes: 20 * 1024 * 1024 });
  for (const arch of ['amd64', 'arm64']) {
    // The app tries .tgz first, then .tar.zst (llm-setup.js) — one must work.
    const alts = [`ollama-linux-${arch}.tgz`, `ollama-linux-${arch}.tar.zst`];
    add({
      group: 'ollama installer', name: `Linux ${arch} (.tgz or .tar.zst)`, url: `${ob}/${alts[1]}`,
      run: async (ctx) => {
        const rs = [];
        for (const a of alts) rs.push(Object.assign({ label: a.replace(/^ollama-linux-[a-z0-9]+/, '') }, classify(await probe(`${ob}/${a}`, ctx), { minBytes: 20 * 1024 * 1024 })));
        return anyOf(rs);
      },
    });
  }

  // 3. ComfyUI portable + starter checkpoints (sd-installer.js).
  const si = m.sdInstaller;
  const assets = Object.values(si.BUILDS).map((b) => b.asset);
  add({
    group: 'comfyui', name: 'GitHub latest release lists every portable build', url: si.GITHUB_API, info: true, // the app falls back to the direct links checked below
    run: async (ctx) => {
      const headers = ctx.githubToken ? { Authorization: `Bearer ${ctx.githubToken}` } : {};
      let r = await getJson(si.GITHUB_API, Object.assign({}, ctx, { headers }));
      // A token GitHub doesn't accept here → try the way the app does (no token).
      if (r.status === 401 && ctx.githubToken) r = await getJson(si.GITHUB_API, ctx);
      if (r.error) return { status: 'UNREACHABLE', reason: `no answer (${r.error})` };
      if (r.status === 401 || r.status === 403 || r.status === 429) return { status: 'UNREACHABLE', reason: `HTTP ${r.status}: GitHub refused the API call (rate limit or token) — the app falls back to the direct download links` };
      if (r.status !== 200 || r.badJson) return classify({ status: r.badJson ? 0 : r.status }, {});
      return releaseVerdict(r.json, assets);
    },
  });
  for (const [id, b] of Object.entries(si.BUILDS)) {
    fileCheck('comfyui', `portable build ${id} (${b.asset})`, si.DOWNLOAD_BASE + b.asset, { minBytes: Math.round(b.approxBytes * 0.3) });
  }
  for (const s of Object.values(si.STARTER_MODELS)) {
    fileCheck('sd checkpoint', `${s.id}: ${s.file}`, s.url, { minBytes: Math.round(s.approxBytes * 0.8) });
  }

  // 4. Video models (video-installer.js) — exact byte sizes; the app checks them.
  const seen = new Set();
  for (const mod of Object.values(m.videoInstaller.MODELS)) {
    for (const f of mod.files) {
      if (seen.has(f.url)) continue; seen.add(f.url);
      fileCheck('video model', `${f.kind}/${f.name}`, f.url, { bytes: f.bytes });
    }
  }

  // 5. Setup manager downloads / hand-offs (setup-manager.js).
  for (const t of Object.values(m.setupManager.TARGETS || {})) {
    for (const f of (t.files || [])) if (/^https:/.test(f.url || '')) fileCheck('setup download', `${t.id}: ${f.name}`, f.url, { minBytes: f.minBytes });
    if (t.kind === 'handoff' && /^https:/.test(t.url || '')) fileCheck('setup hand-off page', t.id, t.url, {});
  }
  fileCheck('setup hand-off page', 'Ollama download page', `${ob}`, {});
  fileCheck('setup hand-off page', 'python.org downloads', 'https://www.python.org/downloads/', {});

  // 6. Info only: the browser panes (their page layout needs a login to check —
  // see test:browser) and the optional RunPod pod API (needs a key; 401 = alive).
  for (const [key, s] of Object.entries(m.selectors || {})) {
    if (s && /^https:/.test(s.home || '')) fileCheck('browser pane', `${s.label || key} home page`, s.home, { site: true }, { info: true });
  }
  if (m.runpodBase) fileCheck('optional API', 'RunPod REST API answers (401 without a key is fine)', `${m.runpodBase}/pods`, { site: true }, { info: true });
  return checks;
}

function loadModules() {
  const req = (n) => require(path.join(APP, n));
  let runpodBase = null;
  try { runpodBase = (/RUNPOD_API_BASE\s*=\s*["']([^"']+)["']/.exec(require('fs').readFileSync(path.join(APP, 'manager-provider.js'), 'utf8')) || [])[1] || null; } catch (_) {}
  return {
    catalog: req('model-catalog'), llmSetup: req('llm-setup'), sdInstaller: req('sd-installer'),
    videoInstaller: req('video-installer'), setupManager: req('setup-manager'), selectors: req('selectors'), runpodBase,
  };
}

/** Run checks (a few at a time), retrying a failed one once. Never throws. */
async function runChecks(checks, ctx, onResult) {
  const c = Object.assign({ timeoutMs: 20000, retries: 1, concurrency: 4, retryDelayMs: 2000 }, ctx || {});
  const results = new Array(checks.length);
  let next = 0;
  async function one(i) {
    const ch = checks[i];
    const started = Date.now();
    let v = null; let tries = 0;
    for (; tries <= c.retries; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, c.retryDelayMs));
      try { v = await ch.run(c); } catch (e) { v = { status: 'UNREACHABLE', reason: `check crashed: ${errText(e)}` }; }
      if (!v || !v.status) v = { status: 'UNREACHABLE', reason: 'check gave no answer' };
      if (v.status === 'ok') break;
    }
    const r = { group: ch.group, name: ch.name, url: ch.url || null, info: !!ch.info, status: v.status, reason: v.reason, tries: Math.min(tries + 1, c.retries + 1), ms: Date.now() - started };
    results[i] = r;
    if (onResult) try { onResult(r); } catch (_) {}
  }
  const workers = Array.from({ length: Math.max(1, Math.min(c.concurrency, checks.length)) }, async () => {
    while (next < checks.length) { const i = next++; await one(i); }
  });
  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const a = { markdown: null, json: null, only: null, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--markdown') a.markdown = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--timeout') a.timeoutMs = Number(argv[++i]) || a.timeoutMs;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: node scripts/live-check.js [--markdown out.md] [--json out.json] [--only <group text>] [--timeout ms]'); return 0; }
  let checks = buildChecks();
  if (args.only) checks = checks.filter((c) => `${c.group} ${c.name}`.toLowerCase().includes(args.only.toLowerCase()));
  console.log(`Live check: ${checks.length} outside sites/files the app depends on…\n`);
  const results = await runChecks(checks, {
    timeoutMs: args.timeoutMs, githubToken: process.env.GITHUB_TOKEN || '', hfToken: process.env.HF_TOKEN || '',
  }, (r) => console.log(`  ${r.status.padEnd(11)} ${r.group} / ${r.name}`));
  console.log(`\n${formatTable(results)}`);
  const fs = require('fs');
  const when = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (args.markdown) fs.writeFileSync(args.markdown, `${formatMarkdown(results, { when })}\n`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ when, results }, null, 2));
  const code = exitCode(results);
  console.log(code === 0 ? '\nAll required checks passed.' : code === 1 ? '\nSomething CHANGED — the app needs a fix (see the reasons above).' : '\nSome sites could not be reached (may be temporary).');
  return code;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`live-check crashed: ${e && e.stack || e}`); process.exitCode = 3; });
}

module.exports = {
  parseContentRange, fmtBytes, classify, ollamaVerdict, hfSearchVerdict, hfFilesVerdict, releaseVerdict, anyOf,
  exitCode, summary, formatTable, formatMarkdown, probe, getJson, recordingFetch, buildChecks, loadModules, runChecks, parseArgs,
};
