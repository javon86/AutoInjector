'use strict';
// render-image.js — POST /render/image on the service bridge: turn an SVG (or a small self-contained HTML page)
// into a JPEG or PNG with Chromium, for programs that have no image library of their own (Akọwe makes its ebook
// cover JPG and the Word copy of its map this way — it has no Pillow at runtime).
//
// How: a hidden, OFFSCREEN BrowserWindow in an in-memory session of its own, JavaScript off, sandboxed; the page is
// written to a private temp file and EVERY request except that file and data: URIs is cancelled (no network, no
// other local files). The page is laid out at exactly width × height through the DevTools protocol (a window is
// clamped to the screen) and captured (Page.captureScreenshot) → toJPEG / toPNG → base64. One render at a time;
// each one has a time limit and the window is always destroyed.
//
// validateRenderBody() and createRenderer({ makeWindow }) are separate so the unit tests can drive the route with a
// fake window (test/service-bridge.test.js) and the e2e with the real one (test/e2e/render-image.e2e.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = Object.freeze({
  minSide: 16,
  maxSide: 4096,          // KDP's largest useful ebook cover is 2560 × 4096
  maxPixels: 4096 * 4096,
  maxSourceBytes: 30 * 1024 * 1024, // an SVG with its artwork embedded as a data: URI
  defaultTimeoutMs: 20000,
  maxTimeoutMs: 60000,
});

function bad(message) { return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message }; }

/** null when the body is usable, else { ok:false, error:'INVALID_PARAM', message } in plain words. */
function validateRenderBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const hasSvg = typeof b.svg === 'string' && b.svg.trim() !== '';
  const hasHtml = typeof b.html === 'string' && b.html.trim() !== '';
  if (hasSvg === hasHtml) return bad('Send exactly one of "svg" or "html" (the text of the picture to draw).');
  const src = hasSvg ? b.svg : b.html;
  if (Buffer.byteLength(src, 'utf8') > LIMITS.maxSourceBytes) return bad(`The ${hasSvg ? 'SVG' : 'HTML'} is larger than ${LIMITS.maxSourceBytes / (1024 * 1024)} MB.`);
  if (hasSvg && !/<svg[\s>]/i.test(src)) return bad('"svg" must be SVG text (it has no <svg> element).');
  for (const k of ['width', 'height']) {
    const v = b[k];
    if (!Number.isInteger(v) || v < LIMITS.minSide || v > LIMITS.maxSide) return bad(`"${k}" must be a whole number of pixels from ${LIMITS.minSide} to ${LIMITS.maxSide}.`);
  }
  if (b.width * b.height > LIMITS.maxPixels) return bad('The picture is too big (at most 4096 × 4096 pixels).');
  const fmt = b.format == null ? 'png' : b.format;
  if (fmt !== 'jpeg' && fmt !== 'png') return bad('"format" must be "jpeg" or "png".');
  if (b.quality != null && (!Number.isInteger(b.quality) || b.quality < 1 || b.quality > 100)) return bad('"quality" must be a whole number from 1 to 100.');
  if (b.timeoutMs != null && (!Number.isInteger(b.timeoutMs) || b.timeoutMs < 1000 || b.timeoutMs > LIMITS.maxTimeoutMs)) return bad(`"timeoutMs" must be from 1000 to ${LIMITS.maxTimeoutMs}.`);
  if (b.background != null && (typeof b.background !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(b.background))) return bad('"background" must be a colour like #ffffff.');
  return null;
}

/** The page that is drawn: the SVG scaled to fill exactly width × height (its viewBox keeps the shape). */
function pageFor(body) {
  if (body.html) return body.html;
  const bg = body.background || (body.format === 'jpeg' ? '#ffffff' : 'transparent');
  const svg = String(body.svg).replace(/^\s*<\?xml[^>]*\?>/i, '').replace(/<!DOCTYPE[^>]*>/i, '');
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + `html,body{margin:0;padding:0;width:${body.width}px;height:${body.height}px;overflow:hidden;background:${bg}}`
    + `body>svg{display:block;width:${body.width}px;height:${body.height}px}`
    + `</style></head><body>${svg}</body></html>`;
}

/**
 * createRenderer({ makeWindow, tmpDir?, log? }) → { render(body) }.
 * makeWindow({ width, height, allow(url) }) → a window-like object: { load(fileUrl) → Promise, capture() → Promise<NativeImage-like>, destroy() }.
 * A NativeImage-like has getSize(), resize({width,height}), toJPEG(q), toPNG().
 */
function createRenderer(deps) {
  const d = deps || {};
  const makeWindow = d.makeWindow;
  const log = d.log || (() => {});
  let busy = Promise.resolve();

  async function renderOnce(body) {
    const err = validateRenderBody(body);
    if (err) return err;
    if (!makeWindow) return { ok: false, error: 'RENDER_NOT_WIRED', code: 'RENDER_NOT_WIRED', message: 'This AutoInjector cannot draw pictures here.' };
    const fmt = body.format || 'png';
    const quality = body.quality || 90;
    const timeoutMs = body.timeoutMs || LIMITS.defaultTimeoutMs;
    const dir = fs.mkdtempSync(path.join(d.tmpDir || os.tmpdir(), 'ai-render-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, pageFor(body), 'utf8');
    const fileUrl = require('url').pathToFileURL(file).href;
    const allow = (u) => typeof u === 'string' && (u.startsWith('data:') || u === fileUrl);
    let win = null;
    let timer = null;
    const t0 = Date.now();
    try {
      const work = (async () => {
        win = await makeWindow({ width: body.width, height: body.height, allow });
        await win.load(fileUrl);
        let img = await win.capture();
        if (!img || (img.isEmpty && img.isEmpty())) throw Object.assign(new Error('nothing was drawn'), { code: 'RENDER_FAILED' });
        const sz = img.getSize();
        if (sz.width !== body.width || sz.height !== body.height) img = img.resize({ width: body.width, height: body.height, quality: 'best' });
        const buf = fmt === 'jpeg' ? img.toJPEG(quality) : img.toPNG();
        return buf;
      })();
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' })), timeoutMs); });
      const buf = await Promise.race([work, timeout]);
      log('render-image', { format: fmt, width: body.width, height: body.height, bytes: buf.length, ms: Date.now() - t0 });
      return { ok: true, format: fmt, mime: fmt === 'jpeg' ? 'image/jpeg' : 'image/png', width: body.width, height: body.height, bytes: buf.length, imageBase64: buf.toString('base64') };
    } catch (e) {
      const code = (e && e.code) === 'RENDER_TIMEOUT' ? 'RENDER_TIMEOUT' : 'RENDER_FAILED';
      log('render-image-failed', { code, error: String((e && e.message) || e).slice(0, 200) });
      return { ok: false, error: code, code, message: code === 'RENDER_TIMEOUT' ? `Drawing the picture took longer than ${Math.round(timeoutMs / 1000)} seconds.` : `The picture could not be drawn: ${String((e && e.message) || e).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
      try { if (win) win.destroy(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // One render at a time (each is a whole offscreen Chromium page).
  function render(body) {
    const next = busy.then(() => renderOnce(body));
    busy = next.catch(() => {});
    return next;
  }
  return { render };
}

/** The real window for main.js: hidden, offscreen, sandboxed, JS off, private in-memory session, no network. */
function electronWindowFactory(electron) {
  return async function makeWindow({ width, height, allow }) {
    const { BrowserWindow, session } = electron;
    // one in-memory session for every render (renders run one at a time; the filter is replaced each time)
    const ses = session.fromPartition('render-image', { cache: false });
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(allow(details.url) || details.url === 'about:blank') }));
    try { ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); } catch (_) {}
    const win = new BrowserWindow({
      show: false, width, height, useContentSize: true, frame: false, resizable: false, enableLargerThanScreen: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { offscreen: true, session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, images: true, spellcheck: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, u) => { if (!allow(u)) e.preventDefault(); });
    // The window itself is clamped to the screen; the page is laid out at exactly width × height through the
    // DevTools protocol (device metrics) and captured beyond the viewport, so any size up to the limit works.
    const dbg = win.webContents.debugger;
    return {
      load: async (url) => {
        // (a blank page first: the protocol needs a live page before the device metrics can be set)
        await win.loadURL('about:blank');
        dbg.attach('1.3');
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await win.loadURL(url);
        // let layout + image decoding (data: URIs decode asynchronously) settle
        await new Promise((r) => setTimeout(r, 150));
      },
      capture: async () => {
        const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true });
        return electron.nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      },
      destroy: () => { try { dbg.detach(); } catch (_) {} try { win.destroy(); } catch (_) {} try { ses.clearStorageData(); } catch (_) {} },
    };
  };
}

module.exports = { createRenderer, validateRenderBody, electronWindowFactory, pageFor, LIMITS };
