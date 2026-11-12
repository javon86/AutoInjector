'use strict';
// test/voice-main.test.js — the REAL main.js (mock Electron) with the 🎤 / 🔊 IPC: voice:replies (one AI's
// replies, oldest first, previews only, no site-error notices) / voice:reply-text (full text, routing tags gone) /
// voice:transcribe against a fake voice shim (the words come back; the debug log has sizes, never the words) /
// no shim + no voice engine -> a plain message with a "Set up" fix / voice:synthesize falls back at once when
// there is no piper voice, and returns a WAV when there is / the control panel's session may use the mic
// (audio) but never the camera / the mic target + speed + built-in voices are saved like the other voice settings.
// Run: node test/voice-main.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_VIDEO_AUTOSTART = '0';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '30';
delete process.env.AUTOINJECTOR_VOICE_SPAWN;
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-main-'));
process.env.AUTOINJECTOR_SD_HOME = path.join(TMP, 'sdhome');
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
mock.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
const { startFakeVoiceShim } = require('./fixtures/fake-voice-shim');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

const SECRET_WORDS = 'purple elephant marmalade';
const transcript = [
  { id: 1, site: 'claude', label: 'Claude', text: '[TO: ChatGPT]\nFirst **answer** from Claude about the plan.\n[FROM: Claude]', ts: 1 },
  { id: 2, site: 'chatgpt', label: 'ChatGPT', text: 'ChatGPT says hi.', ts: 2 },
  { id: 3, site: 'claude', label: 'Claude', text: "You've reached your usage limit.", ts: 3, isRateLimited: true },
  { id: 4, site: 'claude', label: 'Claude', text: 'Second reply.\n```js\nconst x = 1;\n```\nSee https://example.com/a/b for more.', ts: 4 },
  { id: 5, site: 'claude', label: 'Claude', text: `Third reply with ${SECRET_WORDS}.`, ts: 5 },
];
fs.mkdirSync(mock.__userDataDir, { recursive: true });
fs.writeFileSync(path.join(mock.__userDataDir, 'autoinjector-state.json'), JSON.stringify({ transcript }));

(async () => {
  require('../main.js');
  await sleep(300);
  require('../output-manager').init(path.join(TMP, 'content'));
  const H = mock.__ipcHandlers;
  const call = (ch, ...a) => H[ch]({}, ...a);
  const voice = require('../voice-provider');
  const sent = [];
  const ui = mock.__registry['controls-ui'] || mock.__registry.controls || null;
  if (ui) ui.webContents.on('ipc-send', (channel, payload) => sent.push([channel, payload]));

  console.log('\n== the channels exist ==');
  const CH = ['voice:transcribe', 'voice:synthesize', 'voice:piper-voices', 'voice:replies', 'voice:reply-text'];
  assert(CH.every((c) => typeof H[c] === 'function'), `all ${CH.length} handlers registered`);

  console.log('\n== the control panel may use the microphone, never the camera ==');
  const ctl = ui && ui.webContents.session; // mock-electron gives each partition one session (with the permission setters)
  assert(!!(ctl && ctl.req && ctl.chk), 'the control panel\'s session got a permission request + check handler');
  if (ctl && ctl.req) {
    const ask = (perm, details) => new Promise((r) => ctl.req(null, perm, r, details));
    assert(await ask('media', { mediaTypes: ['audio'] }) === true, 'microphone: allowed');
    assert(await ask('media', { mediaTypes: ['video'] }) === false, 'camera: refused');
    assert(await ask('media', { mediaTypes: ['audio', 'video'] }) === false, 'microphone + camera together: refused');
    assert(await ask('clipboard-sanitized-write', {}) === true, 'other permissions keep the old default (allowed)');
    assert(ctl.chk(null, 'media', 'file://', { mediaType: 'audio' }) === true && ctl.chk(null, 'media', 'file://', { mediaType: 'video' }) === false, 'the permission check says the same');
  }
  const paneSessions = Object.values(mock.__sessions).filter((s) => s !== ctl && s.req);
  assert(paneSessions.length === 0, 'no AI pane session got a handler from this');

  console.log('\n== voice:replies / voice:reply-text ==');
  let r = await call('voice:replies', { site: 'claude' });
  assert(r.ok && r.count === 3 && r.items.map((x) => x.id).join(',') === '1,4,5', `Claude's replies, oldest first, without the usage-limit notice (${r.items && r.items.map((x) => x.id)})`);
  assert(r.items[0].n === 1 && r.items[0].preview.startsWith('First answer from Claude') && !/\[TO|\*\*/.test(r.items[0].preview), `previews are plain words ("${r.items[0].preview}")`);
  assert(r.items.every((x) => !('text' in x)), 'the list has previews only, not the full text');
  r = await call('voice:replies', { site: 'gemini' });
  assert(r.ok && r.count === 0 && r.items.length === 0, 'Gemini: none yet');
  r = await call('voice:replies', { site: 'nope' });
  assert(r.ok === false && r.error === 'BAD_SITE', 'a bad site -> BAD_SITE');
  r = await call('voice:reply-text', { id: 1 });
  assert(r.ok && r.site === 'claude' && /First \*\*answer\*\*/.test(r.text) && !/\[FROM:|\[TO:/.test(r.text), `full text by id, routing tags stripped ("${String(r.text).slice(0, 40)}")`);
  r = await call('voice:reply-text', { id: 999 });
  assert(r.ok === false && /isn't in the conversation/.test(r.message), 'an unknown id -> plain message');
  r = await call('voice:reply-text', 'x');
  assert(r.ok === false, 'nonsense id -> no throw');

  console.log('\n== voice:transcribe: no voice engine -> a plain message with a Set up button ==');
  voice.setSettings({ endpoint: `http://127.0.0.1:${await freePort()}` });
  r = await call('voice:transcribe', { audio: Buffer.from('x'.repeat(4000)).toString('base64'), mime: 'audio/webm' });
  assert(r.ok === false && r.error === 'VOICE_NOT_INSTALLED' && /Setup Wizard/.test(r.message) && r.fix && r.fix.action === 'open-setup', `"${r.message}"`);
  assert(!/ECONNREFUSED/.test(r.message), 'no raw error code in the message');
  r = await call('voice:transcribe', { audio: '', mime: 'audio/webm' });
  assert(r.ok === false && r.error === 'NEED_AUDIO' && /Nothing was recorded/.test(r.message), 'no audio -> plain message');
  r = await call('voice:transcribe', null);
  assert(r && r.ok === false, 'null args -> no throw');

  console.log('\n== voice:transcribe through the (fake) voice shim ==');
  const shim = await startFakeVoiceShim({ text: SECRET_WORDS });
  voice.setSettings({ endpoint: shim.base });
  const audio = Buffer.from('OggS' + 'z'.repeat(5000)).toString('base64');
  r = await call('voice:transcribe', { audio, mime: 'audio/webm' });
  assert(r.ok && r.text === SECRET_WORDS, `the words come back ("${r.text}")`);
  assert(shim.calls.some((c) => c.path === '/transcribe' && c.bytes === 5004 && c.mime === 'audio/webm'), 'the shim got the recording bytes + type');
  assert(sent.some(([ch, p]) => ch === 'voice-mic' && p && p.phase === 'downloading' && p.mb === 145), 'first use: the page is told the speech model downloads (about 145 MB)');
  r = await call('voice:transcribe', { audio: Buffer.from('SILENCE' + 'z'.repeat(3000)).toString('base64'), mime: 'audio/webm' });
  assert(r.ok && r.text === '', 'silence -> ok with no words (the page says "nothing was sent")');

  console.log('\n== voice:synthesize: no piper voice -> instant fallback; with one -> a WAV ==');
  r = await call('voice:synthesize', { text: 'Hello there.', who: 'claude' });
  assert(r.ok === false && r.fallback === true && r.error === 'NO_TTS_MODEL', `no piper voice -> fallback (${r.error})`);
  r = await call('voice:synthesize', { text: '   ' });
  assert(r.ok === false && r.error === 'NEED_TEXT', 'empty text -> NEED_TEXT');
  await shim.close();
  const shim2 = await startFakeVoiceShim({ piper: true });
  voice.setSettings({ endpoint: shim2.base, voices: { claude: 'en_GB-alan-medium' } });
  r = await call('voice:synthesize', { text: 'Hello there.', who: 'claude' });
  assert(r.ok && typeof r.audio === 'string' && Buffer.from(r.audio, 'base64').slice(0, 4).toString() === 'RIFF' && r.mime === 'audio/wav', 'a WAV comes back (base64)');
  assert(shim2.calls.some((c) => c.path === '/synthesize' && c.voice === 'en_GB-alan-medium'), 'with Claude\'s own piper voice');
  fs.mkdirSync(require('../output-manager').modelsDir('voice'), { recursive: true });
  for (const n of ['en_US-lessac-medium', 'en_GB-alan-medium', 'en_US-ryan-medium']) fs.writeFileSync(path.join(require('../output-manager').modelsDir('voice'), `${n}.onnx`), 'x');
  r = await call('voice:piper-voices');
  assert(r.ok && r.voices.length === 3 && r.defaults.butler === 'en_GB-alan-medium' && r.defaults.chatgpt === 'en_US-lessac-medium' && r.defaults.claude === 'en_US-ryan-medium', `piper voices in models/voice + a different default each (${JSON.stringify(r.defaults)})`);
  voice.setSettings({ voices: { claude: '', gemini: '' } });
  r = await call('voice:synthesize', { text: 'Hi.', who: 'gemini' });
  const gem = shim2.calls.filter((c) => c.path === '/synthesize').pop();
  assert(r.ok && gem && gem.voice && gem.voice !== 'en_US-lessac-medium', `no voice chosen for Gemini -> a default piper voice of its own (${gem && gem.voice})`);
  await shim2.close();

  console.log('\n== settings: mic target, speed, built-in voices are saved ==');
  r = await call('voice:configure', { micTarget: 'claude', rate: 1.3, browserVoices: { gemini: 'Microsoft Zira' } });
  assert(r.ok && r.micTarget === 'claude' && r.rate === 1.3 && r.browserVoices.gemini === 'Microsoft Zira', 'voice:configure takes them');
  r = await call('voice:configure', { micTarget: 'everyone', rate: 99 });
  assert(r.micTarget === 'claude' && r.rate === 2, 'a bad target is ignored; the speed is kept in range');
  await sleep(250);
  let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(mock.__userDataDir, 'autoinjector-state.json'), 'utf8')); } catch (_) {}
  assert(st.voiceConfig && st.voiceConfig.micTarget === 'claude' && st.voiceConfig.browserVoices && st.voiceConfig.browserVoices.gemini === 'Microsoft Zira', 'persisted in the app state like the other voice settings');

  console.log('\n== 🔊 Better voices: the list, ⬇ download, ▶ sample (only when pressed) ==');
  {
    const http = require('http');
    const cat = require('../voice-catalog');
    const BIG = Buffer.alloc(5000, 3);
    const JS = Buffer.from(JSON.stringify({ audio: { sample_rate: 22050 }, pad: 'p'.repeat(600) }));
    const hits = [];
    const dsrv = http.createServer((req, res) => {
      hits.push(req.url);
      if (/\.onnx$/.test(req.url) || /\.bin$/.test(req.url)) { res.writeHead(200, { 'Content-Length': BIG.length }); return res.end(BIG); }
      if (/\.json$/.test(req.url)) { res.writeHead(200, { 'Content-Length': JS.length }); return res.end(JS); }
      if (/\.mp3$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(Buffer.alloc(900, 9)); }
      res.writeHead(404); res.end();
    });
    await new Promise((ok) => dsrv.listen(0, '127.0.0.1', ok));
    const lb = `http://127.0.0.1:${dsrv.address().port}`;
    for (const v of cat.PIPER_VOICES) { v.sample = `${lb}/${v.id}/sample.mp3`; for (const f of v.files) { f.url = `${lb}/${f.name}`; if (!f.json) { f.bytes = BIG.length; f.minBytes = 1000; } } }
    for (const f of cat.KOKORO.files) { f.url = `${lb}/${f.name}`; f.bytes = BIG.length; f.minBytes = 1000; }
    const vdir = require('../output-manager').modelsDir('voice');
    r = await call('voice:catalog');
    assert(r.ok && r.voices.length === cat.PIPER_VOICES.length && r.voices.every((v) => v.installed === false && v.bytes > 0), 'the recommended voices are listed, none downloaded yet');
    assert(r.kokoro && r.kokoro.model === false && r.kokoro.approxMB === 350 && r.engine === 'piper', 'Kokoro: not installed, not used (piper is the default)');
    assert(hits.length === 0, 'opening the list fetched nothing from the internet');
    const id = 'en_US-ryan-high';
    sent.length = 0;
    r = await call('voice:download', { id });
    assert(r.ok && fs.existsSync(path.join(vdir, `${id}.onnx`)) && fs.existsSync(path.join(vdir, `${id}.onnx.json`)), 'pressing ⬇ downloads the voice and its settings into models/voice');
    assert(sent.some(([c, p]) => c === 'voice-download' && p.id === id && p.phase === 'done'), 'progress goes to the page (and "done")');
    r = await call('voice:catalog');
    assert(r.voices.find((v) => v.id === id).installed === true && r.defaults.claude === id, 'it now shows as downloaded, and Claude reads with it by default');
    r = await call('voice:download', { id: '../../evil' });
    assert(!r.ok && r.error === 'UNKNOWN_VOICE', 'only voices from the list can be downloaded');
    const before = hits.length;
    r = await call('voice:sample', { id: 'en_GB-alba-medium' });
    assert(r.ok && r.from === 'sample' && r.mime === 'audio/mpeg' && Buffer.from(r.audio, 'base64').length === 900, '▶ on a voice not downloaded yet plays its short published sample');
    assert(hits.length === before + 1 && !fs.readdirSync(vdir).some((f) => /alba/.test(f)), 'fetched once, kept in memory only (nothing saved)');
    const shim4 = await startFakeVoiceShim({ piper: true });
    voice.setSettings({ endpoint: shim4.base });
    r = await call('voice:sample', { id });
    assert(r.ok && r.from === 'voice' && shim4.calls.some((c) => c.path === '/synthesize' && c.voice === id), '▶ on a downloaded voice reads with that voice (no internet)');
    await shim4.close();

    console.log('\n== ✨ Kokoro: optional install, engine choice, fallback ==');
    const sm = require('../setup-manager');
    const realPip = sm.pipInstall, realResolve = sm.resolvePython;
    // 1) the voice engine is running and says which Python it is: Kokoro goes into exactly that one, then is checked
    const eng = await startFakeVoiceShim({ piper: true, kokoro: '', python: 'C:/AutoInjector/voice-env/python.exe' });
    voice.setSettings({ endpoint: eng.base });
    sm.pipInstall = async () => ({ ok: false, error: 'pip exited 1' });
    r = await call('voice:kokoro-install');
    assert(!r.ok && /Couldn't install the Kokoro engine/.test(r.message) && /still work/.test(r.message), 'a failed engine install says so plainly — the other voices still work');
    assert(!fs.existsSync(path.join(vdir, 'kokoro', 'kokoro-v1.0.onnx')), 'and nothing was downloaded');
    let pipAsked = null, pipInto = null;
    sm.pipInstall = async (pkgs, onP, o) => { pipAsked = pkgs; pipInto = o && o.python; onP('Collecting kokoro-onnx'); eng.options.kokoro = 'ready'; return { ok: true }; };
    r = await call('voice:kokoro-install');
    assert(r.ok && !r.unchecked && pipAsked && pipAsked.includes('kokoro-onnx'), 'Install: the kokoro-onnx package is installed and the voice engine then finds it');
    assert(pipInto && pipInto.cmd === 'C:/AutoInjector/voice-env/python.exe' && pipInto.pre.length === 0, `into the SAME Python the running voice engine reported (${pipInto && pipInto.cmd})`);
    assert(fs.existsSync(path.join(vdir, 'kokoro', 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(vdir, 'kokoro', 'voices-v1.0.bin')), 'then its model files go into models/voice/kokoro');
    // 2) installed, but the engine still can't import it (another Python): said plainly, not "installed"
    eng.options.kokoro = '';
    sm.pipInstall = async () => ({ ok: true });
    r = await call('voice:kokoro-install');
    assert(!r.ok && r.error === 'KOKORO_NOT_FOUND' && /still can't find the Kokoro engine/.test(r.message) && /other voices still work/.test(r.message), `the engine still can't find it -> plain words ("${r.message}")`);
    await eng.close();
    // 3) the voice engine isn't running: install into the Python the app starts it with (same lookup as the launch)
    voice.setSettings({ endpoint: `http://127.0.0.1:${await freePort()}` });
    sm.resolvePython = async () => ({ cmd: 'py', pre: ['-3.12'], version: '3.12', compatible: true });
    sm.pipInstall = async (pkgs, onP, o) => { pipInto = o && o.python; return { ok: true }; };
    pipInto = null;
    r = await call('voice:kokoro-install');
    assert(pipInto && pipInto.cmd === 'py' && pipInto.pre.join(' ') === '-3.12', `engine not running: installed into the Python the app launches the voice engine with (${pipInto && [pipInto.cmd, ...pipInto.pre].join(' ')})`);
    assert(r.ok && r.unchecked && /couldn't be checked/.test(r.message), 'and it says it could not be checked yet');
    sm.pipInstall = realPip; sm.resolvePython = realResolve;
    const shim5 = await startFakeVoiceShim({ piper: true, kokoro: 'ready' });
    voice.setSettings({ endpoint: shim5.base, engine: 'piper', voices: { claude: '' } });
    r = await call('voice:synthesize', { text: 'Hello.', who: 'claude' });
    assert(r.ok && r.engine === 'piper', 'installed but not switched on: piper still reads');
    await call('voice:configure', { engine: 'kokoro', kokoroVoices: { claude: 'bm_fable' } });
    r = await call('voice:synthesize', { text: 'Hello.', who: 'claude' });
    let kc = shim5.calls.filter((c) => c.path === '/synthesize').pop();
    assert(r.ok && r.engine === 'kokoro' && kc.kokoro_voice === 'bm_fable' && kc.device === 'cpu', 'switched on: Kokoro reads, with Claude\'s Kokoro voice, on the processor');
    await shim5.close();
    const shim6 = await startFakeVoiceShim({ piper: true, kokoro: 'fail' });
    voice.setSettings({ endpoint: shim6.base });
    r = await call('voice:synthesize', { text: 'Hello.', who: 'claude' });
    assert(r.ok && r.engine === 'piper' && /piper voice read it/.test(r.message), 'Kokoro breaks: a piper voice reads, and it says so');
    await shim6.close();
    const shim7 = await startFakeVoiceShim({ piper: false, kokoro: '' });
    voice.setSettings({ endpoint: shim7.base });
    r = await call('voice:synthesize', { text: 'Hello.', who: 'claude' });
    assert(!r.ok && r.fallback === true, 'nothing installed in the engine: the page falls back to the PC\'s voices');
    r = await call('voice:synthesize', { text: 'Hi.', who: 'claude', kokoroVoice: 'af_heart' });
    assert(!r.ok && r.error === 'NO_KOKORO', '▶ a Kokoro voice before Kokoro is ready: a plain "not installed"');
    await shim7.close();
    await call('voice:configure', { engine: 'piper' });
    dsrv.close();
  }

  console.log('\n== privacy: the log has codes and sizes, never the words ==');
  await sleep(150);
  let dbg = ''; try { dbg = fs.readFileSync(path.join(mock.__userDataDir, 'autoinjector-debug.log'), 'utf8'); } catch (_) {}
  assert(/voice-mic/.test(dbg) && /"step":"heard"/.test(dbg), 'the debug log notes that something was heard');
  assert(!dbg.includes('elephant') && !JSON.stringify(sent.filter(([c]) => c === 'log')).includes('elephant'), 'but never what was said or read');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
