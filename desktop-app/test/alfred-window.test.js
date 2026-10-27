'use strict';
// test/alfred-window.test.js — 🎩 Alfred's floating side panel window (alfred-window.js) with the mock
// Electron BrowserWindow (test/mock-electron.js): bounds are clamped to a visible display (and snap to
// the main window's right edge the first time), the modes (Floating = a window, Docked = no window),
// parent (over the app) vs "stay on top of other programs" (alwaysOnTop 'floating', not parented),
// it never takes focus on its own, closing hides it (Alfred stays on), Ctrl/Cmd+Shift+A toggles it
// from any page, bounds are remembered; then the REAL main.js under mock Electron: the window follows
// Alfred's switch and mode, gets the same "alfred" events as the control panel, and the new IPC.
// Run: node test/alfred-window.test.js
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
const { createAlfredWindow, clampBounds, defaultBounds, isToggleShortcut, MIN_W, MIN_H } = require('../alfred-window');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONE = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const TWO = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }];
const key = (o) => Object.assign({ type: 'keyDown', key: 'A', code: 'KeyA', control: false, meta: false, shift: false, alt: false }, o);

/** A window manager over fake settings and a fake main window. */
function rig({ enabled = true, panel = {}, platform = 'linux', main } = {}) {
  const s = { enabled, panel: Object.assign({ mode: 'floating', otherApps: false, open: true, bounds: null }, panel) };
  const mainWin = main === null ? null : (main || new mock.BaseWindow({ width: 1700, height: 1050 }));
  if (mainWin) mainWin.setBounds({ x: 100, y: 50, width: 1700, height: 1000 });
  const saved = []; const docked = []; const logs = [];
  const before = mock.__browserWindows.length;
  const m = createAlfredWindow({
    BrowserWindow: mock.BrowserWindow, screen: mock.screen, platform, getMainWindow: () => mainWin,
    getSettings: () => s, setPanel: (patch, opts) => { saved.push({ patch, opts: opts || {} }); s.panel = Object.assign({}, s.panel, patch); return s.panel; },
    htmlFile: '/x/alfred-window.html', preload: '/x/alfred-window-preload.js', log: (k, d) => logs.push({ k, d }),
    toggleDocked: (open) => docked.push(open), saveDelayMs: 0,
  });
  const made = () => mock.__browserWindows.slice(before);
  return { m, s, mainWin, saved, docked, logs, made };
}

async function main() {
  console.log('\n== bounds: clamped to a visible display ==');
  {
    const r = clampBounds({ x: 100, y: 100, width: 400, height: 700 }, ONE, null);
    assert(r.x === 100 && r.y === 100 && r.width === 400 && r.height === 700, 'bounds fully on a screen are kept as they are');
    const off = clampBounds({ x: 5000, y: 3000, width: 400, height: 700 }, ONE, { x: 1500, y: 40, width: 400, height: 900 });
    assert(off.x === 1500 && off.y === 40, 'bounds on no screen (a monitor that was unplugged) -> the default place');
    const edge = clampBounds({ x: 1800, y: 900, width: 400, height: 700 }, ONE, null);
    assert(edge.x === 1920 - 400 && edge.y === 1040 - 700, 'a panel hanging off the edge is pulled fully inside the screen');
    const huge = clampBounds({ x: 0, y: 0, width: 5000, height: 5000 }, ONE, null);
    assert(huge.width === 1920 && huge.height === 1040, 'a panel bigger than the screen is shrunk to it');
    const second = clampBounds({ x: 2400, y: 100, width: 400, height: 700 }, TWO, null);
    assert(second.x === 2400 && second.y === 100, 'a panel on the second monitor stays there');
    const sliver = clampBounds({ x: 1900, y: 100, width: 400, height: 700 }, ONE, { x: 10, y: 10, width: 400, height: 700 });
    assert(sliver.x === 10, 'only a sliver on screen (< 80 px) -> the default place');
    assert(clampBounds({ x: 'a', y: 1 }, ONE, { x: 10, y: 20, width: 400, height: 600 }).x === 10 && clampBounds(null, ONE, null) === null, 'garbage bounds -> the default (or null)');
    const tiny = clampBounds({ x: 10, y: 10, width: 50, height: 40 }, ONE, null);
    assert(tiny.width === MIN_W && tiny.height === MIN_H, `too small -> at least ${MIN_W}×${MIN_H}`);
    const d = defaultBounds({ x: 100, y: 50, width: 1700, height: 1000 }, ONE);
    assert(d.x + d.width === 100 + 1700 - 12 && d.y > 50 && d.y + d.height <= 50 + 1000, `the first place: against the main window's right edge, inside it (${JSON.stringify(d)})`);
  }

  console.log('\n== the shortcut: Ctrl+Shift+A (Cmd+Shift+A on macOS) ==');
  assert(isToggleShortcut(key({ control: true, shift: true }), 'linux') && isToggleShortcut(key({ control: true, shift: true, key: 'a' }), 'win32'), 'Ctrl+Shift+A on Windows / Linux');
  assert(isToggleShortcut(key({ meta: true, shift: true }), 'darwin') && !isToggleShortcut(key({ control: true, shift: true }), 'darwin'), 'Cmd+Shift+A on macOS (not Ctrl)');
  assert(!isToggleShortcut(key({ control: true }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, alt: true }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, type: 'keyUp' }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, key: 'b', code: 'KeyB' }), 'linux') && !isToggleShortcut(key({ control: true, shift: true, isAutoRepeat: true }), 'linux'), 'not Ctrl+A, not with Alt, not key-up, not another key, not auto-repeat');

  console.log('\n== Floating (the default): a frameless child of the main window, over the app ==');
  {
    const { m, mainWin, made, saved } = rig();
    const st = m.sync();
    const w = made()[0];
    assert(made().length === 1 && st.exists && st.visible, 'Alfred on + Floating -> his panel window exists and is shown');
    assert(w.opts.parent === mainWin && w.getParentWindow() === mainWin && !w.isAlwaysOnTop(), 'it is a child of the main window (stays above the app, moves with it), not on top of other programs');
    assert(w.opts.frame === false && w.opts.resizable === true && w.opts.skipTaskbar === true, 'frameless, resizable, not in the taskbar');
    assert(w.opts.webPreferences.contextIsolation === true && w.opts.webPreferences.nodeIntegration === false && /alfred-window-preload\.js$/.test(w.opts.webPreferences.preload) && /alfred-window\.html$/.test(w.webContents.getURL()), 'loads alfred-window.html with its own preload, isolated');
    assert(w.calls.includes('showInactive') && !w.calls.includes('focus') && !w.calls.includes('show'), 'appearing on its own never takes focus from the AI panes (showInactive)');
    assert(w.getBounds().x + w.getBounds().width === mainWin.getBounds().x + mainWin.getBounds().width - 12, 'first time: snapped to the main window\'s right edge');
    m.sync(); m.sync();
    assert(made().length === 1, 'syncing again does not make a second window');
    assert(m.send('alfred', { type: 'state', state: { x: 1 } }) && w.webContents.sentLog.some((x) => x.channel === 'alfred' && x.payload.type === 'state'), 'Alfred\'s events reach the window');
    w.setBounds({ x: 300, y: 120, width: 420, height: 640 });
    await sleep(20);
    const b = saved.filter((x) => x.patch.bounds).pop();
    assert(b && b.patch.bounds.x === 300 && b.patch.bounds.width === 420 && b.opts.quiet === true, 'moving / resizing remembers the bounds (quietly, no UI refresh)');

    console.log('\n== closing hides it; Alfred stays on ==');
    w.close();
    assert(!w.isDestroyed() && !w.isVisible(), 'closing the window only hides it');
    assert(saved.some((x) => x.patch.open === false), 'and remembers it is hidden');
    let t = m.toggle(undefined);
    assert(t.visible && w.calls.filter((c) => c === 'show').length === 1 && w.calls.includes('focus') && made().length === 1, 'toggling brings the same window back — focused, because you asked for it');
    t = m.toggle(undefined);
    assert(!t.visible && !w.isDestroyed(), 'toggling again hides it');
    t = m.toggle(true);
    assert(t.visible, 'toggle(true) shows it');

    console.log('\n== the shortcut from any page ==');
    const page = new EventEmitter();
    m.attachShortcut(page); m.attachShortcut(page);
    assert(page.listenerCount('before-input-event') === 1, 'each page is hooked once');
    let prevented = 0;
    const ev = () => ({ preventDefault: () => { prevented++; } });
    page.emit('before-input-event', ev(), key({ control: true, shift: true }));
    assert(!w.isVisible() && prevented === 1, 'Ctrl+Shift+A in a page hides the panel (and the page never sees the key)');
    page.emit('before-input-event', ev(), key({ control: true, shift: true }));
    assert(w.isVisible() && prevented === 2, 'Ctrl+Shift+A again shows it');
    page.emit('before-input-event', ev(), key({ control: true }));
    assert(w.isVisible() && prevented === 2, 'other keys are left alone');
  }
  {
    const { m, made, s } = rig({ enabled: false });
    const page = new EventEmitter(); m.attachShortcut(page);
    let prevented = 0;
    page.emit('before-input-event', { preventDefault: () => { prevented++; } }, key({ control: true, shift: true }));
    assert(prevented === 0 && made().length === 0, 'Alfred off: the shortcut does nothing and the key stays with the page');
    assert(m.sync().exists === false && made().length === 0, 'Alfred off: no window');
    assert(m.toggle().error === 'OFF', 'toggle while off says OFF');
    s.enabled = true; m.sync();
    assert(made().length === 1, 'turning him on makes it');
    s.enabled = false; m.sync();
    assert(made()[0].isDestroyed(), 'turning him off destroys it');
  }
  {
    const { m, made, s, docked } = rig({ panel: { mode: 'docked' } });
    assert(m.sync().exists === false && made().length === 0, 'Docked: no window (the drawer in the control panel is used, as before)');
    m.onInput({ preventDefault() {} }, key({ control: true, shift: true }));
    assert(docked.length === 1 && made().length === 0, 'Docked: the shortcut toggles the drawer instead');
    s.panel.mode = 'floating'; m.sync();
    assert(made().length === 1 && made()[0].isVisible(), 'switching to Floating makes the window');
    s.panel.mode = 'docked'; m.sync();
    assert(made()[0].isDestroyed(), 'switching back to Docked removes it');
  }

  console.log('\n== "Stay on top of other programs too" ==');
  {
    const { m, made, s, mainWin } = rig({ panel: { otherApps: true } });
    m.sync();
    const w = made()[0];
    assert(!w.opts.parent && w.isAlwaysOnTop() && w._onTopLevel === 'floating', 'not parented, alwaysOnTop at the "floating" level');
    s.panel.otherApps = false; m.sync();
    const w2 = made()[1];
    assert(w.isDestroyed() && w2 && w2.getParentWindow() === mainWin && !w2.isAlwaysOnTop(), 'turning it off makes it a child of the app again');
    mainWin.close();
    assert(w2.isDestroyed(), 'the panel goes when the main window goes');
  }

  console.log('\n== remembered bounds that are off every screen ==');
  {
    const { m, made } = rig({ panel: { bounds: { x: 9000, y: 9000, width: 400, height: 600 } } });
    m.sync();
    const b = made()[0].getBounds();
    assert(b.x >= 0 && b.x + b.width <= 1920 && b.y >= 0 && b.y + b.height <= 1040, `it comes back on screen (${JSON.stringify(b)})`);
  }
  {
    const { m, made } = rig({ panel: { bounds: { x: 200, y: 150, width: 380, height: 500 } } });
    m.sync();
    const b = made()[0].getBounds();
    assert(b.x === 200 && b.y === 150 && b.width === 380 && b.height === 500, 'remembered bounds on a screen are used');
  }
  {
    const { m, made } = rig({ panel: { open: false } });
    m.sync();
    assert(made().length === 0, 'hidden last time: not shown at start-up');
    const { m: m2, made: made2 } = rig({ main: null });
    assert(m2.sync().exists === false && made2().length === 0, 'no main window yet: no panel');
  }

  // ------------------------------------------------------------------------------------------
  console.log('\n== the REAL main.js (mock Electron): the panel follows Alfred ==');
  require('../main.js');
  await sleep(300);
  const H = mock.__ipcHandlers;
  const call = (ch, payload) => H[ch]({}, payload);
  const before = mock.__browserWindows.length;
  const made = () => mock.__browserWindows.slice(before);
  const controls = mock.__registry['controls-ui'];
  const mainWin = mock.__windowRegistry[Object.keys(mock.__windowRegistry).find((t) => /Automation/.test(t))];
  assert(made().length === 0 && (await call('alfred:status')).enabled === false, 'Alfred off by default: no panel window');
  let p = await call('alfred:panel');
  assert(p.ok && p.mode === 'docked' && p.exists === false && /Shift\+A/.test(p.shortcut), `alfred:panel reports the mode (the side panel by default) and the shortcut (${p.shortcut})`);
  await call('alfred:set-enabled', { on: true });
  assert(made().length === 0, 'turning him on uses the side panel: no separate window');
  await call('alfred:panel', { mode: 'floating' });
  const w = made()[0];
  assert(!!w && w.isVisible() && w.getParentWindow() === mainWin, 'choosing "Separate window" opens it as a child of the main window');
  controls.webContents.removeAllListeners('ipc-send');
  const toControls = []; controls.webContents.on('ipc-send', (ch, pl) => { if (ch === 'alfred') toControls.push(pl); });
  const n0 = w.webContents.sentLog.length;
  await call('alfred:clear');
  assert(toControls.some((x) => x.type === 'state') && w.webContents.sentLog.slice(n0).some((x) => x.channel === 'alfred' && x.payload.type === 'state'), 'one source of truth: the same state event goes to the control panel AND the panel window');
  p = await call('alfred:panel-toggle', {});
  assert(p.ok && !p.visible && !w.isDestroyed(), 'alfred:panel-toggle hides it (window kept)');
  p = await call('alfred:panel-toggle', { open: true });
  assert(p.visible && w.isVisible(), 'and shows it again');
  // Ctrl+Shift+A from a page made later (an AI pane, the Akọwe page …)
  const page = new EventEmitter();
  mock.__emitApp('web-contents-created', {}, page);
  page.emit('before-input-event', { preventDefault() {} }, key({ control: true, shift: true }));
  assert(!w.isVisible(), 'Ctrl+Shift+A in any page of the app hides it');
  page.emit('before-input-event', { preventDefault() {} }, key({ control: true, shift: true }));
  assert(w.isVisible(), '… and shows it');
  p = await call('alfred:panel', { mode: 'docked' });
  assert(p.mode === 'docked' && !p.exists && w.isDestroyed(), 'Docked: the window goes (the drawer takes over)');
  assert((await call('alfred:status')).settings.panel.mode === 'docked', 'the mode is saved in Alfred\'s settings');
  toControls.length = 0;
  page.emit('before-input-event', { preventDefault() {} }, key({ control: true, shift: true }));
  assert(toControls.some((x) => x.type === 'toggle-panel'), 'Docked: Ctrl+Shift+A tells the drawer to toggle');
  p = await call('alfred:panel', { mode: 'floating', otherApps: true });
  const w2 = made().pop();
  assert(p.exists && w2 !== w && !w2.getParentWindow() && w2.isAlwaysOnTop(), '"Stay on top of other programs too": a new, un-parented, always-on-top window');
  await call('alfred:panel', { otherApps: false });
  toControls.length = 0;
  const sb = await call('alfred:show-butler');
  assert(sb.ok && toControls.some((x) => x.type === 'show-butler'), '"⚙ Set up his AI" asks the control panel to show the 🤵 Butler section');
  const pr = await call('alfred:personality', { preset: 'witty', chattiness: 9 });
  assert(pr.ok && pr.personality.preset === 'witty' && pr.personality.chattiness === 5 && /1 to 5/.test(pr.message), 'alfred:personality saves (clamped, with a plain note)');
  const ps = await call('alfred:profile-save', { name: 'Witty local' });
  assert(ps.ok && ps.profiles.length === 1 && ps.activeProfile === 'Witty local', 'alfred:profile-save');
  assert((await call('alfred:profiles')).profiles[0].personality.preset === 'witty', 'alfred:profiles');
  assert((await call('alfred:profile-use', { name: 'nope' })).error === 'NOT_FOUND' && (await call('alfred:profile-use', { name: 'witty LOCAL' })).ok, 'alfred:profile-use (any case; a missing one -> NOT_FOUND)');
  assert((await call('alfred:profile-delete', { name: 'Witty local' })).profiles.length === 0, 'alfred:profile-delete');
  assert((await call('alfred:profile-save', {})).error === 'EMPTY_NAME', 'a nameless set-up is refused in plain words');
  await call('alfred:set-enabled', { on: false });
  assert(made().every((x) => x.isDestroyed()), 'turning him off closes the panel window');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
