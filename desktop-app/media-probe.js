'use strict';
/*
 * media-probe.js — "does this video file really play?" for the 🩺 media self-test (media-selftest.js).
 * A hidden window (media-probe.html, no preload, no node) loads the file into a <video> and reports its length
 * and size once the player has read it — or the player's own error. Bounded by a time limit; the window is always
 * closed afterwards.
 *
 *   const probe = createMediaProbe({ electron: require('electron'), dir: __dirname });
 *   await probe('C:/…/clip.mp4')  →  { ok: true, duration: 1.2, width: 640, height: 480 } | { ok: false, error }
 */
const path = require('path');
const { pathToFileURL } = require('url');

// The page-side check (runs inside the hidden window).
function pageScript(url, ms) {
  return `new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    let done = false;
    const end = (r) => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => end({ ok: false, error: 'the player did not read the file within ${Math.round(ms / 1000)} s' }), ${ms});
    v.addEventListener('loadeddata', () => { clearTimeout(t); end({ ok: true, duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight }); });
    v.addEventListener('error', () => { clearTimeout(t); const e = v.error; end({ ok: false, error: e ? ('media error ' + e.code + (e.message ? ': ' + e.message : '')) : 'the player could not read it' }); });
    v.src = ${JSON.stringify(url)};
    document.body.appendChild(v);
  })`;
}

function createMediaProbe(d = {}) {
  const electron = d.electron;
  const dir = d.dir || __dirname;
  const limitMs = d.limitMs || 20000;
  return async function probe(file) {
    if (!electron || !electron.BrowserWindow) return { ok: false, error: 'no player in this build' };
    let win = null;
    try {
      win = new electron.BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
        webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
      await win.loadFile(path.join(dir, 'media-probe.html'));
      const url = pathToFileURL(file).href;
      let timer = null;
      const r = await Promise.race([
        win.webContents.executeJavaScript(pageScript(url, limitMs), true),
        new Promise((res) => { timer = setTimeout(() => res({ ok: false, error: 'the player check timed out' }), limitMs + 5000); }),
      ]);
      clearTimeout(timer);
      return r && typeof r === 'object' ? r : { ok: false, error: 'no answer from the player' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    } finally {
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    }
  };
}

module.exports = { createMediaProbe, pageScript };
