// test/live-check.test.js — the pure parts of scripts/live-check.js (verdicts,
// size parsing, the tables, the exit code) and its probe / retry / catalog
// plumbing against a fake fetch. No network. Run: node test/live-check.test.js
const fs = require('fs');
const path = require('path');
const lc = require('../scripts/live-check');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'llm', f), 'utf8');

function res(status, body, headers, url) {
  const h = Object.assign({}, headers || {});
  return {
    ok: status >= 200 && status < 300, status, url: url || '',
    headers: { get: (k) => (h[k.toLowerCase()] != null ? String(h[k.toLowerCase()]) : null) },
    text: async () => String(body == null ? '' : body), json: async () => JSON.parse(body), body: null,
  };
}
function fakeFetch(routes, calls) {
  return async (url, init) => {
    if (calls) calls.push({ url, init });
    for (const [re, fn] of routes) if (re.test(url)) { const r = fn(url, init || {}); if (r instanceof Error) throw r; return r; }
    const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e;
  };
}

(async () => {
  console.log('parseContentRange / fmtBytes');
  assert(lc.parseContentRange('bytes 0-0/12345') === 12345, 'reads the total from Content-Range');
  assert(lc.parseContentRange('bytes */99') === 99, 'reads an unsatisfied-range total');
  assert(lc.parseContentRange(null) === null && lc.parseContentRange('bytes 0-0/*') === null, 'unknown total → null');
  assert(lc.fmtBytes(1536) === '1.5 KB' && lc.fmtBytes(2 * 1024 ** 3) === '2.00 GB', 'fmtBytes');

  console.log('classify');
  assert(lc.classify({ status: 200, bytes: 10 }, {}).status === 'ok', '200 → ok');
  assert(lc.classify({ error: 'timed out' }, {}).status === 'UNREACHABLE', 'network error → UNREACHABLE');
  assert(lc.classify({ status: 404 }, {}).status === 'CHANGED', '404 → CHANGED');
  assert(lc.classify({ status: 410 }, { site: true }).status === 'CHANGED', '410 on a browser site → CHANGED');
  assert(lc.classify({ status: 503 }, {}).status === 'UNREACHABLE', '503 → UNREACHABLE');
  assert(lc.classify({ status: 429 }, {}).status === 'UNREACHABLE', '429 → UNREACHABLE');
  assert(lc.classify({ status: 403 }, {}).status === 'CHANGED', '403 on a file → CHANGED (now gated)');
  assert(lc.classify({ status: 403 }, { site: true }).status === 'ok', '403 from a bot-protected site → ok');
  assert(lc.classify({ status: 401 }, { site: true }).status === 'ok', '401 from a keyed API → ok (alive)');
  const sz = lc.classify({ status: 200, bytes: 100 }, { bytes: 101 });
  assert(sz.status === 'CHANGED' && /101/.test(sz.reason), 'exact size mismatch → CHANGED with both sizes');
  assert(lc.classify({ status: 200, bytes: 101 }, { bytes: 101 }).status === 'ok', 'exact size match → ok');
  assert(lc.classify({ status: 200, bytes: null }, { bytes: 101 }).status === 'ok', 'size not reported → ok (not a breakage)');
  assert(lc.classify({ status: 200, bytes: 5 }, { minBytes: 10 }).status === 'CHANGED', 'below minBytes → CHANGED');
  assert(lc.classify({ status: 302 }, {}).status === 'CHANGED', 'unfollowed 3xx → CHANGED');

  console.log('catalog verdicts');
  const mc = require('../model-catalog');
  const cat = mc.createCatalog({ fetch: fakeFetch([[/ollama\.com\/search/, () => res(200, fx('ollama-search-2026.html'))]]) });
  const good = await cat.searchOllama('qwen');
  const v = lc.ollamaVerdict(good, { status: 200 }, 2);
  assert(v.status === 'ok', `real 2026 fixture page (2 models) → ok with min 2 (${v.reason})`);
  assert(lc.ollamaVerdict({ ok: true, models: [] }, { status: 200 }, 5).status === 'CHANGED', 'zero models on a 200 → CHANGED');
  const noSizes = { ok: true, models: Array.from({ length: 6 }, (_, i) => ({ name: `m${i}`, tools: true, variants: [{ params: null }] })) };
  assert(/size/.test(lc.ollamaVerdict(noSizes, { status: 200 }).reason) && lc.ollamaVerdict(noSizes, { status: 200 }).status === 'CHANGED', 'models without sizes → CHANGED (sizes moved)');
  const noCaps = { ok: true, models: Array.from({ length: 6 }, (_, i) => ({ name: `m${i}`, variants: [{ params: 7 }] })) };
  assert(/capabilit/.test(lc.ollamaVerdict(noCaps, { status: 200 }).reason), 'models without capabilities → CHANGED (labels moved)');
  assert(lc.ollamaVerdict({ ok: false, models: [] }, { error: 'ENOTFOUND' }).status === 'UNREACHABLE', 'network error → UNREACHABLE');
  assert(lc.ollamaVerdict({ ok: false, models: [] }, { status: 404 }).status === 'CHANGED', 'search page 404 → CHANGED');
  assert(lc.ollamaVerdict({ ok: false, models: [] }, { status: 502 }).status === 'UNREACHABLE', 'search page 502 → UNREACHABLE');

  const hcat = mc.createCatalog({ fetch: fakeFetch([
    [/api\/models\?/, () => res(200, fx('hf-search.json'))],
    [/api\/models\/[^?]+\?blobs/, () => res(200, fx('hf-model-qwen.json'))],
  ]) });
  const hs = await hcat.searchHf('qwen');
  assert(lc.hfSearchVerdict(hs, { status: 200 }, 1).status === 'ok', 'HF search fixture → ok');
  assert(lc.hfSearchVerdict({ ok: true, models: [] }, { status: 200 }, 3).status === 'CHANGED', 'HF search with no models → CHANGED');
  const hf = await hcat.hfFiles('bartowski/Qwen2.5-7B-Instruct-GGUF');
  const hv = lc.hfFilesVerdict(hf, { status: 200 }, 2);
  assert(hv.status === 'ok', `HF file list fixture → ok (${hv.reason})`);
  assert(lc.hfFilesVerdict({ ok: true, variants: [{ sizeBytes: 1 }, { sizeBytes: 0 }, { sizeBytes: 3 }] }, { status: 200 }).status === 'CHANGED', 'variants without sizes → CHANGED');
  assert(lc.hfFilesVerdict({ ok: false, variants: [] }, { status: 401 }).status === 'CHANGED', 'file list now gated → CHANGED');

  console.log('releaseVerdict / anyOf');
  assert(lc.releaseVerdict({ tag_name: 'v1', assets: [{ name: 'a.7z' }, { name: 'b.7z' }] }, ['a.7z', 'b.7z']).status === 'ok', 'all assets → ok');
  const miss = lc.releaseVerdict({ tag_name: 'v2', assets: [{ name: 'a.7z' }] }, ['a.7z', 'b.7z']);
  assert(miss.status === 'CHANGED' && /b\.7z/.test(miss.reason), 'missing asset named → CHANGED');
  assert(lc.releaseVerdict({}, ['a']).status === 'CHANGED', 'no assets list → CHANGED');
  assert(lc.anyOf([{ label: '.tgz', status: 'CHANGED', reason: '404' }, { label: '.tar.zst', status: 'ok', reason: 'HTTP 200' }]).status === 'ok', 'one alternative ok → ok');
  assert(lc.anyOf([{ label: 'a', status: 'CHANGED' }, { label: 'b', status: 'CHANGED' }]).status === 'CHANGED', 'all alternatives gone → CHANGED');
  assert(lc.anyOf([{ label: 'a', status: 'CHANGED' }, { label: 'b', status: 'UNREACHABLE' }]).status === 'UNREACHABLE', 'mixed → UNREACHABLE');

  console.log('exitCode / tables');
  const R = (status, info) => ({ group: 'g', name: `n ${status}`, status, reason: 'r | pipe', info: !!info, url: 'https://x' });
  assert(lc.exitCode([R('ok'), R('ok')]) === 0, 'all ok → 0');
  assert(lc.exitCode([R('ok'), R('CHANGED')]) === 1, 'CHANGED → 1');
  assert(lc.exitCode([R('ok'), R('UNREACHABLE')]) === 2, 'only UNREACHABLE → 2');
  assert(lc.exitCode([R('UNREACHABLE'), R('CHANGED')]) === 1, 'CHANGED wins over UNREACHABLE');
  assert(lc.exitCode([R('ok'), R('CHANGED', true), R('UNREACHABLE', true)]) === 0, 'info checks never fail the run');
  const t = lc.formatTable([R('ok'), R('CHANGED'), R('UNREACHABLE', true)]);
  assert(/RESULT\s+GROUP\s+CHECK\s+REASON/.test(t) && /UNREACHABLE \(info\)/.test(t) && /3 checks: 1 ok, 1 CHANGED, 1 UNREACHABLE/.test(t), 'text table has header, info marker and summary');
  const md = lc.formatMarkdown([R('ok'), R('CHANGED')], { when: '2026-10-27T06:17:00Z' });
  const rows = md.split('\n').filter((l) => l.startsWith('| '));
  assert(/\*\*CHANGED\*\*/.test(rows[1]) && /\| ok \|/.test(rows[2]), 'markdown puts problems first');
  assert(/r \\\| pipe/.test(md) && /2026-10-27/.test(md), 'markdown escapes pipes and shows the time');

  console.log('probe (fake fetch)');
  let calls = [];
  let p = await lc.probe('https://f/a.bin', { fetch: fakeFetch([[/a\.bin/, (u, i) => (i.method === 'HEAD' ? res(200, '', { 'content-length': 1234 }) : new Error('no GET expected'))]], calls) });
  assert(p.status === 200 && p.bytes === 1234 && calls.length === 1, 'HEAD with a length → no GET');
  calls = [];
  p = await lc.probe('https://f/b.bin', { fetch: fakeFetch([[/b\.bin/, (u, i) => (i.method === 'HEAD' ? res(405) : res(206, 'x', { 'content-range': 'bytes 0-0/999' }))]], calls) });
  assert(p.status === 200 && p.bytes === 999 && calls[1].init.headers.Range === 'bytes=0-0', 'HEAD refused → 1-byte ranged GET, size from Content-Range');
  p = await lc.probe('https://f/c.bin', { fetch: fakeFetch([[/c\.bin/, () => res(404)]]) });
  assert(p.status === 404, '404 on HEAD is final');
  p = await lc.probe('https://nowhere/x', { fetch: fakeFetch([]) });
  assert(p.error && /ENOTFOUND/.test(p.error), 'network failure → error text, no throw');
  p = await lc.probe('https://f/slow', { timeoutMs: 30, fetch: (u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) });
  assert(p.error && /timed out/.test(p.error), 'timeout → "timed out"');

  console.log('runChecks (retry once, never throws)');
  let n = 0;
  const checks = [
    { group: 'g', name: 'flaky', run: async () => (++n === 1 ? { status: 'UNREACHABLE', reason: 'x' } : { status: 'ok', reason: 'y' }) },
    { group: 'g', name: 'crash', run: async () => { throw new Error('boom'); } },
    { group: 'g', name: 'empty', info: true, run: async () => null },
  ];
  const out = await lc.runChecks(checks, { retryDelayMs: 1 });
  assert(out[0].status === 'ok' && out[0].tries === 2, 'a failed check is retried once and can recover');
  assert(out[1].status === 'UNREACHABLE' && /boom/.test(out[1].reason) && out[1].tries === 2, 'a crashing check becomes UNREACHABLE');
  assert(out[2].status === 'UNREACHABLE' && out[2].info, 'no answer → UNREACHABLE, info flag kept');

  console.log('buildChecks (reads URLs from the app modules)');
  const all = lc.buildChecks();
  const urls = all.map((c) => c.url || '');
  const vi = require('../video-installer');
  const si = require('../sd-installer');
  assert(all.every((c) => c.group && c.name && typeof c.run === 'function'), `${all.length} checks, all well-formed`);
  assert(urls.some((u) => /ollama\.com\/search\?q=qwen/.test(u)) && urls.some((u) => /bartowski\/Qwen2\.5-7B-Instruct-GGUF/.test(u)), 'model finder checks present');
  assert(urls.some((u) => /OllamaSetup\.exe$/.test(u)) && urls.some((u) => /Ollama-darwin\.zip$/.test(u)) && all.some((c) => /Linux arm64/.test(c.name)), 'Ollama installers for Windows, macOS, Linux amd64/arm64');
  const vurls = new Set(Object.values(vi.MODELS).flatMap((m) => m.files.map((f) => f.url)));
  assert([...vurls].every((u) => urls.includes(u)), `every video model file checked (${vurls.size})`);
  assert(Object.values(si.STARTER_MODELS).every((s) => urls.includes(s.url)) && Object.values(si.BUILDS).every((b) => urls.includes(si.DOWNLOAD_BASE + b.asset)) && urls.includes(si.GITHUB_API), 'every ComfyUI build, the release API and starter checkpoints checked');
  assert(new Set(urls.filter(Boolean).map((u) => `${u}`)).size >= all.filter((c) => c.url).length - 1, 'no accidental duplicate checks');
  assert(all.filter((c) => c.info).every((c) => /browser pane|optional API/.test(c.group) || /GitHub latest release/.test(c.name)), 'only browser panes, optional APIs and the release API (app has a fallback) are info-only');

  // A full fake run: a catalog check through the recording fetch.
  const ol = all.find((c) => /searchOllama\)/.test(c.name));
  const okRun = await ol.run({ fetch: fakeFetch([[/ollama\.com\/search/, () => res(200, fx('ollama-search-2026.html'))]]), timeoutMs: 2000 });
  assert(okRun.status === 'ok' || /only \d+ model/.test(okRun.reason), `catalog check runs end to end on the fixture (${okRun.status}: ${okRun.reason})`);
  const chRun = await ol.run({ fetch: fakeFetch([[/ollama\.com\/search/, () => res(200, '<html><ul><li><div>new layout</div></li></ul></html>')]]), timeoutMs: 2000 });
  assert(chRun.status === 'CHANGED', 'a new page layout → CHANGED');
  const unRun = await ol.run({ fetch: fakeFetch([]), timeoutMs: 2000 });
  assert(unRun.status === 'UNREACHABLE', 'offline → UNREACHABLE');

  console.log('parseArgs');
  const a = lc.parseArgs(['--markdown', 'o.md', '--json', 'o.json', '--only', 'video', '--timeout', '5000']);
  assert(a.markdown === 'o.md' && a.json === 'o.json' && a.only === 'video' && a.timeoutMs === 5000, 'flags parsed');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
