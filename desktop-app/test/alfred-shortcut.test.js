'use strict';
// test/alfred-shortcut.test.js — 🎩 Alfred's side panel from main's side, with mock Electron
// (test/mock-electron.js). There is ONE place for his panel now: docked beside the app in the control
// panel (alfred-panel.js) — no separate window. This checks: Ctrl+Shift+A (Cmd+Shift+A on macOS) is
// recognised, and from ANY page of the app (a webContents made later: an AI pane, the Akọwe page …) it
// tells the control panel to show / hide the drawer — only while Alfred is on; alfred:panel /
// alfred:panel-toggle; no window is ever made; "Set up his AI"; personality + saved set-ups; and the
// read-only alfred:catalog ("❓ Everything I can do") and alfred:books (the big buttons' "is there a book?").
// Run: node test/alfred-shortcut.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
const { EventEmitter } = require('events');
const path = require('path');
const Module = require('module');
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
mock.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
const { isToggleShortcut, SHORTCUT_LABEL } = require('../alfred-main');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (o) => Object.assign({ type: 'keyDown', key: 'A', code: 'KeyA', control: false, meta: false, shift: false, alt: false }, o);

async function main() {
  console.log('\n== the shortcut: Ctrl+Shift+A (Cmd+Shift+A on macOS) ==');
  assert(isToggleShortcut(key({ control: true, shift: true }), 'linux') && isToggleShortcut(key({ control: true, shift: true, key: 'a' }), 'win32'), 'Ctrl+Shift+A on Windows / Linux');
  assert(isToggleShortcut(key({ meta: true, shift: true }), 'darwin') && !isToggleShortcut(key({ control: true, shift: true }), 'darwin'), 'Cmd+Shift+A on macOS (not Ctrl)');
  assert(!isToggleShortcut(key({ control: true }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, alt: true }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, type: 'keyUp' }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, key: 'b', code: 'KeyB' }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, isAutoRepeat: true }), 'linux'), 'not Ctrl+A, not with Alt, not key-up, not another key, not auto-repeat');
  assert(SHORTCUT_LABEL('darwin') === 'Cmd+Shift+A' && SHORTCUT_LABEL('win32') === 'Ctrl+Shift+A', 'the label names the right keys');

  console.log('\n== the REAL main.js (mock Electron): the side panel is the only place ==');
  require('../main.js');
  await sleep(300);
  const H = mock.__ipcHandlers;
  const call = (ch, payload) => H[ch]({}, payload);
  const windowsBefore = mock.__browserWindows.length;
  const controls = mock.__registry['controls-ui'];
  controls.webContents.removeAllListeners('ipc-send');
  const toControls = []; controls.webContents.on('ipc-send', (ch, pl) => { if (ch === 'alfred') toControls.push(pl); });
  assert((await call('alfred:status')).enabled === false, 'Alfred is off by default');
  let p = await call('alfred:panel');
  assert(p.ok && p.mode === 'docked' && /Shift\+A/.test(p.shortcut), `alfred:panel: the side panel (docked) and the shortcut (${p.shortcut})`);
  p = await call('alfred:panel', { mode: 'floating', otherApps: true });
  assert(p.mode === 'docked', 'an old "separate window" request is ignored — he stays docked');
  // Ctrl+Shift+A from a page made later (an AI pane, the Akọwe page …)
  const page = new EventEmitter();
  mock.__emitApp('web-contents-created', {}, page);
  let prevented = false;
  page.emit('before-input-event', { preventDefault() { prevented = true; } }, key({ control: true, shift: true }));
  assert(!prevented && !toControls.some((x) => x.type === 'toggle-panel'), 'while he is Off the key belongs to the page (nothing happens)');
  p = await call('alfred:panel-toggle', {});
  assert(p.ok === false && p.error === 'OFF' && /switch/.test(p.message), 'alfred:panel-toggle while Off: a plain answer');

  await call('alfred:set-enabled', { on: true });
  assert(mock.__browserWindows.length === windowsBefore, 'turning him on makes no window (his panel is the drawer in the control panel)');
  assert((await call('alfred:status')).settings.panel.mode === 'docked', 'his settings say docked');
  toControls.length = 0;
  page.emit('before-input-event', { preventDefault() { prevented = true; } }, key({ control: true, shift: true }));
  assert(prevented && toControls.some((x) => x.type === 'toggle-panel' && x.open === null), 'On: Ctrl+Shift+A in any page of the app tells the drawer to show / hide (the page never sees it)');
  toControls.length = 0;
  page.emit('before-input-event', { preventDefault() {} }, key({ control: true, shift: false }));
  assert(!toControls.length, 'Ctrl+A alone does nothing');
  toControls.length = 0;
  p = await call('alfred:panel-toggle', { open: true });
  assert(p.ok && p.docked && toControls.some((x) => x.type === 'toggle-panel' && x.open === true), 'alfred:panel-toggle {open:true} asks the drawer to open');
  p = await call('alfred:panel-toggle', { open: false });
  assert(toControls.some((x) => x.type === 'toggle-panel' && x.open === false), '… and {open:false} to close');
  toControls.length = 0;
  const sb = await call('alfred:show-butler');
  assert(sb.ok && toControls.some((x) => x.type === 'show-butler'), '"⚙ Set up his AI" asks the control panel to show the 🎩 Butler section');

  console.log('\n== personality + saved set-ups ==');
  const pr = await call('alfred:personality', { preset: 'witty', chattiness: 9 });
  assert(pr.ok && pr.personality.preset === 'witty' && pr.personality.chattiness === 5 && /1 to 5/.test(pr.message), 'alfred:personality saves (clamped, with a plain note)');
  const ps = await call('alfred:profile-save', { name: 'Witty local' });
  assert(ps.ok && ps.profiles.length === 1 && ps.activeProfile === 'Witty local', 'alfred:profile-save');
  assert((await call('alfred:profiles')).profiles[0].personality.preset === 'witty', 'alfred:profiles');
  assert((await call('alfred:profile-use', { name: 'nope' })).error === 'NOT_FOUND' && (await call('alfred:profile-use', { name: 'witty LOCAL' })).ok, 'alfred:profile-use (any case; a missing one -> NOT_FOUND)');
  assert((await call('alfred:profile-delete', { name: 'Witty local' })).profiles.length === 0, 'alfred:profile-delete');
  assert((await call('alfred:profile-save', {})).error === 'EMPTY_NAME', 'a nameless set-up is refused in plain words');

  console.log('\n== ❓ Everything I can do (alfred:catalog) and "is there a book?" (alfred:books) ==');
  const cat = await call('alfred:catalog');
  const titles = cat.groups.map((g) => `${g.icon} ${g.title}`);
  assert(cat.ok && titles.join('|') === '📖 Books|🧑 Characters & world|🎨 Pictures & covers|🎬 Video|💬 The three AIs|🧠 His AI & setup|📁 Files & folders|⚙ App settings & tools', `grouped for a person: ${titles.join(' · ')}`);
  const all = cat.groups.flatMap((g) => g.items);
  assert(all.length === cat.count && all.length > 150 && all.every((i) => i.title && i.say && i.example && !/\n/.test(i.say)), `every item (${all.length}) has a title, a one-line description and an example request`);
  const by = (id) => all.find((i) => i.id === id);
  assert(by('forge_character') && cat.groups[1].items.includes(by('forge_character')) && by('generate_image') && cat.groups[2].items.includes(by('generate_image')), 'tools land in their group (Character Forge → 🧑, pictures → 🎨)');
  assert(by('llm.check') && cat.groups[5].items.includes(by('llm.check')) && by('routing.set') && cat.groups[4].items.includes(by('routing.set')), 'app controls too (his AI check → 🧠, forwarding → 💬)');
  assert(!by('app_control') && !by('app_info') && !by('run_code'), 'no catch-all tools, and Open Interpreter only when it is turned on');
  const books = await call('alfred:books');
  assert(books.ok && books.akowe === false && books.books.length === 0 && /Akọwe/.test(books.message), 'alfred:books with Akọwe not running: says so plainly');

  await call('alfred:set-enabled', { on: false });
  toControls.length = 0;
  page.emit('before-input-event', { preventDefault() {} }, key({ control: true, shift: true }));
  assert(!toControls.some((x) => x.type === 'toggle-panel') && mock.__browserWindows.length === windowsBefore, 'Off again: the shortcut is the page\'s again, and still no window');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
