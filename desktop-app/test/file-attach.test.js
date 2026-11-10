'use strict';
// test/file-attach.test.js — file-attach.js (putting a picture into an AI pane's chat) without Electron:
//   A. the page scripts on the attach-*.html fixtures in jsdom: the finder (shadow roots, accept=, near the composer),
//      the attach-button finder (never "Google Drive" / "screenshot"), the evidence counts; the OLD finder fails (a)/(c)
//   B. DevTools' own tree (closed shadow roots) → backendNodeIds
//   C. attachFile's order and codes with a fake DevTools session: input / reveal (chooser) / paste / drop, the check,
//      NO_FILE_INPUT_FOUND vs ATTACH_NOT_SEEN, never clicking without the chooser intercept, codes-only results
//   D. the 🧑‍⚖️ pane judge says the attach failure in plain words; the judge setting to switch the check off
//   E. 🔁 Make it better: a round that couldn't be made says why in plain words (never a bare "SD_ERROR")
// Real Electron (each path really attaching) is test/e2e/file-attach.e2e.js.
// Run: node test/file-attach.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const FA = require('../file-attach');
const SITES = require('../selectors');
const { buildFileInputFinderExpression } = require('../automation');
const JS = require('../image-judge-service');
const J = require('../image-judge');
const { roundFailText } = require('../sd-improve');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const FIX = path.join(__dirname, 'fixtures');
const LIB = { composer: SITES.claude.INPUT_CANDIDATES, candidates: SITES.claude.FILE_INPUT_CANDIDATES, name: 'judge-me.png' };

// A fixture page in jsdom (its attach-common.js inlined), with layout faked so everything has a size.
function fixture(file, query) {
  let html = fs.readFileSync(path.join(FIX, file), 'utf8');
  html = html.replace('<script src="attach-common.js"></script>', `<script>${fs.readFileSync(path.join(FIX, 'attach-common.js'), 'utf8')}</script>`);
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `file:///fixture/${file}${query ? `?${query}` : ''}` });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { const hidden = this.style && this.style.display === 'none'; return { left: 10, top: 10, width: hidden ? 0 : 20, height: hidden ? 0 : 20, right: 30, bottom: 30 }; };
  return w;
}

function partA() {
  console.log('\n== A. the page scripts on the fixtures (jsdom) ==');
  let w = fixture('attach-shadow.html');
  let el = w.eval(FA.buildFinderExpression(LIB));
  assert(el && el.getAttribute('accept') === 'image/png,image/jpeg,image/webp' && el.getRootNode() !== w.document, '(b) the finder reaches the input inside an open shadow root, not the PDF-only one');
  const oldB = w.eval(buildFileInputFinderExpression('claude'));
  assert(oldB && oldB.getAttribute('accept') === '.pdf', '(b) the old finder picks the PDF-only input in the page');
  w = fixture('attach-shadow.html', 'closed=1');
  assert(w.eval(FA.buildFinderExpression(LIB)) === null, '(b, closed) a closed shadow root is out of a page script\'s reach (DevTools\' tree does it — part B)');

  w = fixture('attach-button.html', 'mode=menu');
  assert(w.eval(FA.buildFinderExpression(LIB)) === null && w.eval(buildFileInputFinderExpression('claude')) === null, '(a) no input in the page: the old finder → nothing (NO_FILE_INPUT_FOUND)');
  let t = w.eval(FA.buildRevealExpression(LIB, 1));
  const marked = w.document.querySelector('[data-ai-attach-target]');
  assert(t.found && marked && marked.getAttribute('aria-label') === 'Open attachments menu', '(a) the attach button found is "Open attachments menu" — not "Add from Google Drive" / "Take a screenshot"');
  assert(!w.eval(FA.buildRevealExpression(LIB, 1)).found, 'a button already tried is not tried again');
  marked.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  assert(w.eval(FA.buildRevealExpression(LIB, 2, true)).found, 'the menu that opened is noticed (peek)');
  t = w.eval(FA.buildRevealExpression(LIB, 2));
  const item = w.document.querySelector('[data-ai-attach-target]');
  assert(t.found && item && item.textContent === 'Add files or photos', 'the menu item picked is "Add files or photos" — not "Take a screenshot" / "Add from GitHub"');

  w = fixture('attach-paste.html');
  assert(w.eval(buildFileInputFinderExpression('claude')) === null && !w.eval(FA.buildRevealExpression(LIB, 1)).found, '(c) no input and no attach button: the old finder → nothing');
  const ev0 = w.eval(FA.buildEvidenceExpression(LIB));
  w.__attach.take([{ name: 'judge-me.png', size: 3, type: 'image/png' }], 'paste');
  const ev1 = w.eval(FA.buildEvidenceExpression(LIB));
  assert(ev0.previews === 0 && ev1.previews === 1 && ev1.names >= 0 && FA.grew(ev0, ev1) && !FA.grew(ev1, ev1), 'the check counts a new file chip next to the composer (and nothing new → not grown)');

  w = fixture('attach-none.html');
  const e = w.eval(FA.buildEvidenceExpression(LIB));
  assert(e && Object.keys(e).sort().join() === 'blobImgs,files,names,nearImgs,previews' && Object.values(e).every((v) => typeof v === 'number'), 'evidence is counts only (no page text comes back)');
}

function partB() {
  console.log('\n== B. DevTools\' own tree (closed shadow roots) ==');
  const tree = { nodeName: '#document', children: [{ nodeName: 'HTML', children: [{ nodeName: 'BODY', children: [
    { nodeName: 'INPUT', backendNodeId: 5, attributes: ['type', 'file', 'accept', '.pdf'] },
    { nodeName: 'FILE-UPLOADER', shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: 'closed', children: [{ nodeName: 'INPUT', backendNodeId: 9, attributes: ['type', 'file', 'accept', 'image/png'] }] }] },
    { nodeName: 'IFRAME', contentDocument: { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 12, attributes: ['type', 'FILE'] }] } },
    { nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'file', 'disabled', ''] },
    { nodeName: 'INPUT', backendNodeId: 8, attributes: ['type', 'text'] },
  ] }] }] };
  const ids = FA.fileInputsInTree(tree).map((x) => x.backendNodeId);
  assert(ids.join() === '9,12', `the closed shadow root's picture input first, then the frame's (no PDF-only, disabled or text inputs): ${ids.join()}`);
  assert(FA.mimeOf('a/b/pic.PNG') === 'image/png' && FA.mimeOf('x.webp') === 'image/webp' && FA.mimeOf('x.weird') === 'application/octet-stream', 'file types from the name');
}

// A fake page behind a fake DevTools session: { input, chooser, menu, paste, drop } say what the page does.
function fakeSession(page) {
  const P = Object.assign({ input: false, revealInput: false, button: false, menu: false, chooser: false, paste: false, drop: false, intercept: true, setTakes: true }, page);
  const st = { chips: 0, files: 0, clicks: 0, level: 0, calls: [], listeners: [], escape: 0, set: [] };
  const fire = (m, p) => st.listeners.forEach((fn) => fn({}, m, p));
  const dbg = {
    on: (ev, fn) => { if (ev === 'message') st.listeners.push(fn); },
    removeListener: (ev, fn) => { st.listeners = st.listeners.filter((x) => x !== fn); },
    async sendCommand(method, params) {
      st.calls.push(method);
      if (method === 'Runtime.evaluate') {
        const x = params.expression;
        if (x.includes('return evidence()')) return { result: { value: { files: st.files, previews: st.chips, blobImgs: 0, nearImgs: 0, names: 0 } } };
        if (x.includes('return findInput()')) return { result: (P.input || (P.revealInput && st.clicks > 0)) ? { type: 'object', objectId: 'in-1' } : { type: 'object', subtype: 'null' } };
        if (x.includes("CFG.menu") && x.includes("return { found: true };") && /if \(true\) return/.test(x)) return { result: { value: { found: P.menu && st.level === 1 } } };
        if (x.includes('CFG.reveal') || x.includes('CFG.menu')) {
          const level = x.includes("new RegExp(CFG.menu") ? 2 : 1;
          if (level === 1 && !P.button) return { result: { value: { found: false } } };
          if (level === 1 && st.level >= 1) return { result: { value: { found: false } } };
          if (level === 2 && (!P.menu || st.level !== 1)) return { result: { value: { found: false } } };
          return { result: { value: { found: true, x: 5, y: 5, inView: true, level } } };
        }
        if (x.includes('new ClipboardEvent')) {
          const kind = x.includes(`if ("paste" === 'paste')`) ? 'paste' : 'drop';
          st.carry = (st.carry || []).concat(kind);
          if (P[kind]) st.chips++;
          return { result: { value: { ok: true, target: 'composer', handled: !!P[kind] } } };
        }
        return { result: { value: undefined } };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 1 } };
      if (method === 'DOM.getDocument') return { root: { nodeName: '#document', children: [] } };
      if (method === 'DOM.setFileInputFiles') { st.set.push(params.objectId ? 'object' : `node:${params.backendNodeId}`); if (P.setTakes) { st.files++; st.chips++; } return {}; }
      if (method === 'Page.setInterceptFileChooserDialog') { if (!P.intercept) throw new Error('not supported'); return {}; }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseReleased') {
          st.clicks++;
          if (st.level === 0) { st.level = 1; if (P.chooser && !P.menu) setTimeout(() => fire('Page.fileChooserOpened', { backendNodeId: 77 }), 5); }
          else if (st.level === 1 && P.menu) { st.level = 2; if (P.chooser) setTimeout(() => fire('Page.fileChooserOpened', { backendNodeId: 78 }), 5); }
        }
        return {};
      }
      if (method === 'Input.dispatchKeyEvent') { if (params.type === 'keyUp') st.escape++; return {}; }
      return {};
    },
  };
  return { dbg, st };
}

async function partC() {
  console.log('\n== C. attachFile: the order, the check and the codes (a fake DevTools session) ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-attach-unit-'));
  const pic = path.join(tmp, 'judge-me.png'); fs.writeFileSync(pic, Buffer.from([137, 80, 78, 71]));
  const fast = { verifyMs: 30, revealWaitMs: 60, composer: LIB.composer, candidates: LIB.candidates };
  try {
    let f = fakeSession({ input: true });
    let r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'input' && r.verified === true && f.st.set.join() === 'object' && !f.st.calls.includes('Input.dispatchMouseEvent'), 'an input in the page: used first, checked, nothing clicked');

    f = fakeSession({ button: true, menu: true, chooser: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'reveal' && f.st.set.join() === 'node:78' && f.st.clicks === 2 && f.st.escape === 0, `"+" → menu item → the chooser's input (${r.tried.join(', ')})`);
    const iOn = f.st.calls.indexOf('Page.setInterceptFileChooserDialog'); const iClick = f.st.calls.indexOf('Input.dispatchMouseEvent');
    assert(iOn >= 0 && iOn < iClick && f.st.calls.lastIndexOf('Page.setInterceptFileChooserDialog') > iClick, 'the file chooser is intercepted BEFORE any click, and released after');

    f = fakeSession({ button: true, revealInput: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'reveal' && f.st.set.join() === 'object', 'a click that adds an input to the page → that input');

    f = fakeSession({ button: true, menu: true, chooser: true, intercept: false, paste: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'paste' && f.st.clicks === 0 && r.tried.includes('reveal:no-intercept'), 'no chooser intercept → never clicks (a real file window would pop up); paste instead');

    f = fakeSession({ paste: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'paste' && r.tried.join() === 'input:none,deep:none,reveal:no-button,paste:ok', `(c) paste (${r.tried.join(', ')})`);

    f = fakeSession({ drop: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(r.ok && r.how === 'drop' && r.tried.includes('paste:not-seen'), '(d) the paste not taken → the drop');

    f = fakeSession({ input: true, setTakes: false, button: true });
    r = await FA.attachFile(f.dbg, pic, fast);
    assert(!r.ok && r.error === 'ATTACH_NOT_SEEN' && r.tried.includes('input:not-seen') && r.tried.includes('paste:not-seen') && r.tried.includes('drop:not-seen') && f.st.escape >= 1, `the page never shows it → ATTACH_NOT_SEEN, the menu closed again (${r.tried.join(', ')})`);
    assert(r.tried.every((x) => /^[a-z]+:[a-z-]+$/.test(x)), 'what was tried is codes only');

    f = fakeSession({ input: true, setTakes: false });
    r = await FA.attachFile(f.dbg, pic, Object.assign({}, fast, { verify: false, methods: ['input'] }));
    assert(r.ok && r.how === 'input' && r.verified === false, 'the check switched off → the old "set it and go"');

    f = fakeSession({});
    r = await FA.attachFile(f.dbg, pic, Object.assign({}, fast, { methods: ['input', 'deep', 'reveal'] }));
    assert(!r.ok && r.error === 'NO_FILE_INPUT_FOUND', 'nothing to put it in → NO_FILE_INPUT_FOUND (as before)');

    f = fakeSession({ paste: true });
    r = await FA.attachFile(f.dbg, path.join(tmp, 'missing.png'), fast);
    assert(!r.ok && r.tried.includes('paste:no-file'), 'a missing file → no paste/drop attempted');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function partD() {
  console.log('\n== D. the 🧑‍⚖️ pane judge: the attach failure in plain words; the setting ==');
  const asked = [];
  const mk = (code) => JS.createPaneJudge({ site: () => 'claude', problem: () => null, ask: async (s, t, o) => { asked.push(o); return { ok: false, error: 'ATTACH_FAILED', code }; } });
  let r = await mk('ATTACH_NOT_SEEN').ask({ imagePath: '/x.png', prompt: 'p' });
  assert(!r.ok && r.error === 'PANE_ATTACH_FAILED' && r.code === 'ATTACH_NOT_SEEN' && /never showed it as attached/.test(r.message) && /wasn't sent/.test(r.message), `not seen → "${r.message}"`);
  r = await mk('NO_FILE_INPUT_FOUND').ask({ imagePath: '/x.png', prompt: 'p' });
  assert(r.code === 'NO_FILE_INPUT_FOUND' && /no way to attach a file/.test(r.message), 'no way to attach → said so');
  r = await mk(undefined).ask({ imagePath: '/x.png', prompt: 'p' });
  assert(r.error === 'PANE_ATTACH_FAILED' && r.code === undefined && /couldn't be uploaded to the Claude/.test(r.message), 'no code → the old sentence');
  const s = J.cleanSettings({});
  assert(s.attachCheck === true && J.cleanSettings({ attachCheck: false }, s).attachCheck === false && J.cleanSettings({ attachCheck: 'no' }, s).attachCheck === true, 'the judge setting "check the picture shows in the chat": on by default, can be switched off');
}

function partE() {
  console.log('\n== E. 🔁 Make it better: a round that couldn\'t be made, in plain words ==');
  let t = roundFailText({ ok: false, code: 'SD_ERROR', error: 'SD_ERROR', message: 'Image generation failed: SD_ERROR' });
  assert(!/SD_ERROR/.test(t) && /reported an error/.test(t) && /window/.test(t), `a bare code → plain words ("${t}")`);
  t = roundFailText({ ok: false, code: 'SD_ERROR' });
  assert(!/SD_ERROR/.test(t) && /couldn't be made/.test(t), 'no message → plain words');
  t = roundFailText({ ok: false, code: 'OOM', message: 'Your graphics card ran out of memory making this picture.', fix: 'Try a smaller size.' });
  assert(t === 'Your graphics card ran out of memory making this picture. Try a smaller size.', 'a good message is kept, with what to try');
  t = roundFailText({ ok: false, error: 'HTTP_500', message: 'HTTP_500' });
  assert(!/HTTP_500/.test(t) && /reported an error/.test(t), 'HTTP_500 → plain words');
  assert(/something went wrong/.test(roundFailText(null)), 'nothing at all → still a sentence');
}

async function partF() {
  console.log('\n== F. 🔁 a round that fails: shown at once in the strip, said in the summary ==');
  const { createImprover } = require('../sd-improve');
  const v = J.validate({ scores: { prompt: 5, quality: 5, anatomy: 5, artifacts: 5, composition: 5 }, verdict: 'fix', fixes: [{ type: 'steps', delta: 4 }] }, {});
  const rec = { prompt: 'x', seed: 1, steps: 20, cfgScale: 7, width: 512, height: 512, engine: 'sd', backend: 'a1111', judge: v.judge };
  const prog = []; const logs = [];
  const imp = createImprover({ generate: async () => ({ ok: false, code: 'SD_ERROR', error: 'HTTP_500', message: 'Image generation failed: SD_ERROR' }), judge: async () => ({ ok: true, judge: v.judge }), readRecord: () => rec, updateRecord: () => {}, ctxFor: async () => ({}), log: (t, d) => logs.push([t, d]), onProgress: (e) => prog.push(e) });
  const r = await imp.improve('/x.png', { rounds: 3 });
  const live = prog.find((e) => e.phase === 'judged' && e.round === 2);
  assert(live && /couldn't be made: your Stable Diffusion app reported an error/.test(live.result.error), 'the failed round reaches the strip at once, with why');
  assert(r.ok && r.stopReason === 'failed' && /^It stopped at round 2: the picture couldn't be made: your Stable Diffusion app reported an error .*details\)\. The best is round 1\.$/.test(r.say) && !/SD_ERROR/.test(r.say), `the summary in plain words ("${r.say}")`);
  assert(logs.some(([t, d]) => t === 'image-improve' && d.round === 2 && d.error === 'SD_ERROR' && Object.keys(d).join() === 'id,round,error'), 'the log keeps the code only');
}

(async () => {
  partA(); partB(); await partC(); await partD(); partE(); await partF();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
