'use strict';
// test/voice-picker.test.js — "✨ Better voices" in the 🔊 Voice box (voice-picker.js, drawn by voice-ui.js) in jsdom
// with a stub window.api: the recommended voices (data checks on voice-catalog.js too) with size, quality and the
// "uses a little of your processor only while reading" note; ▶ Sample plays the published sample (or the voice
// itself once downloaded) and says "download it to hear it" when there is none; ⬇ shows progress, ✕ Cancel, carries
// on later; "Use for…" saves that speaker's voice; ✨ Kokoro: Install (~350 MB) with progress, then "Use it",
// processor (default) / graphics card, a voice per speaker with ▶; failures in plain words. Nothing is fetched
// unless a button is pressed.
// Run: node test/voice-picker.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CAT = require('../voice-catalog');
const VR = require('../voice-read');

console.log('\n== the voice list (voice-catalog.js) ==');
assert(CAT.PIPER_VOICES.length >= 8, `${CAT.PIPER_VOICES.length} recommended piper voices`);
assert(CAT.PIPER_VOICES.every((v) => CAT.parseName(v.id) && v.files.length === 2 && v.files[0].name === `${v.id}.onnx` && v.files[1].name === `${v.id}.onnx.json` && v.files[1].json), 'each: a valid piper name, its .onnx and its .onnx.json (settings must parse)');
assert(CAT.PIPER_VOICES.every((v) => v.files.every((f) => f.url.startsWith('https://huggingface.co/rhasspy/piper-voices/resolve/main/'))), 'all from the official piper-voices repository, over https');
assert(CAT.piperUrl('en_GB-northern_english_male-medium', 'x.onnx') === 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/x.onnx', 'the documented layout <lang>/<lang_REGION>/<name>/<quality>/<file>');
assert(CAT.PIPER_VOICES.every((v) => v.bytes > 50e6 && v.bytes < 130e6 && v.files[0].bytes === v.bytes && ['high', 'medium'].includes(v.quality)), 'real sizes (50–130 MB) and good quality only');
assert(new Set(CAT.PIPER_VOICES.map((v) => v.id)).size === CAT.PIPER_VOICES.length, 'no voice listed twice');
const rec = VR.WHO.map((w) => CAT.recommendedFor(w));
assert(rec.every(Boolean) && new Set(rec).size === 4, `each speaker gets a different recommended voice (${rec.join(', ')})`);
const dflt = VR.defaultPiperVoices(CAT.PIPER_VOICES.map((v) => v.id));
assert(VR.WHO.every((w) => dflt[w] === CAT.recommendedFor(w)), 'with all of them downloaded, voice-read.js picks exactly the recommended one per speaker');
assert(CAT.KOKORO.files.length === 2 && CAT.KOKORO.files.every((f) => f.url.startsWith('https://')) && CAT.KOKORO.approxMB === 350 && CAT.KOKORO.packages.includes('kokoro-onnx'), 'Kokoro: the kokoro-onnx package + two model files (~350 MB)');
assert(VR.WHO.every((w) => CAT.KOKORO.voices.some((v) => v.id === CAT.KOKORO.defaults[w])) && CAT.KOKORO.voices.every((v) => CAT.kokoroVoiceOk(v.id)), 'Kokoro: a default voice per speaker, all from its list');

function setup(over = {}) {
  const dom = new JSDOM('<!doctype html><body><details id="vbox"><summary>🔊 Voice</summary><div id="voice-read-settings"></div></details></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const log = (...a) => calls.push(a);
  const ui = { downloadCb: null };
  const voices = CAT.PIPER_VOICES.map((v) => ({ id: v.id, label: v.label, gender: v.gender, lang: v.lang, langLabel: v.langLabel, quality: v.quality, bytes: v.bytes, suits: v.suits, installed: !!(over.installed && over.installed.includes(v.id)), downloading: false, partial: over.partial && over.partial[v.id] || 0 }));
  const kok = Object.assign({ approxMB: 350, voices: CAT.KOKORO.voices, defaults: CAT.KOKORO.defaults, model: false, pkg: false, ready: false, installing: false }, over.kokoro || {});
  const hold = {};
  w.api = {
    voiceCatalog: async () => { log('catalog'); return { ok: true, voices: voices.map((v) => ({ ...v })), kokoro: { ...kok }, engine: over.engine || 'piper', kokoroDevice: 'cpu', kokoroVoices: {}, defaults: {}, installedNames: [] }; },
    voiceDownload: async (id) => { log('download', id); await new Promise((r) => { hold.download = r; }); const ok = !over.downloadFail; if (ok) voices.find((v) => v.id === id).installed = true; return ok ? { ok: true, id } : { ok: false, error: 'HTTP_404', message: "en_US-x.onnx isn't on the download site any more. Pick another voice." }; },
    voiceDownloadCancel: async (id) => { log('cancel', id); hold.download && hold.download(); return { ok: true }; },
    voiceSample: async (id) => { log('sample', id); return over.noSample ? { ok: false, error: 'ENOTFOUND', message: "Couldn't fetch the sample (no internet?). Download the voice to hear it." } : { ok: true, audio: 'AAAA', mime: 'audio/mpeg', from: voices.find((v) => v.id === id).installed ? 'voice' : 'sample' }; },
    voiceKokoroInstall: async () => { log('kokoroInstall'); await new Promise((r) => { hold.kokoro = r; }); if (over.kokoroFail) return { ok: false, error: 'PIP_FAILED', message: "Couldn't install the Kokoro engine: pip exited 1. Your other voices still work." }; Object.assign(kok, { model: true, pkg: true, ready: true }); return { ok: true }; },
    voiceKokoroCancel: async () => { log('kokoroCancel'); return { ok: false, message: "The engine part can't be stopped halfway; the download after it can." }; },
    voiceSynthesize: async (text, who, voice, kv) => { log('synth', who, voice, kv); return { ok: true, audio: 'UklGR', mime: 'audio/wav', engine: kv ? 'kokoro' : 'piper', device: 'cpu' }; },
    configureVoice: async (p) => { log('configure', p); return { ok: true }; },
    onVoiceDownload: (cb) => { ui.downloadCb = cb; },
  };
  w.eval(SRC('voice-catalog.js'));
  w.eval(SRC('voice-picker.js'));
  const played = [];
  const changed = [];
  const picker = w.createVoicePicker({ win: w, doc: w.document, api: w.api, play: async (r) => { played.push(r); return true; }, onChanged: (c) => changed.push(c) });
  return { w, picker, calls, played, changed, hold, ui, voices, kok };
}
const $ = (w, id) => w.document.getElementById(id);
const click = (w, id) => $(w, id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const change = (w, id, v) => { const e = $(w, id); e.value = v; e.dispatchEvent(new w.Event('change', { bubbles: true })); };
async function mount(t) { await t.picker.load(); $(t.w, 'voice-read-settings').append(t.picker.render({ voices: {} })); }

(async () => {
  console.log('\n== the list ==');
  let t = setup({ installed: ['en_US-lessac-medium'], partial: { 'en_GB-cori-high': 40 * 1048576 } });
  await mount(t);
  let { w } = t;
  const box = $(w, 'voice-picker');
  assert(box && box.querySelectorAll('.vp-row').length === CAT.PIPER_VOICES.length, 'one row per recommended voice');
  assert(/use a little of it only while reading/.test(box.textContent) && /works offline/.test(box.textContent), 'says Piper uses a little of the processor, only while reading');
  assert(/⬇ Download \(109 MB\)/.test($(w, 'vp-dl-en_US-lessac-high').textContent) && /US English · woman · high quality · 109 MB/.test($(w, 'vp-row-en_US-lessac-high').textContent), 'size, language, quality on each row');
  assert($(w, 'vp-dl-en_US-lessac-medium').textContent === '✓ Downloaded' && !$(w, 'vp-use-en_US-lessac-medium').disabled, 'a downloaded voice: ✓ and "Use for…" works');
  assert($(w, 'vp-use-en_US-ryan-high').disabled, 'not downloaded yet: "Use for…" is off');
  assert(/Carry on \(40 MB of 109 MB done\)/.test($(w, 'vp-dl-en_GB-cori-high').textContent), 'a stopped download says it will carry on');
  assert(t.calls.filter((c) => c[0] !== 'catalog').length === 0, 'opening the box fetched nothing');

  console.log('\n== ▶ sample ==');
  click(w, 'vp-play-en_US-ryan-high'); await tick();
  assert(t.calls.some((c) => c[0] === 'sample' && c[1] === 'en_US-ryan-high') && t.played.length === 1, '▶ plays a sample');
  assert(/recording from the voice's makers/.test($(w, 'vp-msg-en_US-ryan-high').textContent), 'and says it is the makers\' recording — download it to use it');
  click(w, 'vp-play-en_US-lessac-medium'); await tick();
  assert(/Playing with this voice/.test($(w, 'vp-msg-en_US-lessac-medium').textContent), 'a downloaded voice reads itself');
  t = setup({ noSample: true }); await mount(t); w = t.w;
  click(w, 'vp-play-en_US-ryan-high'); await tick();
  assert(/Download the voice to hear it/.test($(w, 'vp-msg-en_US-ryan-high').textContent) && t.played.length === 0, 'no sample (no internet): "download it to hear it"');

  console.log('\n== ⬇ download: progress, cancel, done ==');
  t = setup(); await mount(t); w = t.w;
  click(w, 'vp-dl-en_US-ryan-high'); await tick();
  assert(!!$(w, 'vp-bar-en_US-ryan-high') && !!$(w, 'vp-cancel-en_US-ryan-high'), 'a progress bar and ✕ Cancel while it downloads');
  t.ui.downloadCb({ id: 'en_US-ryan-high', phase: 'progress', got: 54 * 1048576, total: 120786792 });
  assert(/^46% · 54 MB of 115 MB$/.test($(w, 'vp-pct-en_US-ryan-high').textContent), `progress in plain words ("${$(w, 'vp-pct-en_US-ryan-high').textContent}")`);
  t.ui.downloadCb({ id: 'en_US-ryan-high', phase: 'retry', message: 'The connection dropped — trying again (1 of 3), carrying on where it stopped…' });
  assert(/trying again/.test($(w, 'vp-pct-en_US-ryan-high').textContent), 'a retry is shown');
  t.hold.download();
  await tick();
  assert($(w, 'vp-dl-en_US-ryan-high').textContent === '✓ Downloaded' && /Downloaded/.test($(w, 'vp-msg-en_US-ryan-high').textContent), 'done: ✓ Downloaded');
  assert(t.changed.some((c) => c.downloaded === 'en_US-ryan-high'), 'the speaker list is told (so the new voice can be picked at once)');
  change(w, 'vp-use-en_US-ryan-high', 'claude'); await tick();
  const cfg = t.calls.filter((c) => c[0] === 'configure').pop();
  assert(cfg && cfg[1].voices.claude === 'en_US-ryan-high' && cfg[1].browserVoices.claude === '', '"Use for: Claude" saves Claude\'s voice');
  assert(/Claude now reads with this voice/.test($(w, 'vp-msg-en_US-ryan-high').textContent) && /reads for Claude/.test($(w, 'vp-row-en_US-ryan-high').textContent), 'and says so on the row');
  click(w, 'vp-dl-en_GB-alba-medium'); await tick();
  click(w, 'vp-cancel-en_GB-alba-medium'); await tick();
  assert(t.calls.some((c) => c[0] === 'cancel' && c[1] === 'en_GB-alba-medium'), '✕ Cancel stops that download');
  t = setup({ downloadFail: true }); await mount(t); w = t.w;
  click(w, 'vp-dl-en_US-ryan-high'); await tick(); t.hold.download(); await tick();
  assert(/isn't on the download site any more/.test($(w, 'vp-msg-en_US-ryan-high').textContent) && $(w, 'vp-msg-en_US-ryan-high').dataset.tone === 'error' && /⬇ Download/.test($(w, 'vp-dl-en_US-ryan-high').textContent), 'a failed download: plain message, ⬇ comes back');

  console.log('\n== ✨ Kokoro ==');
  t = setup(); await mount(t); w = t.w;
  assert(/Install best-quality voice \(Kokoro, ~350 MB\)/.test($(w, 'vp-kokoro-install').textContent), 'not installed: "Install best-quality voice (Kokoro, ~350 MB)"');
  assert(/processor by default/.test($(w, 'vp-kokoro').textContent) && /Nothing needs it/.test($(w, 'vp-kokoro').textContent), 'says it runs on the processor by default and is optional');
  click(w, 'vp-kokoro-install'); await tick();
  t.ui.downloadCb({ id: 'kokoro', phase: 'install', message: 'Step 1 of 2: installing the Kokoro engine (a few minutes)…' });
  assert(/Step 1 of 2/.test($(w, 'vp-pct-kokoro').textContent), 'install progress shows');
  t.ui.downloadCb({ id: 'kokoro', phase: 'progress', got: 100 * 1048576, total: 325532387 });
  assert(/^32% · 100 MB of 310 MB$/.test($(w, 'vp-pct-kokoro').textContent), 'then the download progress');
  t.hold.kokoro(); await tick(30);
  assert(!!$(w, 'vp-kokoro-use') && !$(w, 'vp-kokoro-use').checked, 'installed: "Use it" (off until ticked)');
  assert($(w, 'vp-kokoro-device').value === 'cpu', 'runs on the processor by default');
  $(w, 'vp-kokoro-use').checked = true; $(w, 'vp-kokoro-use').dispatchEvent(new w.Event('change'));
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].engine === 'kokoro'), 'ticking "Use it" switches read-aloud to Kokoro');
  change(w, 'vp-kokoro-device', 'gpu');
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].kokoroDevice === 'gpu'), 'the graphics card can be picked');
  assert($(w, 'vp-kokoro-voice-butler').value === 'bm_george' && $(w, 'vp-kokoro-voice-claude').value === 'am_michael', 'a different Kokoro voice per speaker by default');
  change(w, 'vp-kokoro-voice-claude', 'bm_fable');
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].kokoroVoices && c[1].kokoroVoices.claude === 'bm_fable'), 'a speaker\'s Kokoro voice is saved');
  click(w, 'vp-kokoro-test-claude'); await tick();
  assert(t.calls.some((c) => c[0] === 'synth' && c[1] === 'claude' && c[3] === 'bm_fable') && t.played.length === 1, '▶ plays that Kokoro voice');
  t = setup({ kokoroFail: true }); await mount(t); w = t.w;
  click(w, 'vp-kokoro-install'); await tick(); t.hold.kokoro(); await tick(30);
  assert(/Your other voices still work/.test($(w, 'vp-msg-kokoro').textContent) && !!$(w, 'vp-kokoro-install'), 'a failed install: plain words, the button comes back');

  console.log('\n== inside the 🔊 Voice box (voice-ui.js) ==');
  {
    const dom = new JSDOM(`<!doctype html><body><div id="voice-bar"></div><details><summary>🔊</summary><div id="voice-read-settings"></div></details></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w2 = dom.window;
    let piper = [];
    const audios = [];
    w2.Audio = function (src) { const a = { src, play() { setTimeout(() => a.onended && a.onended(), 5); return Promise.resolve(); }, pause() {}, removeAttribute() {}, load() {} }; audios.push(a); return a; };
    const t2 = setup();
    w2.api = Object.assign({}, t2.w.api, {
      voiceStatus: async () => ({ ok: true, voices: {}, browserVoices: {}, engine: 'piper' }),
      voicePiperVoices: async () => ({ ok: true, voices: piper.slice() }),
      voiceDownload: async (id) => { piper.push(id); return { ok: true, id }; },
    });
    w2.eval(SRC('voice-read.js')); w2.eval(SRC('voice-catalog.js')); w2.eval(SRC('voice-picker.js')); w2.eval(SRC('voice-ui.js'));
    const ui = w2.createVoiceUI({ win: w2, doc: w2.document, api: w2.api });
    await ui.init(); await tick(30);
    const settings = w2.document.getElementById('voice-read-settings');
    assert(!!settings.querySelector('#voice-picker') && !!settings.querySelector('#ra-voice-claude'), '"✨ Better voices" sits under the per-speaker voices');
    assert(/Better voices below/.test(w2.document.getElementById('vrs-note').textContent), 'with no piper voice, the note points to it');
    w2.document.getElementById('vp-dl-en_US-ryan-high').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
    await tick(40);
    const opts = [...w2.document.getElementById('ra-voice-claude').options].map((o) => o.value);
    assert(opts.includes('piper:en_US-ryan-high'), 'a voice just downloaded can be picked at once in each speaker\'s list');
    w2.document.getElementById('vp-play-en_US-ryan-high').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
    await tick(40);
    assert(audios.length === 1 && /^data:audio\/mpeg;base64,/.test(audios[0].src), '▶ plays through the one app speaker (⏹ stops it like any read-aloud)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
