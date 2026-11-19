// test/openai-image.test.js — 💳 OpenAI's paid image service as the third picture engine:
//   * openai-image.js with a fake OpenAI: off / no key / ready; a picture is saved with its record; the monthly limit
//     stops it (and warns near the end); OpenAI's errors in plain words (bad key, no credit, refused, unknown model,
//     busy, down, no internet, too slow); one at a time; ✔ Check key reads the model list; the key never appears in a
//     log line or an answer
//   * sd-studio.js: engine "openai"; "auto" picks it ONLY for book pictures and only when "Use OpenAI for book
//     pictures" is ticked; not ready → a plain error; maps and shapes; Remake of an OpenAI picture; backendInfo
//   * the 🎨 Images tab (jsdom): the Engine list has it; the ⚙ OpenAI pictures box saves settings and the key (then
//     empties the field), ✔ Check key, the engine note, a picture request goes as engine "openai"
//   * the wiring: IPC, preload, the key sealed in the saved state, Alfred can't change it, packaged
// Run with: node test/openai-image.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const OI = require('../openai-image');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DIR = path.join(__dirname, '..');
const KEY = 'sk-test-THIS-IS-A-SECRET-KEY-1234567890abcdef';
// a tiny real PNG (1×1)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeOpenAi() {
  const calls = [];
  let next = null; // { status, body } | 'throw' | 'abort'
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const n = next; next = null;
    if (n === 'throw') throw new Error('getaddrinfo ENOTFOUND api.openai.com');
    if (n === 'abort') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
    if (n) return { ok: n.status < 300, status: n.status, json: async () => n.body, arrayBuffer: async () => Buffer.from(PNG_B64, 'base64') };
    if (!/api\.openai\.com/.test(url)) return { ok: true, status: 200, json: async () => null, arrayBuffer: async () => Buffer.from(PNG_B64, 'base64') };
    if (/\/models$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_B64, revised_prompt: 'a lighthouse at dawn, painterly' }] }) };
  };
  return { fetch, calls, failNext: (v) => { next = v; } };
}

function makeEngine(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-'));
  const api = fakeOpenAi();
  const st = Object.assign({ enabled: true, model: 'gpt-image-1', quality: 'medium', monthlyLimit: 30, forBooks: false }, over.settings || {});
  let usage = over.usage || { month: '', count: 0 };
  let key = over.key === undefined ? KEY : over.key;
  const logs = [];
  const recorded = [];
  let t = Date.UTC(2026, 10, 19, 12);
  const eng = OI.createOpenAiImage({
    fetch: api.fetch, key: () => key, settings: () => st, usage: () => usage, addUse: (n, month) => { usage = { month, count: (usage.month === month ? usage.count : 0) + n }; },
    imagesDir: () => path.join(tmp, 'images'), recordImage: (e) => recorded.push(e), log: (k, d) => logs.push([k, d]), fileUrl: (p) => `file://${p}`, now: () => t,
  });
  return { eng, api, st, tmp, logs, recorded, setKey: (k) => { key = k; }, usage: () => usage, setUsage: (u) => { usage = u; }, advance: (ms) => { t += ms; } };
}

(async () => {
  console.log('== openai-image.js ==');
  const cs = OI.cleanSettings({ model: 'bad model!', quality: 'ultra', monthlyLimit: 99999, enabled: 'yes' });
  assert(cs.model === 'gpt-image-1' && cs.quality === 'medium' && cs.monthlyLimit === 1000 && cs.enabled === false && cs.forBooks === false, 'settings cleaned: a sane model, quality, limit; on only with a real true');
  assert(OI.cleanSettings({ model: 'gpt-image-2.6' }).model === 'gpt-image-2.6', 'any newer model name can be typed in');
  assert(OI.sizeFor('cover') === '1024x1536' && OI.sizeFor('map') === '1536x1024' && OI.sizeFor('free') === '1024x1024' && OI.sizeFor('cover', { width: 16, height: 9 }) === '1536x1024', 'sizes: tall covers/portraits, wide scenes/maps, square otherwise; a shape wins');
  assert(OI.monthOf(Date.UTC(2026, 10, 19)) === '2026-11', 'the month the limit counts');

  let E = makeEngine({ settings: { enabled: false } });
  let r = await E.eng.generate({ text: 'a lighthouse' });
  assert(!r.ok && r.error === 'OPENAI_OFF' && E.api.calls.length === 0, 'off → nothing is sent, nothing is paid');
  E = makeEngine({ key: '' });
  r = await E.eng.generate({ text: 'a lighthouse' });
  assert(!r.ok && r.error === 'NO_KEY' && /key/.test(r.hint) && E.api.calls.length === 0, 'no key → says where to put it');
  assert(!E.eng.readiness().ready && E.eng.status().hasKey === false, 'status: not ready, no key');

  E = makeEngine();
  r = await E.eng.generate({ text: 'A lighthouse at dawn', purpose: 'cover', record: { prompt: 'lighthouse', book: 'The Salt Tuner' }, from: 'bridge:akowe', returnImage: true });
  const sent = E.api.calls[0];
  assert(r.ok && r.engine === 'openai' && r.images.length === 1 && fs.existsSync(r.images[0].path), 'a picture is made and saved');
  assert(/\/v1\/images\/generations$/.test(sent.url) && sent.body.model === 'gpt-image-1' && sent.body.size === '1024x1536' && sent.body.quality === 'medium' && sent.body.n === 1 && sent.init.headers.Authorization === `Bearer ${KEY}`, 'the request: model, a tall size for a cover, quality, one picture, the key in the header');
  const rec = JSON.parse(fs.readFileSync(r.images[0].path.replace(/\.png$/, '.json'), 'utf8'));
  assert(rec.engine === 'openai' && rec.model === 'gpt-image-1' && rec.book === 'The Salt Tuner' && rec.revisedPrompt && rec.from === 'bridge:akowe' && !JSON.stringify(rec).includes(KEY), 'the picture\'s record: engine, model, book, OpenAI\'s own wording — never the key');
  assert(E.recorded[0].model === 'openai:gpt-image-1' && r.images[0].imageBase64 === PNG_B64, 'recorded in the picture list; returnImage passes the bytes');
  assert(E.usage().count === 1 && E.usage().month === '2026-11' && E.eng.status().usedThisMonth === 1, 'the month\'s count goes up');
  // the limit
  E = makeEngine({ settings: { monthlyLimit: 3 }, usage: { month: '2026-11', count: 1 } });
  r = await E.eng.generate({ text: 'x' });
  assert(r.ok && r.warnings.some((w) => /1 OpenAI picture left/.test(w.message)), 'near the limit → "1 picture left this month"');
  r = await E.eng.generate({ text: 'y' });
  assert(r.ok && r.warnings.some((w) => /last OpenAI picture/.test(w.message)), 'the last one → says so');
  r = await E.eng.generate({ text: 'z' });
  assert(!r.ok && r.error === 'OPENAI_MONTHLY_LIMIT' && /Raise the monthly limit/.test(r.hint) && E.api.calls.length === 2, 'at the limit → stops, nothing sent');
  E.setUsage({ month: '2026-10', count: 3 });
  assert(E.eng.readiness().ready, 'a new month starts at zero');
  // errors
  const errs = [
    [{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }, 'OPENAI_BAD_KEY'],
    [{ status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } }, 'OPENAI_NO_CREDIT'],
    [{ status: 429, body: { error: { message: 'Rate limit reached' } } }, 'OPENAI_BUSY'],
    [{ status: 400, body: { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system' } } }, 'IMAGE_REFUSED'],
    [{ status: 404, body: { error: { code: 'model_not_found' } } }, 'OPENAI_NO_MODEL'],
    [{ status: 403, body: { error: { message: 'organization must be verified' } } }, 'OPENAI_NOT_ALLOWED'],
    [{ status: 503, body: null }, 'OPENAI_DOWN'],
    ['throw', 'OPENAI_UNREACHABLE'],
    ['abort', 'IMAGE_TIMEOUT'],
  ];
  E = makeEngine();
  for (const [what, code] of errs) {
    E.api.failNext(what);
    r = await E.eng.generate({ text: 'x' });
    assert(!r.ok && r.error === code && r.message && r.hint && !JSON.stringify(r).includes(KEY), `OpenAI ${typeof what === 'string' ? what : what.status} → ${code}, in plain words, no key in it`);
  }
  assert(E.usage().count === 0, 'a failed picture is not counted');
  E.api.failNext({ status: 200, body: { data: [{ url: 'https://files.example/x.png' }] } });
  r = await E.eng.generate({ text: 'url answer' });
  assert(r.ok && fs.existsSync(r.images[0].path), 'an answer with a link instead of the bytes is fetched and saved');
  E.api.failNext({ status: 200, body: { data: [] } });
  assert((await E.eng.generate({ text: 'empty' })).error === 'IMAGE_FETCH_FAILED', 'an answer without a picture → says so');
  // one at a time
  const p1 = E.eng.generate({ text: 'first' });
  r = await E.eng.generate({ text: 'second' });
  await p1;
  assert(!r.ok && r.error === 'BUSY', 'one picture at a time');
  // check key
  r = await E.eng.checkKey();
  assert(r.ok && r.modelOk && /gpt-image-1 is available/.test(r.message) && r.models.join() === 'dall-e-3,gpt-image-1', '✔ Check key: reads the model list (free) and says the model is there');
  assert(/\/v1\/models$/.test(E.api.calls[E.api.calls.length - 1].url), '…by reading /models, never by making a picture');
  E.api.failNext({ status: 401, body: { error: { message: 'bad' } } });
  assert((await E.eng.checkKey()).error === 'OPENAI_BAD_KEY', '✔ Check key with a bad key → says so');
  E.setKey('');
  assert((await E.eng.checkKey()).error === 'NO_KEY', '✔ Check key with no key → "paste it first"');
  assert(!JSON.stringify(E.logs).includes(KEY) && !JSON.stringify(E.logs).includes('A lighthouse'), 'the log never holds the key (or the picture\'s words)');

  console.log('== sd-studio.js: engine "openai" and Auto ==');
  {
    const { createSdStudio } = require('../sd-studio');
    const ip = require('../image-provider');
    ip.setSettings({ enabled: false, endpoint: '' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-studio-'));
    const cgJobs = [];
    const chatgpt = { status: () => ({ ok: true, ready: true, busy: false }), readiness: () => ({ ready: true, code: 'OK' }),
      generate: async (job) => { cgJobs.push(job); return { ok: true, engine: 'chatgpt', backend: 'chatgpt', images: [{ path: path.join(tmp, 'cg.png') }], settings: {} }; } };
    const Eo = makeEngine();
    const studio = createSdStudio({ imageProvider: ip, library: null, imagesDir: () => path.join(tmp, 'images'), chatgpt, openai: Eo.eng, fileUrl: (p) => `file://${p}`, log: () => {} });
    r = await studio.request({ prompt: 'a storm over the harbour', engine: 'openai', purpose: 'scene' });
    assert(r.ok && r.engine === 'openai' && r.paths.length === 1 && Eo.api.calls.pop().body.size === '1536x1024', 'engine "openai" → OpenAI draws it (wide for a scene)');
    r = await studio.request({ prompt: 'the coast', engine: 'openai', purpose: 'map' });
    assert(r.ok && /top-down cartography/.test(Eo.api.calls.pop().body.prompt), 'a map gets the map words');
    r = await studio.request({ prompt: 'Mara', purpose: 'cover', from: 'akowe' });
    assert(r.ok && r.engine === 'chatgpt', 'Auto + a book picture, but "Use OpenAI for book pictures" is off → not OpenAI');
    Eo.st.forBooks = true;
    r = await studio.request({ prompt: 'Mara', purpose: 'cover', from: 'akowe' });
    assert(r.ok && r.engine === 'openai', 'Auto + a book picture + "Use OpenAI for book pictures" → OpenAI');
    r = await studio.requestFrom({ prompt: 'a cat', purpose: 'free' }, 'images-tab');
    assert(r.ok && r.engine === 'chatgpt', 'Auto + not a book picture → never OpenAI by surprise');
    Eo.st.enabled = false;
    r = await studio.request({ prompt: 'Mara', purpose: 'cover', from: 'akowe' });
    assert(r.ok && r.engine === 'chatgpt', 'OpenAI turned off → the book picture goes to the other engines');
    r = await studio.request({ prompt: 'x', engine: 'openai' });
    assert(!r.ok && r.error === 'OPENAI_NOT_READY' && /⚙ OpenAI pictures/.test(r.hint), 'engine "openai" when it is off → a plain error with where to fix it');
    Eo.st.enabled = true;
    Eo.setUsage({ month: '2026-11', count: 30 });
    r = await studio.request({ prompt: 'x', engine: 'openai' });
    assert(!r.ok && r.error === 'OPENAI_MONTHLY_LIMIT', 'at the monthly limit → OPENAI_MONTHLY_LIMIT');
    Eo.setUsage({ month: '2026-11', count: 0 });
    const bi = studio.backendInfo();
    assert(bi.engines.openai && bi.engines.openai.ready && bi.engines.openai.paid && bi.engines.openai.forBooks, 'backendInfo: OpenAI ready, paid, for books');
    const sdRecord = require('../sd-record');
    const rm = sdRecord.remakeRequest({ engine: 'openai', promptTyped: 'a storm', prompt: 'a storm' });
    assert(rm.engine === 'openai' && rm.request.engine === 'openai' && /paid/.test(rm.note), 'Remake of an OpenAI picture asks OpenAI again (and says it is paid)');
    const st0 = studio.openaiStatus();
    assert(st0.ok && st0.model === 'gpt-image-1' && st0.monthlyLimit === 30 && !('key' in st0) && !JSON.stringify(st0).includes(KEY), 'openaiStatus: the settings and the count — never the key');
  }

  console.log('== the 🎨 Images tab (jsdom) ==');
  let JSDOM = null;
  try { ({ JSDOM } = require('jsdom')); } catch (_) { /* not installed */ }
  if (!JSDOM) assert(true, 'jsdom not installed — the tab is checked in the e2e suite');
  else {
    const html = fs.readFileSync(path.join(DIR, 'controls.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
    const calls = [];
    let oa = { ok: true, engine: 'openai', ready: false, why: 'no OpenAI API key is saved', enabled: false, hasKey: false, model: 'gpt-image-1', quality: 'medium', monthlyLimit: 30, usedThisMonth: 0, forBooks: false };
    const sd = {
      status: async () => ({ ok: true, enabled: false, endpoint: '' }),
      openaiStatus: async () => { calls.push(['openaiStatus']); return oa; },
      openaiSettings: async (p) => { calls.push(['openaiSettings', p]); oa = Object.assign({}, oa, p, { hasKey: p.key ? true : p.key === '' ? false : oa.hasKey }); delete oa.key; oa.ready = oa.enabled && oa.hasKey; return Object.assign({ ok: true }, oa); },
      openaiCheck: async () => { calls.push(['openaiCheck']); return { ok: true, message: '✔ The key works, and gpt-image-1 is available.' }; },
      request: async (b) => { calls.push(['request', b]); return { ok: true, engine: 'openai', images: [{ path: '/out/x.png', url: 'file:///out/x.png' }], settings: { model: 'gpt-image-1', seconds: 21 }, warnings: [] }; },
    };
    dom.window.api = new Proxy({ sd }, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
    dom.window.api.sd = new Proxy(sd, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({ ok: true, items: [], images: [], workflows: [], locks: [] }); } });
    dom.window.confirm = () => true;
    try { dom.window.eval(fs.readFileSync(path.join(DIR, 'controls.js'), 'utf8')); } catch (_) { /* not this test's business */ }
    dom.window.eval(fs.readFileSync(path.join(DIR, 'images-studio.js'), 'utf8'));
    await tick(60);
    const $ = (id) => dom.window.document.getElementById(id);
    const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    assert([...$('sd-engine').options].some((o) => o.value === 'openai' && /paid/.test(o.textContent)), 'the Engine list has "💳 OpenAI (paid — your API key)"');
    assert(/No key yet/.test($('sd-oa-state').textContent) && /30 pictures/.test($('sd-oa-state').textContent), 'the ⚙ OpenAI pictures box: no key yet, the monthly limit');
    $('sd-engine').value = 'openai';
    fire($('sd-engine'), 'change');
    await tick(40);
    assert($('sd-openai-box').open && /can't draw yet/.test($('sd-engine-note').textContent), 'choosing OpenAI opens the box and says what is missing');
    $('sd-oa-key').value = KEY;
    $('sd-oa-savekey').click();
    await tick(40);
    assert(calls.some((c) => c[0] === 'openaiSettings' && c[1].key === KEY) && $('sd-oa-key').value === '' && /Key saved/.test($('sd-oa-state').textContent), '💾 Save key sends it once; the field is emptied; "Key saved"');
    $('sd-oa-on').checked = true;
    fire($('sd-oa-on'), 'change');
    $('sd-oa-limit').value = '12';
    fire($('sd-oa-limit'), 'change');
    $('sd-oa-books').checked = true;
    fire($('sd-oa-books'), 'change');
    await tick(40);
    const lastSave = calls.filter((c) => c[0] === 'openaiSettings').pop()[1];
    assert(lastSave.enabled === true && lastSave.monthlyLimit === 12 && lastSave.forBooks === true && !('key' in lastSave), 'turning it on, the limit and "for book pictures" are saved (without re-sending the key)');
    assert(/ready/.test($('sd-oa-state').textContent) && /OpenAI \(gpt-image-1\) is ready/.test($('sd-engine-note').textContent), 'then it is ready');
    $('sd-oa-check').click();
    await tick(40);
    assert(/The key works/.test($('sd-oa-msg').textContent), '✔ Check key shows the answer');
    $('sd-prompt').value = 'a lighthouse at dawn';
    $('btn-sd-generate').click();
    await tick(80);
    const req = calls.find((c) => c[0] === 'request');
    assert(req && req[1].engine === 'openai' && /lighthouse/.test(req[1].prompt), 'Generate with OpenAI chosen → a request with engine "openai"');
    assert(/drawn by OpenAI \(gpt-image-1\) in 21 s/.test($('sd-msg').textContent), 'the result says it was drawn by OpenAI');
    $('sd-oa-clearkey').click();
    await tick(40);
    assert(calls.some((c) => c[0] === 'openaiSettings' && c[1].key === '') && /removed/.test($('sd-oa-msg').textContent), '🗑 removes the key from the PC');
  }

  console.log('== the wiring ==');
  const main = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
  for (const ch of ['sd:openai-status', 'sd:openai-settings', 'sd:openai-check']) assert(main.includes(`ipcMain.handle("${ch}"`), `main.js handles ${ch}`);
  assert(/openaiImage: state\.openaiImage, \/\/ the key only as keyEnc/.test(main) && /next\.keyEnc = k \? secretStore\.seal\(k\) : null/.test(main), 'the key is sealed before it is saved; only keyEnc is written');
  assert(/logEvent\("openai-image-settings", \{[^}]*hasKey: !!next\.keyEnc \}\)/.test(main), 'the settings log line says whether there is a key — never the key');
  const preload = fs.readFileSync(path.join(DIR, 'preload.js'), 'utf8');
  for (const fn of ['openaiStatus', 'openaiSettings', 'openaiCheck']) assert(preload.includes(`${fn}:`), `preload: ${fn}`);
  const acts = fs.readFileSync(path.join(DIR, 'alfred-app-actions.js'), 'utf8');
  assert(/'sd:openai-settings': 'turns on a PAID picture service/.test(acts), 'Alfred can\'t turn on the paid service or touch the key');
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  assert(pkg.build.files.includes('openai-image.js'), 'packaged: openai-image.js');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
