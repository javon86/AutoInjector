'use strict';
/*
 * alfred-window.js — 🎩 Alfred's floating side panel: his OWN small frameless window that floats over
 * the whole app (over the native AI panes, the 📖 Akọwe tab, everything), so you can talk to him from
 * anywhere. Electron-free core: main.js / alfred-main.js inject BrowserWindow, screen, the main window
 * getter and Alfred's settings; the tests inject fakes (test/mock-electron.js).
 *
 *   Modes          settings.panel.mode: 'floating' (this window, the default) | 'docked' (the drawer
 *                  inside controls.html, exactly as before — this module then keeps no window).
 *   Over the app   a child of the main window (`parent`): it stays above the app and moves with it.
 *   Other programs settings.panel.otherApps: not parented, alwaysOnTop at the 'floating' level.
 *   Bounds         remembered (settings.panel.bounds), clamped to a visible display; the first time it
 *                  snaps to the main window's right edge.
 *   Shortcut       Ctrl+Shift+A (Cmd+Shift+A on macOS) from any page of the app (before-input-event on
 *                  every webContents) shows / hides it; in docked mode it toggles the drawer instead.
 *   Closing        hides it (Alfred stays on); it is destroyed when Alfred is turned off, the mode
 *                  changes to docked, or the main window goes away.
 *   Focus          it never takes focus on its own (showInactive) — only when YOU open it.
 */

const MIN_W = 300;
const MIN_H = 320;
const DEF_W = 400;
const MIN_VISIBLE = 80; // px of the panel that must be on a display for saved bounds to be used as-is

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
function validRect(b) {
  if (!b || typeof b !== 'object') return null;
  const x = num(b.x), y = num(b.y), width = num(b.width), height = num(b.height);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : { w: 0, h: 0, area: 0 };
}
function areas(displays) {
  return (Array.isArray(displays) ? displays : []).map((d) => validRect(d && (d.workArea || d.bounds))).filter(Boolean);
}

/** The first-time place: against the main window's right edge (inside it), full height minus a margin. */
function defaultBounds(mainBounds, displays) {
  const m = validRect(mainBounds);
  const work = areas(displays);
  if (!m) {
    const a = work[0] || { x: 0, y: 0, width: 1280, height: 800 };
    const width = Math.min(DEF_W, a.width);
    return { x: a.x + a.width - width - 16, y: a.y + 40, width, height: Math.max(MIN_H, Math.min(a.height - 80, 760)) };
  }
  const width = Math.max(MIN_W, Math.min(DEF_W, m.width - 40));
  const top = 72; // below the app's title bar and its own top bar
  const height = Math.max(MIN_H, m.height - top - 24);
  return clampBounds({ x: m.x + m.width - width - 12, y: m.y + top, width, height }, displays);
}

/**
 * Saved bounds -> bounds that are really on a screen: null / garbage / (almost) off every display ->
 * `fallback`; otherwise shrink to fit the display it is mostly on and pull it fully inside.
 */
function clampBounds(b, displays, fallback) {
  const r = validRect(b);
  const work = areas(displays);
  if (!work.length) return r ? { x: r.x, y: r.y, width: Math.max(MIN_W, r.width), height: Math.max(MIN_H, r.height) } : (fallback || null);
  if (!r) return fallback ? clampBounds(fallback, displays, null) : null;
  let best = null;
  for (const a of work) { const o = overlap(r, a); if (!best || o.area > best.o.area) best = { a, o }; }
  if (!best.o.area || best.o.w < Math.min(MIN_VISIBLE, r.width) || best.o.h < Math.min(MIN_VISIBLE, r.height)) {
    return fallback ? clampBounds(fallback, displays, null) : clampBounds({ x: work[0].x + work[0].width - DEF_W - 16, y: work[0].y + 40, width: DEF_W, height: work[0].height - 80 }, displays, null);
  }
  const a = best.a;
  const width = Math.max(Math.min(MIN_W, a.width), Math.min(r.width, a.width));
  const height = Math.max(Math.min(MIN_H, a.height), Math.min(r.height, a.height));
  const x = Math.min(Math.max(r.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(r.y, a.y), a.y + a.height - height);
  return { x, y, width, height };
}

/** Ctrl+Shift+A (Cmd+Shift+A on macOS) as an Electron before-input-event `input`. */
function isToggleShortcut(input, platform) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  const key = String(input.key || '').toLowerCase();
  const code = String(input.code || '');
  if (key !== 'a' && code !== 'KeyA') return false;
  if (!input.shift || input.alt) return false;
  return platform === 'darwin' ? !!input.meta : !!input.control && !input.meta;
}
const SHORTCUT_LABEL = (platform) => (platform === 'darwin' ? 'Cmd+Shift+A' : 'Ctrl+Shift+A');

/**
 * deps: {
 *   BrowserWindow, screen, platform, getMainWindow() -> BaseWindow|null,
 *   getSettings() -> Alfred's settings ({ enabled, panel:{mode, otherApps, open, bounds} }),
 *   setPanel(patch, { quiet }) -> saves settings.panel,
 *   htmlFile, preload, log(kind, detail), toggleDocked() (docked mode: tell the drawer to toggle),
 *   saveDelayMs
 * }
 */
function createAlfredWindow(deps = {}) {
  const platform = deps.platform || process.platform;
  const log = (k, d) => { try { if (deps.log) deps.log(k, d || {}); } catch (_) {} };
  let win = null;
  let winOtherApps = null;      // the otherApps setting the current window was made with
  let quitting = false;
  let saveTimer = null;
  const watchedMains = new WeakSet();

  const settings = () => { try { return (deps.getSettings && deps.getSettings()) || {}; } catch (_) { return {}; } };
  const panel = () => Object.assign({ mode: 'floating', otherApps: false, open: true, bounds: null }, settings().panel || {});
  const mainWin = () => { try { const m = deps.getMainWindow && deps.getMainWindow(); return m && !(m.isDestroyed && m.isDestroyed()) ? m : null; } catch (_) { return null; } };
  const alive = () => !!win && !(win.isDestroyed && win.isDestroyed());
  const displays = () => { try { return deps.screen && deps.screen.getAllDisplays ? deps.screen.getAllDisplays() : []; } catch (_) { return []; } };
  const wanted = () => { const s = settings(); return !!(s.enabled && panel().mode === 'floating' && deps.BrowserWindow && mainWin()); };

  function placeFor() {
    const m = mainWin();
    let mb = null; try { mb = m && m.getBounds ? m.getBounds() : null; } catch (_) {}
    const fallback = defaultBounds(mb, displays());
    return clampBounds(panel().bounds, displays(), fallback) || fallback;
  }
  function persistBounds() {
    if (!alive()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!alive()) return;
      let b = null; try { b = win.getBounds(); } catch (_) {}
      if (b && deps.setPanel) { try { deps.setPanel({ bounds: validRect(b) }, { quiet: true }); } catch (_) {} }
    }, deps.saveDelayMs == null ? 400 : deps.saveDelayMs);
    if (saveTimer && saveTimer.unref) saveTimer.unref();
  }

  function create() {
    const p = panel();
    const m = mainWin();
    const b = placeFor();
    const opts = {
      x: b.x, y: b.y, width: b.width, height: b.height, minWidth: MIN_W, minHeight: MIN_H,
      frame: false, resizable: true, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      show: false, skipTaskbar: true, title: '🎩 Alfred', backgroundColor: '#0d0f14', hasShadow: true,
      webPreferences: { preload: deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'controls-ui', backgroundThrottling: false },
    };
    if (p.otherApps) opts.alwaysOnTop = true;
    else if (m) opts.parent = m;
    let w;
    try { w = new deps.BrowserWindow(opts); } catch (e) { log('alfred-panel-error', { step: 'create' }); return null; }
    win = w;
    winOtherApps = !!p.otherApps;
    // "Stay on top of other programs too": the 'floating' level (above normal windows, below system UI).
    if (p.otherApps) { try { w.setAlwaysOnTop(true, 'floating'); } catch (_) {} }
    try { w.loadFile(deps.htmlFile); } catch (_) {}
    attachShortcut(w.webContents); // (once — app 'web-contents-created' may have hooked it already)
    // Links never open inside the panel.
    try { if (w.webContents && w.webContents.setWindowOpenHandler) w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (_) {}
    try { if (w.webContents && w.webContents.on) w.webContents.on('will-navigate', (e) => { try { e.preventDefault(); } catch (_) {} }); } catch (_) {}
    w.on('move', persistBounds);
    w.on('resize', persistBounds);
    // Closing the panel only hides it — Alfred stays on. (It really closes when the app quits,
    // the main window goes, Alfred is turned off or the mode changes.)
    w.on('close', (e) => {
      if (quitting || !mainWin() || w.__alfredDestroying) return;
      try { e.preventDefault(); } catch (_) {}
      hide({ remember: true });
    });
    w.on('closed', () => { if (win === w) { win = null; winOtherApps = null; } });
    log('alfred-panel', { step: 'create', otherApps: !!p.otherApps });
    return w;
  }
  function destroy() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!alive()) { win = null; return; }
    const w = win;
    win = null; winOtherApps = null;
    try { w.__alfredDestroying = true; w.destroy(); } catch (_) {}
  }
  function watchMain(m) {
    if (!m || watchedMains.has(m) || typeof m.on !== 'function') return;
    watchedMains.add(m);
    // The panel goes with the main window (an un-parented one too, or the app would never quit).
    m.on('close', () => destroy());
    m.on('closed', () => destroy());
  }

  /** Bring the window in line with Alfred's state. focus: true only when the user asked for it. */
  function sync({ focus } = {}) {
    const m = mainWin();
    if (m) watchMain(m);
    if (!wanted()) { destroy(); return state(); }
    const p = panel();
    if (alive() && winOtherApps !== !!p.otherApps) destroy(); // parent / on-top changed: make it again
    if (!p.open) { if (alive()) { try { win.hide(); } catch (_) {} } return state(); }
    if (!alive() && !create()) return state();
    try {
      if (focus) { win.show(); win.focus(); }
      else if (!win.isVisible()) win.showInactive(); // never steal focus from the AI panes
    } catch (_) {}
    return state();
  }
  function show({ focus = true } = {}) {
    if (deps.setPanel && !panel().open) { try { deps.setPanel({ open: true }); } catch (_) {} }
    return sync({ focus });
  }
  function hide({ remember = true } = {}) {
    if (remember && deps.setPanel && panel().open) { try { deps.setPanel({ open: false }); } catch (_) {} }
    if (alive()) { try { win.hide(); } catch (_) {} }
    // give the keyboard back to the app
    const m = mainWin(); if (m && remember) { try { m.focus(); } catch (_) {} }
    return state();
  }
  /** Show / hide. In docked mode this asks the drawer to toggle itself. */
  function toggle(open, { focus = true } = {}) {
    const s = settings();
    if (!s.enabled) return Object.assign(state(), { ok: false, error: 'OFF', message: 'Alfred is off. Turn him on with the 🎩 switch.' });
    if (panel().mode !== 'floating') { try { if (deps.toggleDocked) deps.toggleDocked(open); } catch (_) {} return Object.assign(state(), { docked: true }); }
    const want = typeof open === 'boolean' ? open : !(alive() && win.isVisible());
    return want ? show({ focus }) : hide({ remember: true });
  }
  /** before-input-event handler for every page of the app. Returns true when it handled the key. */
  function onInput(event, input) {
    if (!isToggleShortcut(input, platform)) return false;
    if (!settings().enabled) return false; // Alfred off: the key belongs to the page
    try { if (event && event.preventDefault) event.preventDefault(); } catch (_) {}
    log('alfred-panel', { step: 'shortcut' });
    toggle(undefined, { focus: true });
    return true;
  }
  /** Hook a page's keyboard (call for every webContents the app makes). */
  function attachShortcut(wc) {
    if (!wc || typeof wc.on !== 'function' || wc.__alfredShortcut) return;
    wc.__alfredShortcut = true;
    wc.on('before-input-event', (e, input) => { onInput(e, input); });
  }
  function send(channel, payload) {
    if (!alive()) return false;
    try { if (win.webContents && !(win.webContents.isDestroyed && win.webContents.isDestroyed())) { win.webContents.send(channel, payload); return true; } } catch (_) {}
    return false;
  }
  function state() {
    const p = panel();
    let visible = false, bounds = null, onTop = false, parented = false;
    if (alive()) {
      try { visible = !!win.isVisible(); } catch (_) {}
      try { bounds = win.getBounds(); } catch (_) {}
      try { onTop = !!win.isAlwaysOnTop(); } catch (_) {}
      try { parented = !!(win.getParentWindow && win.getParentWindow()); } catch (_) {}
    }
    return { ok: true, mode: p.mode, otherApps: !!p.otherApps, open: !!p.open, exists: alive(), visible, bounds, onTop, parented, shortcut: SHORTCUT_LABEL(platform) };
  }

  return {
    sync, show, hide, toggle, onInput, attachShortcut, send, state, destroy,
    markQuitting: () => { quitting = true; },
    window: () => (alive() ? win : null),
  };
}

module.exports = { createAlfredWindow, clampBounds, defaultBounds, isToggleShortcut, SHORTCUT_LABEL, MIN_W, MIN_H };
