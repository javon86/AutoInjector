'use strict';
// render-pdf.js — POST /render/pdf on the service bridge: turn a self-contained HTML page into a PDF with Chromium,
// for programs that have no PDF engine of their own (Akọwe prints its 📖 Book Bible binder this way — many pages,
// the book's look, page numbers in the footer).
//
// How (the same sandbox as render-image.js): a hidden, OFFSCREEN BrowserWindow in an in-memory session of its own
// ('render-pdf', separate from the picture renderer's), JavaScript off, sandboxed; the page is written to a private
// temp file and EVERY request except that file and data: URIs is cancelled (no network, no other local files).
// After the page has loaded (and its fonts and pictures have settled) webContents.printToPDF makes the PDF. The
// optional header / footer are Chromium's print templates (pageNumber / totalPages / date / title classes); they
// are cleaned first: no scripts, no event handlers, no outside URLs (only data: pictures). One render at a time;
// each has a time limit, the window is always destroyed and the temp folder removed.
//
// validatePdfBody() and createPdfRenderer({ makeWindow }) are separate so the unit tests drive the route with a fake
// window (test/service-bridge.test.js) and the e2e with the real one (test/e2e/render-pdf.e2e.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;
const LIMITS = Object.freeze({
  maxHtmlBytes: 40 * MB,       // the binder with its pictures embedded as data: URIs
  maxBodyBytes: 48 * MB,       // the JSON around it (escaping makes it a little larger)
  maxTemplateBytes: 1 * MB,    // each of header / footer (a small data: logo fits)
  maxTitleChars: 300,
  maxMarginMm: 100,
  defaultTimeoutMs: 60000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 180000,
});
const PAGE_SIZES = ['A4', 'Letter'];

function bad(message) { return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message }; }
function tooBig(message) { return { ok: false, error: 'TOO_BIG', code: 'TOO_BIG', message }; }

/** null when the body is usable, else { ok:false, error:'INVALID_PARAM'|'TOO_BIG', message } in plain words. */
function validatePdfBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('The body must be a JSON object with "html" in it.');
  const b = body;
  if (typeof b.html !== 'string' || b.html.trim() === '') return bad('Send "html": the text of the page to print (one self-contained HTML page).');
  if (Buffer.byteLength(b.html, 'utf8') > LIMITS.maxHtmlBytes) return tooBig(`The HTML is larger than ${LIMITS.maxHtmlBytes / MB} MB.`);
  if (b.title != null && (typeof b.title !== 'string' || b.title.length > LIMITS.maxTitleChars)) return bad(`"title" must be text of at most ${LIMITS.maxTitleChars} characters.`);
  if (b.pageSize != null && !PAGE_SIZES.includes(b.pageSize)) return bad('"pageSize" must be "A4" or "Letter".');
  if (b.landscape != null && typeof b.landscape !== 'boolean') return bad('"landscape" must be true or false.');
  if (b.printBackground != null && typeof b.printBackground !== 'boolean') return bad('"printBackground" must be true or false.');
  if (b.margins != null) {
    if (typeof b.margins !== 'object' || Array.isArray(b.margins)) return bad('"margins" must be { top, bottom, left, right } in millimetres.');
    for (const k of Object.keys(b.margins)) if (!['top', 'bottom', 'left', 'right'].includes(k)) return bad(`"margins" has an unknown side "${String(k).slice(0, 40)}" (use top, bottom, left, right).`);
    for (const k of ['top', 'bottom', 'left', 'right']) {
      const v = b.margins[k];
      if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMITS.maxMarginMm)) return bad(`"margins.${k}" must be a number of millimetres from 0 to ${LIMITS.maxMarginMm}.`);
    }
  }
  if (b.headerFooter != null) {
    const hf = b.headerFooter;
    if (typeof hf !== 'object' || Array.isArray(hf)) return bad('"headerFooter" must be { header, footer } (small HTML templates).');
    for (const k of ['header', 'footer']) {
      if (hf[k] == null) continue;
      if (typeof hf[k] !== 'string') return bad(`"headerFooter.${k}" must be HTML text.`);
      if (Buffer.byteLength(hf[k], 'utf8') > LIMITS.maxTemplateBytes) return tooBig(`"headerFooter.${k}" is larger than ${LIMITS.maxTemplateBytes / MB} MB.`);
    }
  }
  if (b.timeoutMs != null && (!Number.isInteger(b.timeoutMs) || b.timeoutMs < LIMITS.minTimeoutMs || b.timeoutMs > LIMITS.maxTimeoutMs)) return bad(`"timeoutMs" must be a whole number from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}.`);
  return null;
}

const isData = (v) => /^\s*data:/i.test(v);
const unquote = (v) => String(v).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');

/**
 * Clean a Chromium header / footer template: no scripts, no event handlers, no outside URLs. Only data: pictures
 * and #fragments survive in URL attributes and CSS url(). (The session also cancels every outside request — this
 * is the second wall.)
 */
function sanitizeTemplate(html) {
  let s = String(html || '');
  // whole elements that run code or load / embed other documents
  s = s.replace(/<(script|iframe|frame|frameset|object|embed|applet|noscript|template|form|textarea|select|button)\b[\s\S]*?<\/\1\s*>/gi, '');
  // their stray opening / closing tags, and tags that point elsewhere or change the page
  s = s.replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|noscript|template|form|textarea|select|button|input|link|meta|base|portal|audio|video|source|track)\b[^>]*>/gi, '');
  // event handlers: onload=, onerror=, …
  s = s.replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // URL attributes: only data: (and same-page #fragments) are kept
  s = s.replace(/\s+((?:xlink:)?href|src|srcset|action|formaction|poster|background|data|ping|lowsrc|dynsrc|longdesc|cite|codebase|manifest|archive|usemap)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, name, val) => { const v = unquote(val); return (name.toLowerCase() !== 'srcset' && (isData(v) || /^#/.test(v.trim()))) ? m : ''; });
  // CSS: @import, url(…) that is not data:, image-set() with bare strings, old IE expression()/behaviour
  s = s.replace(/@import\b[^;]*;?/gi, '');
  s = s.replace(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (m, val) => (isData(unquote(val)) ? m : 'none'));
  s = s.replace(/(-webkit-)?image-set\s*\(/gi, 'none(');
  s = s.replace(/expression\s*\(|behavior\s*:|-moz-binding/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s;
}

function escapeHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** The page that is printed: the caller's HTML, with "title" (when given) as its <title> (the PDF's Title). */
function pageFor(body) {
  const html = String(body.html);
  if (body.title == null || body.title === '') return html;
  const tag = `<title>${escapeHtml(body.title)}</title>`;
  if (/<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(html)) return html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, () => tag);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + tag);
  const dt = html.match(/^\s*<!doctype[^>]*>/i); // keep the doctype first (else the page drops into quirks mode)
  return dt ? dt[0] + tag + html.slice(dt[0].length) : tag + html;
}

/** The options for webContents.printToPDF (Electron ≥ 21: margins in inches). */
function printOptions(body) {
  const o = { pageSize: body.pageSize || 'A4', landscape: body.landscape === true, printBackground: body.printBackground !== false };
  if (body.margins) {
    const m = { top: 10, bottom: 10, left: 10, right: 10 }; // mm: Chromium's own default is about 1 cm
    for (const k of Object.keys(m)) if (typeof body.margins[k] === 'number') m[k] = body.margins[k];
    o.margins = { top: m.top / 25.4, bottom: m.bottom / 25.4, left: m.left / 25.4, right: m.right / 25.4 };
  }
  const hf = body.headerFooter;
  if (hf && (hf.header || hf.footer)) {
    o.displayHeaderFooter = true;
    // an empty template would get Chromium's default (date + title / URL + page): an empty span instead
    o.headerTemplate = hf.header ? sanitizeTemplate(hf.header) : '<span></span>';
    o.footerTemplate = hf.footer ? sanitizeTemplate(hf.footer) : '<span></span>';
  }
  return o;
}

/** How many pages a PDF has: its /Type /Page objects (not /Pages). */
function countPages(buf) {
  const m = Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : 0;
}

/**
 * createPdfRenderer({ makeWindow, tmpDir?, log? }) → { render(body) }.
 * makeWindow({ allow(url) }) → a window-like object: { load(fileUrl) → Promise, printToPDF(options) → Promise<Buffer>, destroy() }.
 */
function createPdfRenderer(deps) {
  const d = deps || {};
  const makeWindow = d.makeWindow;
  const log = d.log || (() => {});
  let busy = Promise.resolve();

  async function renderOnce(body) {
    const err = validatePdfBody(body);
    if (err) return err;
    if (!makeWindow) return { ok: false, error: 'RENDER_NOT_WIRED', code: 'RENDER_NOT_WIRED', message: 'This AutoInjector cannot make PDFs here.' };
    const timeoutMs = body.timeoutMs || LIMITS.defaultTimeoutMs;
    const options = printOptions(body);
    const dir = fs.mkdtempSync(path.join(d.tmpDir || os.tmpdir(), 'ai-renderpdf-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, pageFor(body), 'utf8');
    const fileUrl = require('url').pathToFileURL(file).href;
    const allow = (u) => typeof u === 'string' && (u.startsWith('data:') || u === fileUrl);
    let win = null;
    let timer = null;
    let gaveUp = false;
    const t0 = Date.now();
    try {
      const work = (async () => {
        const w = await makeWindow({ allow });
        // A window that only arrives after the time ran out: `finally` has already run with win === null — destroy it here.
        if (gaveUp) { try { w.destroy(); } catch (_) {} throw Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' }); }
        win = w;
        await win.load(fileUrl);
        if (gaveUp) throw Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' });
        const pdf = await win.printToPDF(options);
        const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf || []);
        if (buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('Chromium gave back something that is not a PDF'), { code: 'RENDER_FAILED' });
        return buf;
      })();
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => { gaveUp = true; rej(Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' })); }, timeoutMs); });
      const buf = await Promise.race([work, timeout]);
      const pages = countPages(buf);
      log('render-pdf', { pageSize: options.pageSize, landscape: options.landscape, pages, bytes: buf.length, ms: Date.now() - t0 });
      const out = { ok: true, mime: 'application/pdf', bytes: buf.length, pdfBase64: buf.toString('base64') };
      if (pages > 0) out.pages = pages;
      return out;
    } catch (e) {
      const code = (e && e.code) === 'RENDER_TIMEOUT' ? 'RENDER_TIMEOUT' : 'RENDER_FAILED';
      log('render-pdf-failed', { code, error: String((e && e.message) || e).slice(0, 200) });
      return { ok: false, error: code, code, message: code === 'RENDER_TIMEOUT' ? `Making the PDF took longer than ${Math.round(timeoutMs / 1000)} seconds.` : `The PDF could not be made: ${String((e && e.message) || e).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
      try { if (win) win.destroy(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // One render at a time (each is a whole offscreen Chromium page, maybe hundreds of PDF pages).
  function render(body) {
    const next = busy.then(() => renderOnce(body));
    busy = next.catch(() => {});
    return next;
  }
  return { render };
}

/** The real window for main.js: hidden, offscreen, sandboxed, JS off, private in-memory session, no network. */
function electronWindowFactory(electron) {
  return async function makeWindow({ allow }) {
    const { BrowserWindow, session } = electron;
    // its own in-memory session (renders run one at a time; the filter is replaced each time)
    const ses = session.fromPartition('render-pdf', { cache: false });
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(allow(details.url) || details.url === 'about:blank') }));
    try { ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); } catch (_) {}
    const win = new BrowserWindow({
      show: false, width: 794, height: 1123, frame: false, resizable: false, paintWhenInitiallyHidden: true,
      webPreferences: { offscreen: true, session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, images: true, spellcheck: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, u) => { if (!allow(u)) e.preventDefault(); });
    const dbg = win.webContents.debugger;
    return {
      load: async (url) => {
        // loadURL resolves on the load event: stylesheets, <img> pictures and CSS backgrounds requested so far are in
        await win.loadURL(url);
        // then wait for web fonts and any picture still decoding. The page's own scripts stay off; this one check runs
        // through the DevTools protocol (if that is unavailable, a short fixed pause instead).
        try {
          dbg.attach('1.3');
          await Promise.race([
            dbg.sendCommand('Runtime.evaluate', {
              expression: 'Promise.all([document.fonts ? document.fonts.ready : null, ...Array.from(document.images, (i) => (i.decode ? i.decode().catch(() => null) : null))]).then(() => true)',
              awaitPromise: true, returnByValue: true,
            }),
            new Promise((r) => setTimeout(r, 10000)),
          ]);
        } catch (_) {
          await new Promise((r) => setTimeout(r, 500));
        }
        await new Promise((r) => setTimeout(r, 150));
      },
      printToPDF: (options) => win.webContents.printToPDF(options),
      destroy: () => { try { dbg.detach(); } catch (_) {} try { win.destroy(); } catch (_) {} try { ses.clearStorageData(); } catch (_) {} },
    };
  };
}

module.exports = { createPdfRenderer, validatePdfBody, sanitizeTemplate, printOptions, pageFor, countPages, electronWindowFactory, LIMITS };
