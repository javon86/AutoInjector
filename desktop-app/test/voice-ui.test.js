'use strict';
// test/voice-ui.test.js — 🎤 talk to the AIs + 🔊 read their replies (voice-ui.js) in jsdom with a stub window.api,
// a fake MediaRecorder / getUserMedia, a recording speechSynthesis and a fake Audio: the title-bar mic + target
// picker (🎩 Alfred only while he is on, the choice saved), a 🎤 in each pane header and ◀ 🔊 ▶ "n / m" beside
// 💬 Last reply; the counter moves and follows new replies; 🔊 reads with a piper WAV when there is one, else
// with this PC's voices (a different one per AI), ⏹ stops at once, one speaker at a time; the mic sends what was
// heard through the Compose send to the ticked AIs (or one AI from its pane, or Alfred), and says so; empty /
// silent / no engine / blocked mic / Esc / ✕ Cancel never send; the 🔊 settings save per speaker.
// Run: node test/voice-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const READ_SRC = fs.readFileSync(path.join(__dirname, '..', 'voice-read.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'voice-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
const SITES = ['chatgpt', 'claude', 'gemini'];

function paneHtml(site) {
  return `<div class="ai-col ${site}" id="col-${site}"><div class="control-strip"><div class="card-head"><span class="pane-name">${site}</span><span class="spacer"></span><button class="zoom-btn">－</button><span class="zoom-level">60%</span><button class="zoom-btn">＋</button><button class="reload-btn">⟳</button></div>
    <div class="locker-box"><div class="locker-tabs"><button id="locker-tab-${site}" class="active">📁 Locker</button><button id="reply-tab-${site}">💬 Last reply</button><span class="spacer"></span><button class="lk-refresh">↻</button></div></div></div></div>`;
}

function setup(over = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="window-titlebar"><span class="wt-name">AutoInjector</span><div id="app-tabs"></div><div id="voice-bar"></div><button id="btn-alfred-switch">🎩 Alfred: Off</button></div>
    <input type="checkbox" id="p-chatgpt" checked><input type="checkbox" id="p-claude" checked><input type="checkbox" id="p-gemini" checked><input type="checkbox" id="p-butler">
    ${SITES.map(paneHtml).join('')}
    <details id="sai"><summary>System AI</summary><details id="vbox"><summary>🔊 Voice</summary>
      <input id="voice-v-butler"><input id="voice-v-chatgpt"><input id="voice-v-claude"><input id="voice-v-gemini"><select id="voice-mic"><option value="">Default</option><option value="mic-2">USB mic</option></select>
      <div id="voice-read-settings"></div></details></details>
  </body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/controls.html' });
  const w = dom.window;
  const calls = [];
  const log = (...a) => calls.push(a);
  // the conversation
  const replies = {
    chatgpt: [{ id: 2, n: 1, preview: 'ChatGPT one' }],
    claude: [{ id: 1, n: 1, preview: 'Claude first' }, { id: 4, n: 2, preview: 'Claude second' }, { id: 5, n: 3, preview: 'Claude third' }],
    gemini: [],
  };
  const texts = { 1: 'First reply from Claude.', 2: 'Hi from ChatGPT. '.repeat(30), 4: 'Second **reply** from Claude.', 5: 'Third reply. ```\ncode\n```' };
  let captureCb = null, alfredCb = null, micCb = null;
  w.eval(READ_SRC);
  w.eval(UI_SRC); // before window.api exists, so it doesn't start by itself
  if (!over.quiet) assert(typeof w.createVoiceUI === 'function' && !w.VoiceUI, 'voice-ui.js loads (and waits for window.api to start by itself)');
  const st = { transcribe: over.transcribe || ((b64, mime) => ({ ok: true, text: 'please summarise chapter two' })), synth: over.synth || (() => ({ ok: false, error: 'NO_SHIM', fallback: true })) };
  w.api = {
    voiceStatus: async () => ({ ok: true, micTarget: over.micTarget || 'all', rate: 1, voices: { butler: '', chatgpt: '', claude: '', gemini: '' }, browserVoices: { butler: '', chatgpt: '', claude: '', gemini: '' }, micDevice: '' }),
    configureVoice: async (p) => { log('configure', p); return { ok: true }; },
    voicePiperVoices: async () => ({ ok: true, voices: over.piperVoices || [] }),
    voiceReplies: async (site) => { log('replies', site); return { ok: true, site, count: replies[site].length, items: replies[site].slice() }; },
    voiceReplyText: async (id) => { log('replyText', id); return texts[id] ? { ok: true, id, text: texts[id] } : { ok: false, message: "That reply isn't in the conversation any more." }; },
    voiceTranscribe: async (b64, mime) => { log('transcribe', b64.length, mime); if (st.transcribeHold) await st.transcribeHold; return st.transcribe(b64, mime); },
    voiceSynthesize: async (text, who) => { log('synth', who, text.length); return st.synth(text, who); },
    sendCompose: async (text, targets) => { log('send', text, targets.slice()); return { ok: true, results: Object.fromEntries(targets.map((t) => [t, over.sendFail && over.sendFail[t] ? { ok: false, error: over.sendFail[t] } : { ok: true }])) }; },
    alfredAsk: async (t) => { log('alfredAsk', t); return { ok: true }; },
    alfredStatus: async () => ({ enabled: !!over.alfredOn }),
    openWizard: (tab) => log('wizard', tab),
    uiLog: (a, d) => log('uiLog', a, d),
    onCapture: (cb) => { captureCb = cb; },
    onAlfred: (cb) => { alfredCb = cb; },
    onVoiceMic: (cb) => { micCb = cb; },
  };
  if (over.sendToAlfred) w.sendToAlfred = async (t) => log('sendToAlfred', t);
  // fake microphone
  const mic = { tracksStopped: 0, err: over.micError || null };
  w.navigator.mediaDevices = { getUserMedia: async (c) => { log('gum', c); if (mic.err) { const e = new Error('x'); e.name = mic.err; throw e; } return { getTracks: () => [{ stop: () => { mic.tracksStopped++; } }] }; } };
  class FakeRecorder {
    constructor(stream, o) { this.stream = stream; this.mimeType = (o && o.mimeType) || 'audio/webm'; this.state = 'inactive'; }
    static isTypeSupported(m) { return /^audio\/webm/.test(m); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      const size = over.tinyAudio ? 10 : 3000;
      setTimeout(() => { this.ondataavailable && this.ondataavailable({ data: new w.Blob([new Uint8Array(size).fill(65)], { type: 'audio/webm' }) }); this.onstop && this.onstop(); }, 5);
    }
  }
  w.MediaRecorder = FakeRecorder;
  // fake speechSynthesis (records what is said, finishes each piece after 30 ms unless cancelled)
  const spoken = [];
  const synthState = { pending: [], cancels: 0 };
  w.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const VOICES = over.noVoices ? [] : [
    { name: 'Microsoft David', lang: 'en-US', localService: true }, { name: 'Microsoft Zira', lang: 'en-US', localService: true },
    { name: 'Microsoft Mark', lang: 'en-US', localService: true }, { name: 'Microsoft George', lang: 'en-GB', localService: true },
  ];
  w.speechSynthesis = {
    getVoices: () => VOICES,
    addEventListener: () => {},
    speak: (u) => {
      spoken.push({ text: u.text, voice: u.voice && u.voice.name, rate: u.rate, pitch: u.pitch });
      if (over.noVoices) { setTimeout(() => u.onerror && u.onerror({ error: 'synthesis-failed' }), 5); return; }
      const t = setTimeout(() => { synthState.pending = synthState.pending.filter((x) => x !== t); u.onend && u.onend(); }, 30);
      synthState.pending.push(t);
      u._t = t;
    },
    cancel: () => { synthState.cancels++; for (const t of synthState.pending) clearTimeout(t); synthState.pending = []; },
  };
  const audios = [];
  w.Audio = function (src) { const a = { src, paused: true, playbackRate: 1, play() { a.paused = false; a._t = setTimeout(() => { a.paused = true; a.onended && a.onended(); }, 30); return Promise.resolve(); }, pause() { a.paused = true; clearTimeout(a._t); }, removeAttribute() {}, load() {} }; audios.push(a); return a; };
  const ui = w.createVoiceUI({ win: w, doc: w.document, api: w.api });
  return { w, ui, calls, replies, texts, spoken, synthState, audios, mic, st, capture: (t) => captureCb && captureCb(t), alfred: (p) => alfredCb && alfredCb(p), micEvent: (p) => micCb && micCb(p) };
}
const $ = (w, id) => w.document.getElementById(id);
const heard = (w) => { const e = $(w, 'voice-heard'); return e && !e.hidden ? e.textContent : ''; };
const click = (w, id) => $(w, id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

(async () => {
  console.log('\n== controls.html has the places and the scripts ==');
  assert(/<div id="voice-bar"/.test(HTML) && HTML.indexOf('id="voice-bar"') < HTML.indexOf('id="btn-alfred-switch"'), 'the 🎤 bar sits in the title bar, before the 🎩 switch');
  assert(/id="voice-read-settings"/.test(HTML), 'the 🔊 settings place is in the 🔊 Voice box');
  assert(/<script src="voice-read\.js"><\/script>[\s\S]*<script src="voice-ui\.js"><\/script>[\s\S]*<script src="alfred-panel\.js">/.test(HTML), 'voice-read.js, voice-ui.js load before alfred-panel.js');

  console.log('\n== buttons: title bar + every pane ==');
  let t = setup();
  await t.ui.init(); await tick(30);
  const { w } = t;
  assert(!!$(w, 'btn-voice-mic') && $(w, 'btn-voice-mic').textContent === '🎤', 'title bar: 🎤');
  const opts = [...$(w, 'voice-mic-target').options].map((o) => o.value);
  assert(opts.join(',') === 'all,chatgpt,claude,gemini', `target picker without Alfred while he is off (${opts})`);
  for (const s of SITES) {
    const pm = $(w, `voice-mic-${s}`);
    assert(pm && pm.parentNode.classList.contains('card-head') && pm.nextElementSibling.classList.contains('zoom-btn'), `${s}: 🎤 in the pane header, before the zoom buttons`);
    const g = $(w, `voice-read-${s}`);
    assert(g && g.previousElementSibling && g.previousElementSibling.id === `reply-tab-${s}` && ['◀', '🔊', '▶'].every((x, i) => g.children[i].textContent === x), `${s}: ◀ 🔊 ▶ beside 💬 Last reply`);
  }
  assert($(w, 'voice-count-claude').textContent === '3 / 3' && $(w, 'voice-count-gemini').textContent === '0 / 0', `counters: Claude "3 / 3", Gemini "0 / 0"`);
  assert(/Claude third/.test($(w, 'voice-play-claude').title) && $(w, 'voice-next-claude').disabled && !$(w, 'voice-prev-claude').disabled, 'newest selected; its first words in the tooltip; ▶ off at the newest');
  assert($(w, 'voice-play-gemini').disabled && $(w, 'voice-prev-gemini').disabled, 'no reply yet: the buttons are off');

  console.log('\n== ◀ ▶ move through the replies; new replies are followed ==');
  click(w, 'voice-prev-claude');
  assert($(w, 'voice-count-claude').textContent === '2 / 3' && /Claude second/.test($(w, 'voice-count-claude').title), '◀ -> "2 / 3"');
  click(w, 'voice-prev-claude'); click(w, 'voice-prev-claude');
  assert($(w, 'voice-count-claude').textContent === '1 / 3' && $(w, 'voice-prev-claude').disabled, 'stops at "1 / 3"');
  click(w, 'voice-next-claude');
  assert($(w, 'voice-count-claude').textContent === '2 / 3', '▶ -> "2 / 3"');
  t.replies.claude.push({ id: 7, n: 4, preview: 'Claude fourth' });
  t.capture({ site: 'claude', id: 7 }); await tick(20);
  assert($(w, 'voice-count-claude').textContent === '2 / 4', 'a new reply while on an older one: stays on it ("2 / 4")');
  click(w, 'voice-next-claude'); click(w, 'voice-next-claude');
  t.replies.claude.push({ id: 8, n: 5, preview: 'Claude fifth' });
  t.capture({ site: 'claude', id: 8 }); await tick(20);
  assert($(w, 'voice-count-claude').textContent === '5 / 5', 'on the newest: follows the new reply ("5 / 5")');
  t.replies.gemini.push({ id: 9, n: 1, preview: 'Gemini hello' });
  t.capture({ site: 'gemini', id: 9 }); await tick(20);
  assert($(w, 'voice-count-gemini').textContent === '1 / 1' && !$(w, 'voice-play-gemini').disabled, 'Gemini\'s first reply arrives: "1 / 1"');

  console.log('\n== 🔊 play with this PC\'s voices (no piper); ⏹ stops; one speaker at a time ==');
  click(w, 'voice-prev-claude'); click(w, 'voice-prev-claude'); click(w, 'voice-prev-claude'); // -> 2 / 5 (id 4)
  const p1 = t.ui.playReply('claude');
  await tick(15);
  assert($(w, 'voice-play-claude').textContent === '⏹' && $(w, 'voice-play-claude').classList.contains('on'), 'playing: 🔊 turns into ⏹');
  const out1 = await p1;
  assert(out1.ok && out1.engine === 'browser' && t.calls.some((c) => c[0] === 'replyText' && c[1] === 4), 'reads the SELECTED reply (id 4) with the built-in voice');
  assert(t.spoken.some((s) => s.text === 'Second reply from Claude.') && !t.spoken.some((s) => /\*\*/.test(s.text)), 'markdown marks are not read');
  const claudeVoice = t.spoken[t.spoken.length - 1].voice;
  assert($(w, 'voice-play-claude').textContent === '🔊', 'done: back to 🔊');
  t.spoken.length = 0;
  const p2 = t.ui.playReply('chatgpt'); // a long reply: many pieces
  await tick(45);
  assert(t.spoken.length >= 1 && t.spoken.length < 4, `long replies are read in pieces (${t.spoken.length} so far)`);
  const chatgptVoice = t.spoken[0].voice;
  assert(chatgptVoice && claudeVoice && chatgptVoice !== claudeVoice, `ChatGPT and Claude sound different (${chatgptVoice} / ${claudeVoice})`);
  click(w, 'voice-play-chatgpt'); // ⏹
  const out2 = await p2;
  const after = t.spoken.length;
  await tick(80);
  assert(out2.stopped && t.spoken.length === after && t.synthState.cancels > 0 && $(w, 'voice-play-chatgpt').textContent === '🔊', '⏹ stops at once (no more pieces)');
  t.texts[9] = 'Gemini says hello.';
  const p3 = t.ui.playReply('chatgpt'); await tick(10);
  const p4 = t.ui.playReply('gemini');
  assert((await p3).stopped, 'starting another AI stops the first');
  await p4;
  assert(t.spoken[t.spoken.length - 1].voice !== chatgptVoice, 'Gemini in its own voice');
  t.texts[9] = 'x'; delete t.texts[9];
  const gone = await t.ui.playReply('gemini');
  assert(!gone.ok && /isn't in the conversation/.test(heard(w)), 'a reply that is gone: a plain message');

  console.log('\n== 🔊 with a piper voice (WAV) ==');
  t = setup({ synth: () => ({ ok: true, audio: 'UklGRg==', mime: 'audio/wav' }) });
  await t.ui.init(); await tick(30);
  let out = await t.ui.playReply('claude');
  assert(out.ok && out.engine === 'piper' && t.audios.length >= 1 && /^data:audio\/wav;base64,/.test(t.audios[0].src) && t.spoken.length === 0, 'the WAV plays in the page, no built-in voice');
  assert(t.calls.some((c) => c[0] === 'synth' && c[1] === 'claude'), 'asked for Claude\'s voice');
  const pp = t.ui.playReply('chatgpt'); await tick(40);
  t.ui.speaker.stop();
  assert((await pp).stopped && t.audios.every((a) => a.paused), '⏹ pauses the WAV at once');

  console.log('\n== no voice at all -> a plain message ==');
  t = setup({ noVoices: true });
  await t.ui.init(); await tick(30);
  out = await t.ui.playReply('claude');
  assert(!out.ok && /no voice to read with/.test(heard(t.w)) && /Setup Wizard/.test(heard(t.w)), `"${heard(t.w).slice(0, 80)}…"`);

  console.log('\n== 🎤 title bar: record -> words -> sent to every ticked AI ==');
  t = setup();
  await t.ui.init(); await tick(30);
  $(t.w, 'p-gemini').checked = false;
  click(t.w, 'btn-voice-mic'); await tick(20);
  assert($(t.w, 'btn-voice-mic').classList.contains('rec') && /^⏺ 0:0\d$/.test($(t.w, 'btn-voice-mic').textContent), `recording: red with a timer ("${$(t.w, 'btn-voice-mic').textContent}")`);
  assert(/Listening/.test(heard(t.w)), 'the line says it is listening');
  await tick(600);
  click(t.w, 'btn-voice-mic');
  for (let i = 0; i < 30 && !t.calls.some((c) => c[0] === 'send'); i++) await tick(20);
  const tr = t.calls.find((c) => c[0] === 'transcribe');
  assert(tr && tr[1] === 4000 && tr[2] === 'audio/webm', `the recording goes to be transcribed (base64 ${tr && tr[1]} chars, ${tr && tr[2]})`);
  const send = t.calls.find((c) => c[0] === 'send');
  assert(send && send[1] === 'please summarise chapter two' && send[2].join(',') === 'chatgpt,claude', `sent through the Compose send to the ticked AIs (${send && send[2]})`);
  assert(/Heard: “please summarise chapter two” → sent to ChatGPT, Claude/.test(heard(t.w)), `"${heard(t.w)}"`);
  assert(t.mic.tracksStopped >= 1 && !$(t.w, 'btn-voice-mic').classList.contains('rec') && $(t.w, 'btn-voice-mic').textContent === '🎤', 'the microphone is released; 🎤 again');

  console.log('\n== 🎤 in a pane header: only that AI ==');
  t.calls.length = 0;
  click(t.w, 'voice-mic-gemini'); await tick(20);
  assert($(t.w, 'voice-mic-gemini').classList.contains('rec') && $(t.w, 'voice-mic-gemini').textContent === '⏺', 'that pane\'s 🎤 turns red');
  await tick(600);
  click(t.w, 'voice-mic-gemini');
  for (let i = 0; i < 30 && !t.calls.some((c) => c[0] === 'send'); i++) await tick(20);
  const s2 = t.calls.find((c) => c[0] === 'send');
  assert(s2 && s2[2].join(',') === 'gemini' && /sent to Gemini/.test(heard(t.w)) && !/ChatGPT|Claude/.test(heard(t.w)), 'sent to Gemini only (even though Gemini is not ticked for → All)');

  console.log('\n== a send that one AI refuses is reported plainly ==');
  t = setup({ sendFail: { claude: 'SITE_REPAIRING' } });
  await t.ui.init(); await tick(30);
  let r = await t.ui.deliver('hello all', 'all');
  assert(r.sent.join(',') === 'ChatGPT,Gemini' && /not sent to Claude \(you're showing AutoInjector its page right now\)/.test(heard(t.w)), `"${heard(t.w)}"`);
  $(t.w, 'p-chatgpt').checked = false; $(t.w, 'p-claude').checked = false; $(t.w, 'p-gemini').checked = false;
  t.calls.length = 0;
  r = await t.ui.deliver('anyone?', 'all');
  assert(!r.ok && !t.calls.some((c) => c[0] === 'send') && /no AI is ticked/.test(heard(t.w)), 'nobody ticked -> nothing sent, says why');

  console.log('\n== 🎩 Alfred as a target (only while he is on) ==');
  t = setup({ sendToAlfred: true, micTarget: 'butler' });
  await t.ui.init(); await tick(30);
  assert($(t.w, 'voice-mic-target').value === 'all', 'saved choice Alfred, but he is off: the picker shows All');
  t.alfred({ type: 'state', state: { enabled: true } });
  assert([...$(t.w, 'voice-mic-target').options].some((o) => o.value === 'butler') && $(t.w, 'voice-mic-target').value === 'butler', 'he turns on: 🎩 Alfred is in the picker (and chosen again)');
  r = await t.ui.deliver('what is on my list', 'butler');
  assert(t.calls.some((c) => c[0] === 'sendToAlfred' && c[1] === 'what is on my list') && !t.calls.some((c) => c[0] === 'send'), 'goes to Alfred through sendToAlfred (his panel), not to the AIs');
  const sel = $(t.w, 'voice-mic-target'); sel.value = 'claude'; sel.dispatchEvent(new t.w.Event('change'));
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].micTarget === 'claude') && t.w.localStorage.getItem('voice.micTarget') === 'claude', 'the choice is remembered');
  t.alfred({ type: 'state', state: { enabled: false } });
  assert(![...$(t.w, 'voice-mic-target').options].some((o) => o.value === 'butler'), 'he turns off: gone from the picker');
  $(t.w, 'p-butler').checked = true;
  t.calls.length = 0;
  await t.ui.deliver('to all and alfred', 'all');
  assert(t.calls.some((c) => c[0] === 'sendToAlfred') && t.calls.some((c) => c[0] === 'send'), 'All + his Active box ticked: him too (same as → All)');

  console.log('\n== nothing is sent when … ==');
  t = setup({ tinyAudio: true });
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(600); click(t.w, 'btn-voice-mic'); await tick(80);
  assert(!t.calls.some((c) => c[0] === 'transcribe' || c[0] === 'send') && /didn't hear anything/.test(heard(t.w)), '… the recording is empty');
  t = setup();
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(100); click(t.w, 'btn-voice-mic'); await tick(80);
  assert(!t.calls.some((c) => c[0] === 'send') && /didn't hear anything/.test(heard(t.w)), '… it was too short');
  t = setup({ transcribe: () => ({ ok: true, text: ' . ' }) });
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(600); click(t.w, 'btn-voice-mic'); await tick(120);
  assert(!t.calls.some((c) => c[0] === 'send') && /didn't catch any words/.test(heard(t.w)), '… it heard no words (silence)');
  t = setup({ transcribe: () => ({ ok: false, error: 'VOICE_NOT_INSTALLED', message: 'Talking to the AIs needs the free voice engine on this PC (it works offline). Install it once: Setup Wizard → Installs → "Voice engine".', fix: { action: 'open-setup' } }) });
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(600); click(t.w, 'btn-voice-mic'); await tick(120);
  const setupBtn = [...$(t.w, 'voice-heard').querySelectorAll('button')].find((b) => /Set up/.test(b.textContent));
  assert(!t.calls.some((c) => c[0] === 'send') && /needs the free voice engine/.test(heard(t.w)) && !/VOICE_NOT|ECONN/.test(heard(t.w)) && !!setupBtn, '… the voice engine is missing: plain words + 🧙 Set up');
  setupBtn.click();
  assert(t.calls.some((c) => c[0] === 'wizard' && c[1] === 'advanced'), '🧙 Set up opens the Setup Wizard on Installs');
  t = setup({ micError: 'NotAllowedError' });
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(40);
  assert(/microphone is blocked/.test(heard(t.w)) && /Privacy & security/.test(heard(t.w)) && !$(t.w, 'btn-voice-mic').classList.contains('rec'), '… the microphone is blocked (says where to allow it)');
  t = setup({ micError: 'NotFoundError' });
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(40);
  assert(/No microphone was found/.test(heard(t.w)), '… there is no microphone');
  t = setup();
  await t.ui.init(); await tick(30);
  click(t.w, 'btn-voice-mic'); await tick(600);
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(80);
  assert(!t.calls.some((c) => c[0] === 'transcribe' || c[0] === 'send') && /Stopped — nothing was sent/.test(heard(t.w)) && t.mic.tracksStopped >= 1, '… Esc stops the recording');
  t = setup();
  await t.ui.init(); await tick(30);
  let release; t.st.transcribeHold = new Promise((res) => { release = res; });
  click(t.w, 'btn-voice-mic'); await tick(600); click(t.w, 'btn-voice-mic'); await tick(60);
  assert(/Working out what you said/.test(heard(t.w)) && $(t.w, 'btn-voice-mic').textContent === '⏳', 'transcribing: says so, with ✕ Cancel');
  t.micEvent({ phase: 'downloading', mb: 145 });
  assert(/first time it downloads it \(about 145 MB\)/.test(heard(t.w)), `first use: "${heard(t.w).slice(0, 90)}…"`);
  [...$(t.w, 'voice-heard').querySelectorAll('button')].find((b) => /Cancel/.test(b.textContent)).click();
  release(); await tick(60);
  assert(!t.calls.some((c) => c[0] === 'send') && /Cancelled — nothing was sent/.test(heard(t.w)), '… ✕ Cancel while it is still transcribing');

  console.log('\n== 🔊 settings: a voice per speaker + speed ==');
  t = setup({ piperVoices: ['en_US-lessac-medium', 'en_GB-alan-medium'] });
  await t.ui.init(); await tick(30);
  const selC = $(t.w, 'ra-voice-claude');
  const vals = [...selC.options].map((o) => o.value);
  assert(vals[0] === '' && vals.includes('piper:en_GB-alan-medium') && vals.includes('pc:Microsoft David'), 'each speaker: Automatic · piper voices · this PC\'s voices');
  selC.value = 'piper:en_GB-alan-medium'; selC.dispatchEvent(new t.w.Event('change'));
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].voices && c[1].voices.claude === 'en_GB-alan-medium' && c[1].browserVoices.claude === '') && $(t.w, 'voice-v-claude').value === 'en_GB-alan-medium', 'picking a piper voice saves it (and fills the old field)');
  const selG = $(t.w, 'ra-voice-gemini'); selG.value = 'pc:Microsoft Zira'; selG.dispatchEvent(new t.w.Event('change'));
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].browserVoices && c[1].browserVoices.gemini === 'Microsoft Zira'), 'picking a built-in voice saves it');
  const rate = $(t.w, 'ra-rate'); rate.value = '1.3'; rate.dispatchEvent(new t.w.Event('change'));
  assert(t.calls.some((c) => c[0] === 'configure' && c[1].rate === 1.3), 'speed is saved');
  t.calls.length = 0;
  out = await t.ui.testVoice('gemini');
  const lastSaid = t.spoken[t.spoken.length - 1] || {};
  assert(out.ok && !t.calls.some((c) => c[0] === 'synth') && lastSaid.voice === 'Microsoft Zira', 'Test voice: Gemini speaks with the built-in voice picked for him (piper not asked)');
  assert(Math.abs(lastSaid.rate - 1.3 * t.w.VoiceRead.STYLE.gemini.rate) < 0.01 && lastSaid.pitch === t.w.VoiceRead.STYLE.gemini.pitch, `at the chosen speed × his own pace and pitch (${lastSaid.rate})`);
  t.ui.openVoiceSettings();
  assert($(t.w, 'vbox').open && $(t.w, 'sai').open, '🔊 Voices opens the Voice box');

  console.log('\n== 🎩 Alfred\'s messages: a 🔊 that reads them ==');
  const b = t.ui.speakButton(() => 'Good day, **sir**.', 'butler');
  t.w.document.body.append(b);
  b.click(); await tick(10);
  assert(b.dataset.icon === '⏹' && b.textContent === '' && t.spoken[t.spoken.length - 1].text === 'Good day, sir.', 'reads his message in his voice; the button shows ⏹ (drawn by CSS, so his message text stays his words)');
  b.click(); await tick(10);
  assert(b.dataset.icon === '🔊', 'click again: stops');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
