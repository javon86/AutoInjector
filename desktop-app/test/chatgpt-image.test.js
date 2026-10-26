// test/chatgpt-image.test.js — ChatGPT as the second image engine (chatgpt-image.js) and
// the reference-view words (image-views.js).
//   A. pure helpers: sniff (PNG / JPEG / WebP headers), refusal / limit wording, the
//      view phrases and the ChatGPT / SD prompts.
//   B. the engine's logic against a scripted fake pane (test/fixtures/fake-chatgpt-image.js):
//      the queue (one job at a time), the pane hold, not-ready / send failures, refusal,
//      limit (words and banner), timeout, cancel, a fetch that needs the session
//      fallback, WebP → PNG, fresh chat per series.
//   B2. sd-studio's engine routing (engine auto / sd / chatgpt, view, sheet, NO_IMAGE_ENGINE)
//      and the bridge's status codes, with a fake ChatGPT engine and no SD app.
//   C. the REAL page scripts in REAL Chromium (Playwright) against test/fixtures/fake-chat.html
//      ?image=…: the request is typed with the app's own send script, a placeholder and a
//      blurred preview come first, then a real PNG (or WebP → PNG) is fetched from the page
//      with its session; avatars are ignored; refusal / limit / never / words variants.
// Run: node test/chatgpt-image.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const CI = require('../chatgpt-image');
const V = require('../image-views');
const { fakeChatGptPane, makePng, makeWebpHeader } = require('./fixtures/fake-chatgpt-image');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chatimg-'));
const FAST = { pollMs: 40, stableReads: 2, stableReadsWriting: 6, textSettleMs: 150, noImageMs: 500, timeoutMs: 3000, newChatWaitMs: 500 };

function engine(pane, over = {}) {
  const calls = { hold: [], makeWay: 0, newChat: 0, recorded: [], logs: [], after: 0 };
  const e = CI.createChatGptImage(Object.assign({
    paneReady: () => ({ ready: true }),
    send: async (text) => pane.send(text),
    runPage: async (script) => pane.run(script),
    hold: (on) => calls.hold.push(on),
    makeWay: async () => { calls.makeWay++; },
    prepare: async () => { calls.prepAt = calls.hold.length; },
    afterJob: async () => { calls.after++; },
    newChat: async () => { calls.newChat++; pane.state.turns = 0; pane.state.current = null; return { ok: true }; },
    imagesDir: () => path.join(TMP, 'images'),
    recordImage: (x) => calls.recorded.push(x),
    log: (t, d) => calls.logs.push([t, d]),
    fileUrl: (p) => `file://${p}`,
    options: FAST,
  }, over));
  return { e, calls };
}

async function partA() {
  console.log('\n== A. pure helpers ==');
  const png = makePng(320, 480);
  let s = CI.sniff(png);
  assert(s.type === 'png' && s.width === 320 && s.height === 480, `sniff: PNG 320×480 (${JSON.stringify(s)})`);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00]);
  s = CI.sniff(jpg);
  assert(s.type === 'jpeg' && s.width === 512 && s.height === 768, `sniff: JPEG reads its SOF size (${JSON.stringify(s)})`);
  s = CI.sniff(makeWebpHeader(640, 960));
  assert(s.type === 'webp' && s.width === 640 && s.height === 960, `sniff: WebP (VP8X) (${JSON.stringify(s)})`);
  assert(CI.sniff(Buffer.from('<html>not a picture</html>')).type === '', 'sniff: HTML is not a picture');
  assert(CI.classifyText("I'm sorry, but I can't create that image because it goes against our content policy.") === 'refused', 'a content-policy answer reads as refused');
  assert(CI.classifyText("You've reached your image creation limit. Your limit resets in 4 hours.") === 'limit', '"You\'ve reached your … limit" reads as the limit');
  assert(CI.classifyText('Here is the picture of the lighthouse keeper.') === null, 'an ordinary sentence is neither');
  assert(CI.firstSentence("I can't create that image. It goes against policy.") === "I can't create that image.", 'firstSentence() keeps only the first sentence');
  assert(V.VIEW_IDS.length === 10 && V.VIEW_IDS.every((v) => V.VIEW_PHRASES[v] && /full body, head to toe/.test(V.VIEW_PHRASES[v]) && /no text/.test(V.VIEW_PHRASES[v])), 'one framing phrase per view (10), all full body, head to toe, no text');
  assert(/seen exactly from the side \(profile\), plain neutral light-grey studio background, even soft lighting, no text/.test(V.VIEW_PHRASES.side), 'side view: "seen exactly from the side (profile), plain neutral light-grey studio background, even soft lighting, no text"');
  assert(/tool at the belt/.test(V.VIEW_PHRASES.draw) && /empty-hand/.test(V.VIEW_PHRASES.attack), 'draw = reaching for a tool at the belt; attack = an empty-hand strike');
  const subj = V.describeSubject({ character: 'Moki Vey', looks: 'scar over the left eye', appearance: 'grey coat', prompt: '' });
  let t = V.chatgptPrompt({ subject: subj, purpose: 'view', view: 'side' });
  assert(/^Create an image: Moki Vey \(scar over the left eye; grey coat\)\. Framing: full body, head to toe, standing, seen exactly from the side \(profile\)/.test(t) && /keep them exactly the same/.test(t), `ChatGPT view prompt is clearly an image request with the exact framing ("${t.slice(0, 90)}…")`);
  t = V.chatgptPrompt({ subject: subj, purpose: 'sheet' });
  assert(/^Create one wide image: character turnaround sheet: the same character shown ten times in a 5×2 grid: front, 3\/4 front, side, 3\/4 back, back, idle, reaching for a tool, empty-hand attack, dash, defend; plain light-grey background; consistent outfit and proportions; no text labels/.test(t), 'ChatGPT sheet prompt: one wide 5×2 turnaround sheet, no labels');
  const sp = V.sdPrompt({ prompt: 'odile woman, silver hair', purpose: 'view', view: 'back' });
  assert(/^odile woman, silver hair, full body, head to toe, standing upright, seen exactly from behind/.test(sp.prompt) && /character reference/.test(sp.prompt) && /cut off feet/.test(sp.negative), 'SD view prompt: the lock words first, then the framing, "character reference"; a negative that keeps the body in frame');
  assert(/^character turnaround sheet/.test(V.sdPrompt({ prompt: 'x', purpose: 'sheet' }).prompt), 'SD sheet prompt starts with "character turnaround sheet"');
  assert(V.sdSize('view', 'SD1.5').height === 768 && V.sdSize('view', 'SDXL').height === 1216 && V.sdSize('sheet', 'SD1.5').width === 1024 && V.sdSize('sheet', 'SDXL').width === 1536, 'SD sizes: views tall, a sheet wide (bigger on SDXL)');
}

async function partB() {
  console.log('\n== B. the engine against a scripted fake pane ==');
  let pane = fakeChatGptPane({ mode: 'ok', delayMs: 200 });
  let { e, calls } = engine(pane);
  let r = await e.generate({ text: 'Create an image: a ferry captain. Make exactly one picture.', purpose: 'portrait', from: 'test', record: { prompt: 'a ferry captain' }, returnImage: true });
  assert(r.ok && r.engine === 'chatgpt' && r.images.length === 1 && fs.existsSync(r.images[0].path), `a finished picture is saved (${r.ok ? path.basename(r.images[0].path) : r.error})`);
  if (r.ok) {
    const rec = JSON.parse(fs.readFileSync(r.images[0].json, 'utf8'));
    assert(rec.engine === 'chatgpt' && rec.prompt === 'a ferry captain' && /Create an image/.test(rec.chatgptPrompt) && rec.purpose === 'portrait' && rec.width === 320, 'the .json sidecar says what made it (engine, prompt, the exact request, purpose, size)');
    assert(CI.sniff(fs.readFileSync(r.images[0].path)).type === 'png' && r.images[0].imageBase64, 'it is a real PNG; returnImage gives the base64 too');
    assert(/^portrait-/.test(path.basename(r.images[0].path)), 'the file name says portrait');
  }
  assert(pane.state.sends.length === 1 && calls.hold.join() === 'true,false' && calls.makeWay === 1 && calls.after === 1 && calls.recorded.length === 1, 'typed once; the pane was held and let go; check-ins made way; recorded as a project image');
  assert(calls.prepAt === 0, 'a reply ChatGPT was still writing gets to finish BEFORE the pane is held (prepare runs first)');
  assert(pane.state.scans >= 3, `the page was read until the picture held still (${pane.state.scans} reads)`);
  assert(!r.ok || !pane.state.srcs.includes(r.settings.src), 'the picture already on the page before (and the avatar, and the blurred preview) were ignored');

  // one at a time
  pane = fakeChatGptPane({ mode: 'ok', delayMs: 150 });
  ({ e, calls } = engine(pane));
  let inside = 0, maxInside = 0;
  const realSend = pane.send;
  pane.send = (t) => { inside++; maxInside = Math.max(maxInside, inside); setTimeout(() => { inside--; }, 250); return realSend(t); };
  const [r1, r2] = await Promise.all([e.generate({ text: 'Create an image: one', purpose: 'view', view: 'front' }), e.generate({ text: 'Create an image: two', purpose: 'view', view: 'side' })]);
  assert(r1.ok && r2.ok && r1.view === 'front' && r2.view === 'side' && pane.state.sends[1].at - pane.state.sends[0].at >= 150, 'two jobs at once are queued: the second is typed only after the first picture is in');
  assert(calls.hold.join() === 'true,false,true,false', 'each job holds and releases the pane in turn');

  pane = fakeChatGptPane({ mode: 'ok' });
  ({ e } = engine(pane, { paneReady: () => ({ ready: false, code: 'SIGNED_OUT', why: 'ChatGPT looks signed out' }) }));
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'CHATGPT_NOT_READY' && /signed out/.test(r.message) && r.hint && !pane.state.sends.length, 'a signed-out pane → CHATGPT_NOT_READY, nothing typed');
  ({ e } = engine(fakeChatGptPane({ mode: 'loggedout' })));
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'CHATGPT_NOT_READY' && /log/i.test(r.message), 'the page itself shows Log in → CHATGPT_NOT_READY');
  ({ e } = engine(fakeChatGptPane({ mode: 'ok' }), { send: async () => ({ ok: false, error: 'NO_VIEW' }) }));
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'CHATGPT_NOT_READY' && /missing/.test(r.message), 'a send that fails (no pane) → CHATGPT_NOT_READY in plain words');

  for (const [mode, code, re] of [['refuse', 'IMAGE_REFUSED', /content policy/], ['limit', 'IMAGE_LIMIT', /limit/], ['banner', 'IMAGE_LIMIT', /limit/], ['words', 'IMAGE_REFUSED', /answered in words|Ask more plainly/]]) {
    ({ e } = engine(fakeChatGptPane({ mode, delayMs: 120 })));
    r = await e.generate({ text: 'Create an image: x' });
    assert(!r.ok && r.error === code && (re.test(r.message) || re.test(r.hint || '')), `${mode} → ${code}: "${r.message}"`);
  }
  ({ e } = engine(fakeChatGptPane({ mode: 'refuse', delayMs: 120 })));
  r = await e.generate({ text: 'Create an image: x' });
  assert(r.message.includes("I'm sorry, but I can't create that image because it goes against our content policy.") && !/Want something else/.test(r.message), 'IMAGE_REFUSED carries ChatGPT\'s first sentence only');
  ({ e } = engine(fakeChatGptPane({ mode: 'never', delayMs: 100 }), { options: Object.assign({}, FAST, { timeoutMs: 600 }) }));
  const t0 = Date.now();
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'IMAGE_TIMEOUT' && Date.now() - t0 < 2500 && /within 1 seconds|within/.test(r.message), `nothing within the time limit → IMAGE_TIMEOUT ("${r.message}")`);
  ({ e, calls } = engine(fakeChatGptPane({ mode: 'never' }), { options: Object.assign({}, FAST, { timeoutMs: 5000 }) }));
  const pending = e.generate({ text: 'Create an image: x' });
  await sleep(200);
  assert(e.status().busy && e.status().phase === 'drawing' && e.status().drawingMs >= 0, `status() while drawing: busy, phase ${e.status().phase}`);
  e.cancel();
  r = await pending;
  assert(!r.ok && r.error === 'CANCELLED' && calls.hold.join() === 'true,false', 'cancel() stops the wait and lets go of the pane');

  // WebP that the page could not convert → nativeImage-style converter in main; fetch blocked → session fetch
  pane = fakeChatGptPane({ mode: 'webp', delayMs: 100 });
  let toPngCalls = 0;
  ({ e } = engine(pane, { toPng: (buf, kind) => { toPngCalls++; return kind === 'webp' ? makePng(300, 450) : null; } }));
  r = await e.generate({ text: 'Create an image: x', purpose: 'view', view: 'back' });
  assert(r.ok && toPngCalls === 1 && CI.sniff(fs.readFileSync(r.images[0].path)).type === 'png' && /^view-back-/.test(path.basename(r.images[0].path)), 'a WebP picture is converted to PNG before it is saved (file view-back-…png)');
  pane = fakeChatGptPane({ mode: 'webp', delayMs: 100 });
  ({ e } = engine(pane));
  r = await e.generate({ text: 'Create an image: x' });
  assert(r.ok && pane.state.converts === 1, 'without nativeImage the WebP is converted inside the page (canvas)');
  pane = fakeChatGptPane({ mode: 'fetchfail', delayMs: 100 });
  let sessionUrl = null;
  ({ e } = engine(pane, { fetchViaSession: async (u) => { sessionUrl = u; return { ok: true, buffer: makePng(256, 256) }; } }));
  r = await e.generate({ text: 'Create an image: x' });
  assert(r.ok && /estuary\/content/.test(sessionUrl || '') && r.settings.fetchedVia === 'session', 'the page\'s own fetch blocked → the session fetch gets the bytes');
  pane = fakeChatGptPane({ mode: 'fetchfail', delayMs: 100 });
  ({ e } = engine(pane));
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'IMAGE_FETCH_FAILED' && /HTTP_403/.test(r.message), 'no way to get the bytes → IMAGE_FETCH_FAILED, plain words');
  { // a JPEG keeps its bytes and is saved as .jpg (downstream PDF code takes PNG or JPEG)
    const jpgHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00]);
    pane = fakeChatGptPane({ mode: 'ok', delayMs: 80, png: Buffer.concat([jpgHead, Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]) });
    ({ e } = engine(pane));
    r = await e.generate({ text: 'Create an image: x' });
    assert(r.ok && /\.jpg$/.test(r.images[0].path) && fs.existsSync(r.images[0].json) && r.settings.width === 512, `a JPEG picture is saved as .jpg with its sidecar (${r.ok ? path.basename(r.images[0].path) : r.error})`);
  }
  pane = fakeChatGptPane({ mode: 'ok', delayMs: 80, png: Buffer.from('<html>login</html>') });
  ({ e } = engine(pane));
  r = await e.generate({ text: 'Create an image: x' });
  assert(!r.ok && r.error === 'IMAGE_FETCH_FAILED' && /not a PNG|not a picture/.test(r.message), 'an HTML page instead of a picture is refused (validated, not saved)');

  // series: same chat by default; a fresh chat per series when switched on
  pane = fakeChatGptPane({ mode: 'ok', delayMs: 60 });
  ({ e, calls } = engine(pane));
  await e.generate({ text: 'Create an image: a', purpose: 'view', view: 'front', series: 's1' });
  await e.generate({ text: 'Create an image: b', purpose: 'view', view: 'side', series: 's1' });
  assert(calls.newChat === 0, 'a view series stays in the SAME ChatGPT conversation by default');
  e.settings({ freshChatPerSeries: true });
  await e.generate({ text: 'Create an image: c', purpose: 'view', view: 'front', series: 's2' });
  await e.generate({ text: 'Create an image: d', purpose: 'view', view: 'side', series: 's2' });
  assert(calls.newChat === 1, '"fresh chat per series": one new chat when the series changes, not per view');
  r = await e.generate({ text: 'Create an image: e', newChat: true });
  assert(r.ok && calls.newChat === 2, 'newChat:true always starts a fresh chat');
  ({ e } = engine(fakeChatGptPane({}), {}));
  r = await e.generate({ text: '   ' });
  assert(!r.ok && r.error === 'NEED_PROMPT', 'an empty request is refused without touching the pane');
}

// ---- B2: sd-studio routing + the bridge (no SD app; a fake ChatGPT engine) --------------------
function req(port, method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}
async function partB2() {
  console.log('\n== B2. engine routing (sd-studio) and the bridge ==');
  const { createSdStudio } = require('../sd-studio');
  const { createServiceBridge } = require('../service-bridge');
  const sdLibrary = require('../sd-library');
  const ip = require('../image-provider');
  ip.setSettings({ enabled: false, endpoint: '' });
  const lib = sdLibrary.createLibrary({ storePath: path.join(TMP, 'lib.json'), defaultFolders: () => [] });
  lib.saveLock({ character: 'Moki Vey', loras: [], triggerWords: 'mokivey man', prompt: 'scar over the left eye, grey coat', seed: 77 });
  const jobs = [];
  let ready = true;
  let nextFail = null;
  const chatgpt = {
    status: () => ({ ok: true, ready, busy: false, why: ready ? undefined : 'ChatGPT looks signed out' }),
    readiness: () => ({ ready, why: ready ? '' : 'ChatGPT looks signed out', code: ready ? 'OK' : 'SIGNED_OUT' }),
    generate: async (job) => {
      jobs.push(job);
      if (nextFail) { const f = nextFail; nextFail = null; return CI.explain && Object.assign({ ok: false, engine: 'chatgpt', error: f, code: f }, CI.explain(f, { reason: 'nope', ms: 240000 })); }
      return { ok: true, engine: 'chatgpt', backend: 'chatgpt', purpose: job.purpose, view: job.view, seed: null, warnings: [], settings: Object.assign({ engine: 'chatgpt' }, job.record), images: [{ path: path.join(TMP, `cg-${jobs.length}.png`), sha256: 'x', imageBase64: job.returnImage ? 'AAAA' : undefined }] };
    },
  };
  const studio = createSdStudio({ imageProvider: ip, library: lib, imagesDir: () => path.join(TMP, 'images'), chatgpt });
  let r = await studio.request({ prompt: 'a lighthouse', engine: 'sd' });
  assert(!r.ok && r.error === 'SD_NOT_CONNECTED' && /Stable Diffusion/.test(r.message) && r.hint, 'engine "sd" with no SD app → SD_NOT_CONNECTED');
  r = await studio.request({ purpose: 'view', view: 'side', characterLock: 'moki vey', from: 'akowe' });
  assert(r.ok && r.engine === 'chatgpt' && r.view === 'side' && r.purpose === 'view' && Array.isArray(r.paths) && r.paths.length === 1, `engine auto + no SD app → ChatGPT; view echoed; paths given (${JSON.stringify({ engine: r.engine, view: r.view, paths: r.paths })})`);
  const j = jobs[jobs.length - 1];
  assert(/^Create an image: Moki Vey \(scar over the left eye, grey coat\)\. Framing: full body, head to toe, standing, seen exactly from the side \(profile\)/.test(j.text) && !/mokivey man/.test(j.text), `the lock becomes words for ChatGPT (name + looks, no SD trigger words): "${j.text.slice(0, 100)}…"`);
  assert(j.record.characterLock && j.record.characterLock.character === 'Moki Vey' && j.record.from === 'bridge:akowe' && j.series, 'the record names the lock and the caller; the view series is keyed by the character');
  r = await studio.request({ purpose: 'sheet', characterLock: 'Moki Vey', engine: 'chatgpt', returnImage: true });
  assert(r.ok && r.engine === 'chatgpt' && /^Create one wide image: character turnaround sheet/.test(jobs[jobs.length - 1].text) && r.images[0].imageBase64, 'purpose "sheet" → one wide turnaround sheet request; returnImage passes through');
  r = await studio.request({ purpose: 'view', characterLock: 'Moki Vey' });
  assert(!r.ok && r.error === 'INVALID_PARAM' && r.field === 'view' && /front, three_quarter_front/.test(r.hint), 'purpose "view" without a valid view → INVALID_PARAM naming the ten views');
  r = await studio.request({ prompt: 'x', engine: 'dalle' });
  assert(!r.ok && r.error === 'INVALID_PARAM' && r.field === 'engine', 'an unknown engine → INVALID_PARAM');
  r = await studio.request({ purpose: 'view', view: 'front', appearance: 'a tall woman in a red cloak' });
  assert(r.ok && /a tall woman in a red cloak/.test(jobs[jobs.length - 1].text), 'a typed appearance works without a lock');
  ready = false;
  r = await studio.request({ prompt: 'x' });
  assert(!r.ok && r.error === 'NO_IMAGE_ENGINE' && /ChatGPT looks signed out/.test(r.message), 'engine auto, no SD app and ChatGPT not ready → NO_IMAGE_ENGINE (saying why)');
  r = await studio.request({ prompt: 'x', engine: 'chatgpt' });
  assert(!r.ok && r.error === 'CHATGPT_NOT_READY', 'engine "chatgpt" when its pane isn\'t ready → CHATGPT_NOT_READY');
  ready = true;
  const be = studio.backendInfo();
  assert(be.ok && be.connected === false && be.engines && be.engines.sd && be.engines.sd.connected === false && be.engines.chatgpt && be.engines.chatgpt.ready === true, `backendInfo() lists both engines (${JSON.stringify(be.engines)})`);

  const TOKEN = 'tok-cg';
  const bridge = createServiceBridge({ version: '1', sdStudio: { request: (b) => studio.request(b), locks: () => studio.locks(), backend: () => studio.backendInfo() } });
  const st = await bridge.start({ port: 0, host: '127.0.0.1', token: TOKEN });
  let h = await req(st.port, 'GET', '/image/backend', null, TOKEN);
  assert(h.status === 200 && h.json.engines.chatgpt.ready === true && h.json.engines.sd.connected === false, 'GET /image/backend → {engines:{sd, chatgpt}}');
  h = await req(st.port, 'POST', '/image/request', { purpose: 'view', view: 'dash', characterLock: 'Moki Vey', engine: 'chatgpt' }, TOKEN);
  assert(h.status === 200 && h.json.ok && h.json.engine === 'chatgpt' && h.json.view === 'dash' && h.json.paths.length === 1, 'POST /image/request {engine:"chatgpt", purpose:"view", view:"dash"} → 200, engine and view in the answer');
  h = await req(st.port, 'POST', '/image/request', { prompt: 'x', engine: 'sd' }, TOKEN);
  assert(h.status === 503 && h.json.error === 'SD_NOT_CONNECTED', 'engine sd, none connected → 503 SD_NOT_CONNECTED');
  h = await req(st.port, 'POST', '/image/request', { purpose: 'view', view: 'sideways', prompt: 'x' }, TOKEN);
  assert(h.status === 400 && h.json.error === 'INVALID_PARAM', 'a bad view → 400 INVALID_PARAM');
  for (const [code, status] of [['IMAGE_REFUSED', 422], ['IMAGE_LIMIT', 429], ['IMAGE_TIMEOUT', 504], ['CHATGPT_NOT_READY', 503]]) {
    nextFail = code;
    h = await req(st.port, 'POST', '/image/request', { prompt: 'x', engine: 'chatgpt' }, TOKEN);
    assert(h.status === status && h.json.error === code && h.json.message && h.json.hint !== undefined && h.json.engine === 'chatgpt', `${code} → HTTP ${status} with message + hint`);
  }
  ready = false;
  h = await req(st.port, 'POST', '/image/request', { prompt: 'x' }, TOKEN);
  assert(h.status === 503 && h.json.error === 'NO_IMAGE_ENGINE', 'no engine at all → 503 NO_IMAGE_ENGINE');
  ready = true;
  // the bridge keeps a ChatGPT-length request open (Node's default request timeout is 5 min, ChatGPT can take longer)
  const slowStudio = { request: async () => { await sleep(1200); return { ok: true, engine: 'chatgpt', images: [], paths: [] }; }, locks: () => ({ locks: [] }), backend: () => ({}) };
  const b3 = createServiceBridge({ version: '1', sdStudio: slowStudio });
  const s3 = await b3.start({ port: 0, host: '127.0.0.1', token: TOKEN });
  h = await req(s3.port, 'POST', '/image/request', { prompt: 'x' }, TOKEN);
  assert(h.status === 200 && h.json.ok, 'a slow /image/request is answered when it is done');
  assert(typeof b3.server === 'function' && b3.server() && b3.server().requestTimeout === 0 && b3.server().timeout === 0, 'the bridge server has no request / socket timeout (the route\'s own timeouts apply)');
  await bridge.stop(); await b3.stop();
}

// ---- C: real Chromium ------------------------------------------------------------------------
const SANDBOX_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
async function partC() {
  console.log('\n== C. the real page scripts in real Chromium (fake-chat.html?image=…) ==');
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (_) { console.log('  skip - Playwright is not installed here (npm install --no-save playwright)'); return; }
  let browser;
  try { browser = await chromium.launch(fs.existsSync(SANDBOX_CHROMIUM_PATH) ? { executablePath: SANDBOX_CHROMIUM_PATH } : {}); }
  catch (e) { console.log(`  skip - no Chromium to run the page scripts in (${String(e.message || e).split('\n')[0]})`); return; }
  const { buildSendScript } = require('../automation');
  const FIX = path.join(__dirname, 'fixtures', 'fake-chat.html');
  try {
    async function withPage(q, fn) {
      const page = await browser.newPage();
      try { await page.goto(`file://${FIX}?site=chatgpt&quirks=none&speed=0.3&${q}`); await fn(page); } finally { await page.close(); }
    }
    function pageEngine(page, over = {}) {
      let seq = 0;
      const sent = [];
      const e = CI.createChatGptImage(Object.assign({
        paneReady: () => ({ ready: true }),
        send: async (text) => { const msg = `[MSG #${String(++seq).padStart(4, '0')}]\n${text}`; sent.push(msg); return page.evaluate(buildSendScript('chatgpt', msg, {}, {})); },
        runPage: (script) => page.evaluate(script),
        imagesDir: () => path.join(TMP, 'images-c'),
        options: Object.assign({}, FAST, { pollMs: 120, timeoutMs: 8000 }),
      }, over));
      return { e, sent };
    }
    await withPage('image=ok&avatar=1&imgdelay=900', async (page) => {
      const before = await page.evaluate(CI.buildScanScript(CI.defaultSelectors()));
      assert(before.ok && before.inputFound && !before.loggedOut && before.turns === 0, `scan on an empty chat: message box found, no assistant turns (${JSON.stringify({ turns: before.turns, inputFound: before.inputFound })})`);
      const { e, sent } = pageEngine(page);
      let sawPreview = false;
      const watch = setInterval(async () => { try { const s = await page.evaluate(CI.buildScanScript(CI.defaultSelectors())); if (s.last && s.last.images.some((i) => i.blurred)) sawPreview = true; } catch (_) {} }, 100);
      const r = await e.generate({ text: V.chatgptPrompt({ subject: 'Moki Vey (grey coat)', purpose: 'view', view: 'front' }), purpose: 'view', view: 'front' });
      clearInterval(watch);
      const dump = await page.evaluate(() => window.__fake.dump());
      assert(dump.posted.length === 1 && /^\[MSG #0001\]\nCreate an image: Moki Vey/.test(dump.posted[0].text) && sent.length === 1, 'the request is typed and sent with the app\'s own send script');
      assert(sawPreview, 'a blurred preview showed first (and was not taken)');
      assert(r.ok && fs.existsSync(r.images[0].path), `the finished picture is saved (${r.ok ? path.basename(r.images[0].path) : `${r.error}: ${r.message}`})`);
      if (r.ok) {
        const buf = fs.readFileSync(r.images[0].path); const sn = CI.sniff(buf);
        assert(sn.type === 'png' && sn.width === 512 && sn.height === 768, `the bytes are the page's real 512×768 PNG, fetched with the page's session (${JSON.stringify(sn)}, via ${r.settings.fetchedVia})`);
        assert(r.settings.width === 512 && !/avatar/.test(JSON.stringify(r.settings)), 'the 28 px avatar was ignored');
      }
      const r2 = await e.generate({ text: 'Create an image: the same character from the back', purpose: 'view', view: 'back' });
      assert(r2.ok && r2.images[0].path !== (r.ok && r.images[0].path) && (await page.evaluate(() => window.__fake.dump().posted.length)) === 2, 'a second view in the same chat: the first picture (already on the page) is not taken again');
    });
    await withPage('image=webp&imgdelay=600', async (page) => {
      const { e } = pageEngine(page);
      const r = await e.generate({ text: 'Create an image: x', purpose: 'sheet' });
      assert(r.ok && CI.sniff(fs.readFileSync(r.images[0].path)).type === 'png' && r.settings.converted === 'webp', `a WebP picture is converted to PNG in the page (${r.ok ? r.settings.converted : r.error})`);
    });
    await withPage('image=outside&imgdelay=600', async (page) => {
      const { e } = pageEngine(page);
      const r = await e.generate({ text: 'Create an image: x' });
      assert(r.ok, `a picture outside the message div but inside the assistant article is found (${r.ok ? 'ok' : r.error})`);
    });
    for (const [q, code] of [['image=refuse&imgdelay=300', 'IMAGE_REFUSED'], ['image=limit&imgdelay=300', 'IMAGE_LIMIT'], ['image=banner&imgdelay=1500', 'IMAGE_LIMIT'], ['image=words&imgdelay=300', 'IMAGE_REFUSED']]) {
      await withPage(q, async (page) => {
        const { e } = pageEngine(page);
        const r = await e.generate({ text: 'Create an image: x' });
        assert(!r.ok && r.error === code, `${q.split('&')[0]} → ${code} (${r.message})`);
      });
    }
    await withPage('image=never&imgdelay=300', async (page) => {
      const { e } = pageEngine(page, { options: Object.assign({}, FAST, { pollMs: 100, timeoutMs: 1500 }) });
      const r = await e.generate({ text: 'Create an image: x' });
      assert(!r.ok && r.error === 'IMAGE_TIMEOUT', 'a picture that never arrives → IMAGE_TIMEOUT');
    });
    {
      const page = await browser.newPage();
      await page.goto(`file://${FIX}?site=chatgpt&page=login`);
      const s = await page.evaluate(CI.buildScanScript(CI.defaultSelectors()));
      assert(s.ok && s.loggedOut && !s.inputFound, 'the scan recognises a logged-out page');
      await page.close();
    }
  } finally { await browser.close(); }
}

(async () => {
  try { await partA(); await partB(); await partB2(); await partC(); }
  catch (e) { failed++; console.log(`  FAIL - crashed: ${e && e.stack}`); }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
