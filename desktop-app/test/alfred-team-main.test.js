'use strict';
// test/alfred-team-main.test.js — 👥 Alfred's team in the REAL main.js (mock Electron) against the fake Ollama
// (test/fixtures/fake-ollama.js) on the app's port and a fake nvidia-smi (an RTX 5070 Ti, 16 GB):
//   alfred:team (roles ✔ / ⚪ / ⚠, the "team ready" line, ★ ratings, the graphics card), alfred:team-set,
//   alfred:team-best (no downloads), alfred:ask routed to the Bad boy / the Director (plan → card → alfred:confirm →
//   the Butler's report), the VRAM guard unloading a big model through Ollama before another big one answers,
//   "who answered" on the "alfred" channel, and the activity log (codes only, never the words).
// Run: node test/alfred-team-main.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_VIDEO_AUTOSTART = '0';
process.env.AUTOINJECTOR_HEALTH = '0';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '30';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-team-main-'));
process.env.AUTOINJECTOR_SD_HOME = path.join(TMP, 'sdhome');
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
// a fake nvidia-smi: this PC has the user's card
const SMI = path.join(TMP, process.platform === 'win32' ? 'nvidia-smi.cmd' : 'nvidia-smi');
fs.writeFileSync(SMI, process.platform === 'win32' ? '@echo NVIDIA GeForce RTX 5070 Ti, 16303\r\n' : '#!/bin/sh\necho "NVIDIA GeForce RTX 5070 Ti, 16303"\n');
try { fs.chmodSync(SMI, 0o755); } catch (_) {}
process.env.NVIDIA_SMI = SMI;
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
mock.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
const { fakeOllama } = require('./fixtures/fake-ollama');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const GB = 1024 ** 3;

(async () => {
  const port = await freePort();
  process.env.AUTOINJECTOR_OLLAMA_HOST = `127.0.0.1:${port}`;
  const fo = fakeOllama(port);
  fo.st.models = [{ name: 'qwen2.5:14b', size: Math.round(9 * GB) }, { name: 'qwen3:14b', size: Math.round(9.3 * GB) }, { name: 'dolphin3:8b', size: Math.round(4.9 * GB) }];
  fo.st.chat = (j) => {
    const sys = String((j.messages[0] || {}).content || '');
    const last = j.messages[j.messages.length - 1] || {};
    if (/You are the Director/.test(sys)) return { content: '{"steps":[{"role":"butler","task":"Say hello to the author"},{"role":"prompt","task":"make a picture of a red fox"}]}' };
    if (/Prompt writer in Alfred's team/.test(sys)) return { content: 'a red fox in fresh snow, golden hour, watercolour' };
    if (/the "bad boy" of Alfred's team/.test(sys)) return { content: 'Filthy, frank and funny.' };
    if (/team just finished/.test(sys)) return { content: 'Done: I greeted you and the fox picture is ready.' };
    if (last.role === 'tool') return { content: 'All good.' };
    return { content: 'Hello from the Butler.' };
  };
  await fo.up();

  require('../main.js');
  await sleep(300);
  require('../output-manager').init(path.join(TMP, 'content'));
  const H = mock.__ipcHandlers;
  const call = (ch, ...a) => H[ch]({}, ...a);
  const logs = []; const alfredEvents = [];
  const ui = mock.__registry['controls-ui'] || mock.__registry.controls || null;
  if (ui) ui.webContents.on('ipc-send', (channel, payload) => { if (channel === 'log') logs.push(payload); if (channel === 'alfred') alfredEvents.push(payload); });

  console.log('\n== the alfred:team* channels ==');
  assert(['alfred:team', 'alfred:team-set', 'alfred:team-best'].every((c) => typeof H[c] === 'function'), 'registered');
  await call('alfred:set-enabled', { on: true });
  await call('alfred:settings', { brain: 'local', local: { endpoint: `http://127.0.0.1:${port}/v1`, model: 'qwen2.5:14b' } });

  console.log('\n== alfred:team — the roles, the line, the graphics card ==');
  let st = await call('alfred:team');
  assert(st.ok && st.enabled && st.local && st.ollama && st.models.length === 3, `the downloaded models (${st.models && st.models.map((m) => m.name).join(', ')})`);
  assert(st.hw && st.hw.vramMB === 16303 && /5070 Ti/.test(st.hw.gpu), `the card from nvidia-smi: ${JSON.stringify(st.hw)}`);
  assert(st.roles.length === 5 && st.roles[0].id === 'butler' && st.roles[0].state === 'ok' && st.roles.slice(1).every((r) => r.state === 'unset' && r.model === 'qwen2.5:14b'), 'one model: the Butler ✔, the others ⚪ use his model');
  assert(/^🎩 Alfred's team is connected and working for your book: Butler ✔ · Assistant ⚪ · Director ⚪ · Prompt writer ⚪ · Bad boy ⚪$/.test(st.line.text), st.line.text);
  const bb = st.roles.find((r) => r.id === 'badboy');
  assert(bb.suggestion && bb.suggestion.model === 'dolphin3:8b' && bb.ratings['dolphin3:8b'].stars > bb.ratings['qwen2.5:14b'].stars, `💡 the Bad boy: ${JSON.stringify(bb.suggestion)}`);

  console.log('\n== alfred:team-set / alfred:team-best (nothing downloaded) ==');
  st = await call('alfred:team-set', { role: 'badboy', model: 'dolphin3:8b' });
  assert(st.ok && st.roles.find((r) => r.id === 'badboy').state === 'ok' && /Bad boy ✔/.test(st.line.text), 'the Bad boy has dolphin3:8b');
  st = await call('alfred:team-best');
  const s = (await call('alfred:status')).settings;
  assert(st.ok && s.team.director.model === 'qwen3:14b' && s.team.badboy.model === 'dolphin3:8b' && fo.st.pulls.length === 0, `Pick the best: ${st.message}`);

  console.log('\n== alfred:ask → the Bad boy (named) ==');
  fo.st.loaded = []; fo.st.unloads = [];
  let r = await call('alfred:ask', { text: 'bad boy, roast my villain' });
  assert(r.ok && r.text === 'Filthy, frank and funny.', 'he answered');
  const lastChat = fo.st.apiChats[fo.st.apiChats.length - 1];
  assert(lastChat.model === 'dolphin3:8b' && !lastChat.tools, 'on dolphin3:8b, without tools');
  const msgEv = alfredEvents.filter((e) => e.type === 'message' && e.message.role === 'alfred').pop();
  assert(msgEv && msgEv.message.by && msgEv.message.by.name === 'Bad boy' && msgEv.message.by.model === 'dolphin3:8b', 'the "alfred" channel carries who answered');

  console.log('\n== alfred:ask → the Director (named): plan → Butler step → Prompt writer card → confirm → report ==');
  fo.st.loaded = ['qwen2.5:14b']; fo.st.unloads = [];
  r = await call('alfred:ask', { text: 'director, greet me and then make a picture of a red fox' });
  assert(r.ok && r.type === 'confirm' && r.card.steps[0].tool === 'generate_image' && /red fox in fresh snow/.test(r.card.steps[0].text), `the plan reached the picture card (${r.type})`);
  assert(fo.st.unloads.includes('qwen2.5:14b'), `VRAM guard: qwen2.5:14b was unloaded before qwen3:14b answered (${JSON.stringify(fo.st.unloads)})`);
  const dirIdx = fo.st.apiChats.findIndex((c) => c.model === 'qwen3:14b');
  assert(dirIdx >= 0 && fo.st.apiChats[dirIdx].keep_alive === '5m', 'the Director\'s model: keep_alive 5m');
  r = await call('alfred:reject', { id: r.card.id });
  assert(r.ok && /I didn't do that/.test(r.text) && !(await call('alfred:status')).busy, `✖ No on the plan's last step: nothing made, nothing waits (${r.text})`);
  r = await call('alfred:ask', { text: 'director, greet me and then make a picture of a red fox' });
  // the Images module isn't set up in this test: the picture step fails in plain words, then the Butler reports
  const d = await call('alfred:confirm', { id: r.card.id, alwaysAllow: [] });
  assert(d.ok && d.text === 'Done: I greeted you and the fox picture is ready.', `after ✔ the Butler reports back: ${d.text}`);
  const chat = (await call('alfred:status')).chat;
  assert(chat.some((m) => m.role === 'alfred' && m.by && m.by.role === 'director' && /Here is the plan/.test(m.text)) && chat.some((m) => m.role === 'alfred' && m.text === 'Hello from the Butler.' && m.by.role === 'butler'), 'the plan (🎬) and the Butler\'s step are in his chat, each with who');

  console.log('\n== the activity log: codes only ==');
  const kinds = logs.map((l) => l.kind);
  assert(['alfred-team', 'alfred-team-set', 'alfred-team-plan', 'alfred-team-vram', 'alfred-team-done'].every((k) => kinds.includes(k)), `logged: ${[...new Set(kinds.filter((k) => /^alfred-team/.test(k)))].join(', ')}`);
  assert(!logs.some((l) => /alfred/.test(l.kind) && /roast|villain|red fox|Filthy|greet/i.test(JSON.stringify(l.detail))), 'never the words asked or written');
  assert(logs.filter((l) => /^alfred-team/.test(l.kind)).every((l) => l.tag === 'manager'), 'tagged with Alfred\'s other events');

  console.log('\n== Ollama stops: ⚠ with a plain fix ==');
  await fo.down();
  st = await call('alfred:team');
  assert(st.ok && !st.ollama && st.line.tone === 'warn' && /Ollama isn't running — press 🛠 Set up his AI/.test(st.line.text), st.line.text);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
