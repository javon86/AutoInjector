'use strict';
// file-attach.e2e.js — attaching a picture to an AI pane in REAL Electron (xvfb), on fixture pages that mimic how sites
// take files (test/fixtures/attach-*.html), through file-attach.js exactly as main.js's attachFileToSite() uses it:
//   (a) the input is made only after clicking "+" → "Add files or photos" (the file chooser is caught; no window opens)
//   (a2) the paperclip adds an input to the page        (b) the input is in a shadow root (open, and closed)
//   (c) no input: a paste is taken                      (d) no input: only a drop is taken
//   the check: a page that throws the file away → ATTACH_NOT_SEEN (never "attached" when it isn't)
//   the old attach (build 76b8da7) fails (a) and (c) with NO_FILE_INPUT_FOUND.
//   NODE_PATH=$PWD/node_modules:/opt/node-tools/node_modules TMPDIR=/dev/shm xvfb-run -a node test/e2e/file-attach.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAsserts } = require('./helpers');

let electron;
try { electron = require('playwright')._electron; } catch (_) { console.error('needs playwright'); process.exit(2); }
const FIX = path.join(__dirname, '..', 'fixtures');
const page = (f, q) => `file://${path.join(FIX, f)}${q ? `?${q}` : ''}`;
// a real 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const { assert, state } = makeAsserts();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-attach-e2e-'));
  const pic = path.join(tmp, 'judge-me.png'); fs.writeFileSync(pic, PNG);
  const app = await electron.launch({ args: [path.join(FIX, 'attach-harness-main.js'), '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'ud')}`] });
  const run = (f, q, opts) => app.evaluate((_e, a) => global.runAttach(a), { url: page(f, q), file: pic, opts });
  const old = (f, q) => app.evaluate((_e, a) => global.runOld(a), { url: page(f, q), file: pic });
  const one = (r, via) => r.page && r.page.got.length === 1 && r.page.got[0].via === via && r.page.got[0].name === 'judge-me.png' && r.page.got[0].size === PNG.length && r.page.got[0].type === 'image/png';
  const show = (r) => `${r.ok ? `ok via ${r.how}` : r.error}${r.detail ? ` (${r.detail})` : ''} [${(r.tried || []).join(', ')}] ${r.ms}ms`;
  try {
    console.log('\n== (a) the input is made only after clicking ==');
    let r = await run('attach-button.html', 'mode=menu');
    assert(r.ok && r.how === 'reveal' && r.verified && one(r, 'chooser'), `"+" → "Add files or photos": the chooser's input got the picture (${show(r)})`);
    assert(r.page.wrong === 0 && r.page.chips === 1, 'nothing else was clicked (no screenshot, no GitHub), one chip shows');
    r = await run('attach-button.html', 'mode=reveal');
    assert(r.ok && r.how === 'reveal' && one(r, 'reveal') && r.page.wrong === 0, `the paperclip's new input got the picture (${show(r)})`);

    console.log('\n== (b) the input is inside a shadow root ==');
    r = await run('attach-shadow.html');
    assert(r.ok && r.how === 'input' && one(r, 'shadow') && r.page.wrong === 0, `an open shadow root's input (the PDF-only input left alone) (${show(r)})`);
    r = await run('attach-shadow.html', 'closed=1');
    assert(r.ok && r.how === 'deep' && one(r, 'shadow') && r.page.wrong === 0, `a CLOSED shadow root's input, through DevTools' own tree (${show(r)})`);

    console.log('\n== (c) no input: a paste ==');
    r = await run('attach-paste.html');
    assert(r.ok && r.how === 'paste' && r.verified && one(r, 'paste'), `the composer took the pasted picture (${show(r)})`);

    console.log('\n== (d) no input: a drop ==');
    r = await run('attach-drop.html');
    assert(r.ok && r.how === 'drop' && r.verified && one(r, 'drop') && (r.tried || []).includes('paste:not-seen'), `the paste wasn't taken, the drop was (${show(r)})`);

    console.log('\n== the check: the page never shows it ==');
    r = await run('attach-none.html');
    assert(!r.ok && r.error === 'ATTACH_NOT_SEEN' && r.page.ignored >= 1 && r.page.chips === 0 && ['input:not-seen', 'deep:same-input', 'paste:not-seen', 'drop:not-seen'].every((x) => r.tried.includes(x)), `a page that throws the file away → ATTACH_NOT_SEEN (${show(r)})`);
    r = await run('attach-paste.html', '', { methods: ['input', 'deep'] });
    assert(!r.ok && r.error === 'NO_FILE_INPUT_FOUND', `nothing to put it in → NO_FILE_INPUT_FOUND (${show(r)})`);
    r = await run('attach-none.html', '', { verify: false, methods: ['input'] });
    assert(r.ok && r.how === 'input' && r.verified === false, 'with the check switched off, the old "set it and go" behaviour');

    console.log('\n== the old attach (build 76b8da7) ==');
    const oa = await old('attach-button.html', 'mode=menu');
    assert(!oa.ok && oa.error === 'NO_FILE_INPUT_FOUND', `(a) the old attach fails: ${oa.error || 'ok'}`);
    const oc = await old('attach-paste.html');
    assert(!oc.ok && oc.error === 'NO_FILE_INPUT_FOUND', `(c) the old attach fails: ${oc.error || 'ok'}`);
    const ob = await old('attach-shadow.html');
    assert(!(ob.ok && ob.page.got.length), `(b) the old attach can't reach the shadow root's input (${ob.ok ? 'it filled the PDF-only one' : ob.error})`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
