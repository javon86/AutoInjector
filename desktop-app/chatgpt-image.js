'use strict';
/*
 * chatgpt-image.js — the SECOND image engine: ChatGPT's own image generation, in
 * the logged-in ChatGPT pane AutoInjector already drives. Next to Stable Diffusion
 * (sd-studio.js), behind the same contract: POST /image/request with
 * engine "chatgpt" (or "auto" when no SD app is connected) — docs/SD_IMAGE_API.md.
 *
 * One picture, step by step:
 *   1. the pane must be there and logged in (else CHATGPT_NOT_READY);
 *   2. it HOLDS the ChatGPT pane (main.js: relays and Akọwe sends to ChatGPT wait,
 *      no check-in starts, the reply is never relayed or nagged about tags);
 *      optionally a fresh chat (per series / when asked);
 *   3. it types the request through the app's own proven send path (sendTextTo:
 *      typed, verified by its [MSG #] number, retried);
 *   4. it reads the page (buildScanScript) until the newest assistant turn holds a
 *      finished picture: a loaded <img> ≥ 200 px, not blurred, not an avatar/icon,
 *      not one that was already on the page, the same for two reads and the page
 *      done writing. Progress placeholders and blurred previews are ignored;
 *   5. the bytes are fetched INSIDE the page with its own session
 *      (fetch(src, {credentials:'include'})), a WebP/AVIF converted to PNG there
 *      (canvas), else main's session fetch + nativeImage; checked to be a real
 *      PNG/JPEG of a sensible size; saved in images/ with a .json sidecar of what
 *      made it (like SD pictures) and recorded as a project image.
 * Failures: CHATGPT_NOT_READY · IMAGE_REFUSED (with ChatGPT's first sentence) ·
 *   IMAGE_LIMIT · IMAGE_TIMEOUT (default 240 s) · IMAGE_FETCH_FAILED · CANCELLED.
 * Jobs run one at a time (a queue), so two image jobs never type into ChatGPT at once.
 *
 * Electron-free (everything reaches the pane through injected functions), so the
 * page scripts run in real Chromium in test/chatgpt-image.test.js and the logic is
 * unit-tested with a fake pane. Never throws: every result is {ok, …}.
 */
const sdImages = require('./sd-images');

const MARKER = '__AUTOINJECTOR_CHATIMG__';
const DEFAULTS = {
  timeoutMs: 240000,       // from the moment the request is typed
  pollMs: 1500,            // page read interval
  stableReads: 2,          // the same finished picture on this many reads in a row
  stableReadsWriting: 6,   // … or this many while the page still shows Stop
  textSettleMs: 6000,      // a words-only answer that held still this long is read as refusal / limit
  noImageMs: 45000,        // a words-only answer with no picture after this long → IMAGE_REFUSED
  minPx: 200,              // smaller pictures are icons / avatars / previews
  minBytes: 500,
  maxBytes: 40 * 1024 * 1024,
  freshChatPerSeries: false,
  newChatWaitMs: 30000,
};

// ---- built-in page selectors (selectors.js IMAGE_CANDIDATES is the editable list) ----
const TURN_SELECTORS = ['article[data-turn]', '[data-testid^="conversation-turn"]', '[data-message-author-role]'];
const USER_SELECTORS = ['[data-message-author-role="user"]', 'article[data-turn="user"]', '[data-turn="user"]'];
const EXTRA_ASSISTANT = ['article[data-turn="assistant"]', '[data-turn="assistant"]'];
const NOTICE_SELECTORS = ['[role="alert"]', '[role="alertdialog"]', '[data-testid*="toast"]', '[class*="toast"]', '[class*="banner"]', '[data-testid*="limit"]', '[class*="limit"]'];
const DEFAULT_IMAGE_CANDIDATES = ['[data-message-author-role="assistant"] img', 'article[data-turn="assistant"] img', '[class*="imagegen"] img', 'img[alt*="Generated image" i]', '[data-testid*="image-gen"] img'];

// ---- words ----------------------------------------------------------------------------
const LIMIT_RE = /(you(?:'|’)ve (?:reached|hit) (?:the |your )?(?:\w+ ){0,3}limit|(?:usage|rate|image(?: generation)?|daily|plan) (?:limit|cap)|limit (?:resets|will reset)|hit the limit|too many (?:requests|images)|reached (?:the|your) (?:\w+ ){0,2}limit|out of (?:image|free) (?:generations|credits))/i;
const REFUSE_RE = /(\bI (?:can(?:'|’)t|cannot|can not|won(?:'|’)t|am unable to|(?:'|’)m unable to|am not able to|(?:'|’)m not able to) (?:create|generate|make|draw|produce|help|assist|do that|fulfil)|\bunable to (?:create|generate|make|draw)|(?:violates?|against|goes against) (?:our|the|OpenAI(?:'|’)s) (?:content |usage )?polic|content polic|isn(?:'|’)t allowed|not allowed to (?:create|generate|make)|can(?:'|’)t (?:help|assist) with (?:that|this)|I(?:'|’)m sorry, but)/i;
const PROGRESS_RE = /((?:creating|generating|making|preparing|rendering) (?:an |the |your )?image|getting started|adding (?:the )?(?:final )?details|lots of people are creating images|image creation in progress|almost done)/i;

function classifyText(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (LIMIT_RE.test(t)) return 'limit';
  if (REFUSE_RE.test(t)) return 'refused';
  return null;
}
function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.{1,240}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 240)).trim();
}

// ---- bytes ------------------------------------------------------------------------------
// What a buffer holds: { type: 'png'|'jpeg'|'webp'|'gif'|'avif'|'', width, height }.
function sniff(buf) {
  const out = { type: '', width: 0, height: 0 };
  if (!Buffer.isBuffer(buf) || buf.length < 16) return out;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      out.type = 'png';
      if (buf.length >= 24) { out.width = buf.readUInt32BE(16); out.height = buf.readUInt32BE(20); }
      return out;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      out.type = 'jpeg';
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const m = buf[off + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { out.height = buf.readUInt16BE(off + 5); out.width = buf.readUInt16BE(off + 7); break; }
        off += 2 + len;
      }
      return out;
    }
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      out.type = 'webp';
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X' && buf.length >= 30) { out.width = 1 + buf.readUIntLE(24, 3); out.height = 1 + buf.readUIntLE(27, 3); }
      else if (chunk === 'VP8 ' && buf.length >= 30) { out.width = buf.readUInt16LE(26) & 0x3fff; out.height = buf.readUInt16LE(28) & 0x3fff; }
      else if (chunk === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); out.width = 1 + (b & 0x3fff); out.height = 1 + ((b >> 14) & 0x3fff); }
      return out;
    }
    if (buf.toString('latin1', 0, 3) === 'GIF') { out.type = 'gif'; out.width = buf.readUInt16LE(6); out.height = buf.readUInt16LE(8); return out; }
    if (buf.toString('latin1', 4, 8) === 'ftyp') { out.type = 'avif'; return out; }
  } catch (_) { /* a broken header: unknown */ }
  return out;
}

// ---- page scripts (run inside the ChatGPT pane; also in real Chromium in the tests) ----
/* eslint-disable no-undef */
function pageScan(CFG) {
  const doc = document;
  const qsa = (sel, root) => { try { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); } catch (_) { return []; } };
  const shown = (e) => {
    try { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (_) { return false; }
  };
  const anyMatch = (n, sels) => { for (const s of sels) { try { if (n.matches(s)) return true; } catch (_) {} } return false; };
  const closestOf = (n, sels) => { for (const s of sels) { try { const c = n.closest(s); if (c) return c; } catch (_) {} } return null; };
  const inUser = (n) => !!closestOf(n, CFG.user);
  const hasUser = (t) => { for (const s of CFG.user) { try { if (t.querySelector(s)) return true; } catch (_) {} } return false; };
  const hasAssistant = (t) => { for (const s of CFG.assistant) { try { if (t.querySelector(s)) return true; } catch (_) {} } return false; };
  const isUserTurn = (t) => anyMatch(t, CFG.user) || (hasUser(t) && !hasAssistant(t));
  const turns = [];
  const addTurn = (t) => { if (t && turns.indexOf(t) < 0 && !isUserTurn(t)) turns.push(t); };
  for (const s of CFG.assistant) for (const n of qsa(s)) if (!inUser(n)) addTurn(closestOf(n, CFG.turn) || n);
  const pageImgs = [];
  for (const s of CFG.image) for (const n of qsa(s)) if (n && n.tagName === 'IMG' && pageImgs.indexOf(n) < 0 && !inUser(n)) pageImgs.push(n);
  for (const im of pageImgs) addTurn(closestOf(im, CFG.turn) || im.parentElement);
  const top = turns.filter((t) => !turns.some((o) => o !== t && o.contains(t)));
  top.sort((a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & 4) ? -1 : 1));
  const last = top.length ? top[top.length - 1] : null;
  const blurOf = (im) => {
    let n = im;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      if (last && n === last.parentElement) break;
      try { const f = getComputedStyle(n).filter || ''; const m = /blur\(([\d.]+)px\)/.exec(f); if (m && Number(m[1]) > 0.5) return true; } catch (_) {}
      if (i === 0 && /(^|\s)blur(-|\s|$)/.test(String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || ''))) return true;
    }
    return false;
  };
  const AVATAR = /avatar|profile|logo|icon|emoji|favicon/i;
  const describe = (im) => {
    const r = im.getBoundingClientRect();
    const src = im.currentSrc || im.src || '';
    const cls = String(im.className && im.className.baseVal !== undefined ? im.className.baseVal : im.className || '');
    const alt = String(im.getAttribute('alt') || '');
    return {
      src: src.length > 4000 ? src.slice(0, 4000) : src, alt: alt.slice(0, 120),
      nw: im.naturalWidth || 0, nh: im.naturalHeight || 0, w: Math.round(r.width), h: Math.round(r.height),
      complete: !!im.complete && (im.naturalWidth || 0) > 0, blurred: blurOf(im),
      hidden: im.getAttribute('aria-hidden') === 'true' || !shown(im),
      avatar: AVATAR.test(alt) || AVATAR.test(cls) || /avatar|favicon|\.svg(\?|$)/i.test(src) || !!(im.closest && im.closest('button')),
      tooLong: src.length > 4000,
    };
  };
  let images = [];
  let progress = false;
  let text = '';
  if (last) {
    const seen = [];
    const add = (im) => { if (im && im.tagName === 'IMG' && seen.indexOf(im) < 0 && last.contains(im)) seen.push(im); };
    for (const s of CFG.image) for (const n of qsa(s)) add(n);
    for (const n of qsa('img', last)) add(n);
    images = seen.map(describe);
    try { text = String(last.innerText || last.textContent || '').replace(/\s+\n/g, '\n').trim(); } catch (_) { text = ''; }
    const re = new RegExp(CFG.progress, 'i');
    progress = re.test(text) || qsa('[role="progressbar"], [aria-busy="true"]', last).some(shown);
  }
  let generating = false;
  for (const s of CFG.stop) { if (qsa(s).some(shown)) { generating = true; break; } }
  let inputFound = false;
  for (const s of CFG.input) { if (qsa(s).some(shown)) { inputFound = true; break; } }
  let loggedOut = false;
  if (!inputFound) {
    const clickable = qsa('button, a, [role="button"]').filter(shown).map((b) => String(b.innerText || b.textContent || '').trim()).join(' | ');
    loggedOut = /\b(log ?in|sign ?in|sign ?up)\b/i.test(clickable);
  }
  const notes = [];
  for (const s of CFG.notice) for (const n of qsa(s)) {
    if (!shown(n) || (last && last.contains(n)) || notes.length >= 6) continue;
    const t = String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 400 && notes.indexOf(t) < 0) notes.push(t);
  }
  return {
    ok: true, url: String(location.href).slice(0, 300), turns: top.length, generating, inputFound, loggedOut, notice: notes.join(' · '),
    srcs: pageImgs.concat(last ? qsa('img', last) : []).map((im) => im.currentSrc || im.src || '').filter(Boolean).slice(-300),
    last: last ? { text: text.slice(0, 2000), images, progress } : null,
  };
}
async function pageFetch(CFG) {
  const toB64 = (u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); };
  const kind = (u8) => (u8[0] === 0x89 && u8[1] === 0x50 ? 'png' : u8[0] === 0xff && u8[1] === 0xd8 ? 'jpeg' : u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45 ? 'webp' : u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70 ? 'avif' : '');
  const canvasPng = async (source, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0);
    const out = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!out) throw new Error('canvas gave no PNG');
    return new Uint8Array(await out.arrayBuffer());
  };
  try {
    let blob = null; let how = 'fetch'; let u8 = null;
    try {
      const r = await fetch(CFG.src, { credentials: 'include' });
      if (!r.ok) return { ok: false, error: 'HTTP_' + r.status };
      blob = await r.blob();
    } catch (e) {
      // fetch blocked: draw the shown <img> itself (works when the picture is CORS-clean)
      const im = Array.prototype.slice.call(document.images).find((i) => i.currentSrc === CFG.src || i.src === CFG.src);
      if (!im || !im.naturalWidth) return { ok: false, error: 'FETCH_FAILED', detail: String(e).slice(0, 200) };
      try { u8 = await canvasPng(im, im.naturalWidth, im.naturalHeight); how = 'canvas'; } catch (e2) { return { ok: false, error: 'FETCH_FAILED', detail: String(e2).slice(0, 200) }; }
    }
    if (blob && blob.size > CFG.maxBytes) return { ok: false, error: 'TOO_BIG', bytes: blob.size };
    if (!u8) u8 = new Uint8Array(await blob.arrayBuffer());
    let k = kind(u8); let converted = false;
    if (k !== 'png' && k !== 'jpeg') {
      try { const bmp = await createImageBitmap(blob || new Blob([u8])); u8 = await canvasPng(bmp, bmp.width, bmp.height); converted = k || 'unknown'; k = 'png'; }
      catch (e) { return { ok: false, error: 'CONVERT_FAILED', mime: blob ? blob.type : '', detail: String(e).slice(0, 200) }; }
    }
    return { ok: true, b64: toB64(u8), kind: k, mime: blob ? blob.type || '' : 'image/png', bytes: u8.length, converted, how };
  } catch (e) { return { ok: false, error: 'FETCH_FAILED', detail: String(e).slice(0, 200) }; }
}
async function pageConvert(CFG) {
  try {
    const bin = atob(CFG.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: CFG.mime || '' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
    const out = await new Promise((res) => c.toBlob(res, 'image/png'));
    const o8 = new Uint8Array(await out.arrayBuffer());
    let s = ''; for (let i = 0; i < o8.length; i += 0x8000) s += String.fromCharCode.apply(null, o8.subarray(i, i + 0x8000));
    return { ok: true, b64: btoa(s) };
  } catch (e) { return { ok: false, error: 'CONVERT_FAILED', detail: String(e).slice(0, 200) }; }
}
/* eslint-enable no-undef */
function cfgJson(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function buildScanScript(sel) {
  const s = sel || {};
  const cfg = {
    image: uniq([].concat(s.image || [], DEFAULT_IMAGE_CANDIDATES)), assistant: uniq([].concat(s.assistant || [], EXTRA_ASSISTANT)),
    turn: TURN_SELECTORS, user: uniq([].concat(s.user || [], USER_SELECTORS)), stop: s.stop || [], input: s.input || [],
    notice: NOTICE_SELECTORS, progress: PROGRESS_RE.source,
  };
  return `(() => { /* ${MARKER} scan */ const CFG = ${cfgJson(cfg)};\n return (${pageScan.toString()})(CFG); })()`;
}
function buildFetchScript(src, maxBytes) {
  return `(() => { /* ${MARKER} fetch */ const CFG = ${cfgJson({ src: String(src || ''), maxBytes: maxBytes || DEFAULTS.maxBytes })};\n return (${pageFetch.toString()})(CFG); })()`;
}
function buildConvertScript(b64, mime) {
  return `(() => { /* ${MARKER} convert */ const CFG = ${cfgJson({ b64: String(b64 || ''), mime: mime || '' })};\n return (${pageConvert.toString()})(CFG); })()`;
}
function uniq(a) { return Array.from(new Set(a.filter((x) => typeof x === 'string' && x.trim()))); }

// ---- errors in plain words ---------------------------------------------------------------
function explain(code, ctx) {
  const c = ctx || {};
  switch (code) {
    case 'CHATGPT_NOT_READY': return { message: `ChatGPT can't make pictures right now: ${c.why || 'its pane is not ready'}.`, hint: 'Open AutoInjector, make sure the ChatGPT pane is logged in and shows its message box, then try again (or use engine "sd").' };
    case 'IMAGE_REFUSED': return { message: c.reason ? `ChatGPT declined to make this picture: “${c.reason}”` : 'ChatGPT declined to make this picture.', hint: c.words ? 'ChatGPT answered in words instead of drawing. Ask more plainly for one picture, or use engine "sd".' : 'Change the wording (no real people, brands or graphic violence), or use engine "sd".' };
    case 'IMAGE_LIMIT': return { message: c.reason ? `ChatGPT's picture limit is reached: “${c.reason}”` : "ChatGPT's picture limit is reached.", hint: 'Wait until ChatGPT\'s limit resets (it says when), or use engine "sd".' };
    case 'IMAGE_TIMEOUT': return { message: `ChatGPT didn't finish a picture within ${Math.max(1, Math.round((c.ms || DEFAULTS.timeoutMs) / 1000))} seconds.`, hint: 'ChatGPT can be slow when it is busy: try again, or look at the ChatGPT pane. If a picture is there but was not picked up, use 🎯 → “Generated picture” on ChatGPT\'s pane.' };
    case 'IMAGE_FETCH_FAILED': return { message: `ChatGPT made the picture, but AutoInjector couldn't take it from the page (${c.why || 'download failed'}).`, hint: 'Reload the ChatGPT pane (you stay logged in) and try again.' };
    case 'CANCELLED': return { message: 'Stopped.', hint: '' };
    default: return { message: c.why || String(code || 'Failed'), hint: '' };
  }
}
function fail(code, ctx, extra) { const e = explain(code, ctx); return Object.assign({ ok: false, engine: 'chatgpt', error: code, code, message: e.message, hint: e.hint }, extra || {}); }

// Send failures (sendTextTo's codes) → the contract's codes.
function sendFailure(r) {
  const e = (r && r.error) || 'SEND_FAILED';
  if (e === 'CANCELLED') return fail('CANCELLED');
  const why = {
    NO_VIEW: 'the ChatGPT pane is missing', SITE_REPAIRING: 'you are showing AutoInjector ChatGPT\'s page right now (🎯 / 🔢)',
    PROVIDER_PAUSED: 'ChatGPT paused this conversation behind a safeguard — open its pane and start a new chat',
    INPUT_NOT_FOUND: 'ChatGPT\'s message box isn\'t on the page (logged out, or the page changed — use 🎯)', RELAY_STOPPED: 'sending is stopped (Stop AIs Talking)',
  }[e] || `the request couldn't be typed into ChatGPT (${e})`;
  return fail('CHATGPT_NOT_READY', { why }, { sendError: e });
}

// ---- the engine ----------------------------------------------------------------------------
function createChatGptImage(deps) {
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const fileUrl = typeof d.fileUrl === 'function' ? d.fileUrl : (p) => p;
  const opts = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(d.options || {})) if (v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v))) opts[k] = v;
  let chain = Promise.resolve();
  let queued = 0;
  let current = null; // { id, phase, startedAt, sentAt, purpose, view, token }
  let lastResult = null;
  let lastSeries = null;
  let jobNo = 0;

  function safe(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; } }
  function readiness() {
    if (typeof d.paneReady !== 'function') return { ready: false, code: 'NOT_WIRED', why: 'this build has no ChatGPT pane' };
    const r = safe(() => d.paneReady(), null);
    if (!r) return { ready: false, code: 'UNKNOWN', why: 'the ChatGPT pane could not be checked' };
    return { ready: !!r.ready, code: r.code || (r.ready ? 'OK' : 'NOT_READY'), why: r.why || (r.ready ? '' : 'the ChatGPT pane is not ready') };
  }
  function selectors() { return safe(() => (typeof d.selectors === 'function' ? d.selectors() : null), null) || defaultSelectors(); }
  async function page(script) {
    if (typeof d.runPage !== 'function') return { ok: false, error: 'NOT_WIRED' };
    try { const r = await d.runPage(script); return r && typeof r === 'object' ? r : { ok: false, error: 'NO_RESULT' }; }
    catch (e) { return { ok: false, error: 'SCRIPT_FAILED', detail: String((e && e.message) || e).slice(0, 200) }; }
  }
  const scan = () => page(buildScanScript(selectors()));

  function status() {
    const r = readiness();
    const t = now();
    return {
      ok: true, engine: 'chatgpt', ready: r.ready, code: r.code, why: r.ready ? undefined : r.why,
      busy: !!current, queue: queued, phase: current ? current.phase : 'idle',
      elapsedMs: current ? t - current.startedAt : 0, drawingMs: current && current.sentAt ? t - current.sentAt : 0,
      purpose: current ? current.purpose : undefined, view: current ? current.view : undefined,
      timeoutMs: opts.timeoutMs, freshChatPerSeries: !!opts.freshChatPerSeries,
      last: lastResult,
    };
  }
  function settings(patch) {
    const p = patch || {};
    if (p.freshChatPerSeries !== undefined) opts.freshChatPerSeries = !!p.freshChatPerSeries;
    if (p.timeoutMs !== undefined) { const n = Number(p.timeoutMs); if (Number.isFinite(n) && n >= 10000 && n <= 30 * 60000) opts.timeoutMs = Math.round(n); }
    return status();
  }
  function cancel() {
    if (!current) return { ok: true, cancelled: false };
    current.token.cancelled = true;
    log('chatgpt-image', { step: 'cancel', job: current.id });
    return { ok: true, cancelled: true };
  }

  // Wait until the pane shows its message box (after a fresh chat).
  async function waitForInput(ms, token) {
    const end = now() + ms;
    while (now() < end && !token.cancelled) {
      const s = await scan();
      if (s && s.ok && s.inputFound) return s;
      if (s && s.ok && s.loggedOut) return s;
      await sleep(Math.min(500, opts.pollMs));
    }
    return scan();
  }

  async function fetchBytes(src) {
    let r = await page(buildFetchScript(src, opts.maxBytes));
    let buf = null; let how = r && r.how; let why = r && (r.detail || r.error);
    if (r && r.ok && r.b64) { try { buf = Buffer.from(r.b64, 'base64'); } catch (_) { buf = null; } }
    if (!buf && typeof d.fetchViaSession === 'function' && /^https?:/i.test(src)) {
      try {
        const s = await d.fetchViaSession(src);
        if (s && s.ok && s.buffer) { buf = Buffer.from(s.buffer); how = 'session'; } else why = (s && (s.error || s.detail)) || why;
      } catch (e) { why = String((e && e.message) || e); }
    }
    if (!buf) return { ok: false, why: why || 'no bytes' };
    let info = sniff(buf);
    if (info.type !== 'png' && info.type !== 'jpeg') {
      let png = null;
      if (typeof d.toPng === 'function') { try { png = d.toPng(buf, info.type); } catch (_) { png = null; } }
      if (!png || !png.length) {
        const c = await page(buildConvertScript(buf.toString('base64'), info.type ? `image/${info.type}` : ''));
        if (c && c.ok && c.b64) { try { png = Buffer.from(c.b64, 'base64'); } catch (_) { png = null; } }
      }
      if (!png || !png.length) return { ok: false, why: `the picture is ${info.type ? info.type.toUpperCase() : 'not a picture'} and could not be turned into PNG` };
      buf = Buffer.from(png); info = sniff(buf); how = `${how || 'fetch'}+png`;
    }
    if (info.type !== 'png' && info.type !== 'jpeg') return { ok: false, why: 'what came back is not a PNG or JPEG picture' };
    if (buf.length < opts.minBytes) return { ok: false, why: `the picture is too small (${buf.length} bytes)` };
    if (info.width && info.height && (info.width < 64 || info.height < 64)) return { ok: false, why: `the picture is too small (${info.width}×${info.height})` };
    if (buf.length > opts.maxBytes) return { ok: false, why: 'the picture is too big' };
    return { ok: true, buf, info, how, converted: r && r.converted ? r.converted : (how && /\+png$/.test(how) ? 'yes' : false) };
  }

  function pickImage(sc, baseline) {
    const imgs = ((sc.last && sc.last.images) || []).filter((im) => im && im.src && !im.tooLong && im.complete && !im.hidden && !im.avatar && !baseline.srcs.has(im.src)
      && im.nw >= opts.minPx && im.nh >= opts.minPx && (im.w >= opts.minPx / 2 || im.h >= opts.minPx / 2));
    if (!imgs.length) return null;
    imgs.sort((a, b) => b.nw * b.nh - a.nw * a.nh);
    return imgs[0];
  }

  async function run(job) {
    const id = ++jobNo;
    const token = { cancelled: false };
    current = { id, phase: 'checking', startedAt: now(), sentAt: 0, purpose: job.purpose, view: job.view, token };
    const done = (r) => { lastResult = { ok: !!r.ok, error: r.ok ? undefined : r.error, at: now(), purpose: job.purpose, view: job.view }; log('chatgpt-image', { step: 'done', job: id, ok: !!r.ok, error: r.ok ? undefined : r.error, purpose: job.purpose, view: job.view, ms: now() - current.startedAt }); return r; };
    const rd = readiness();
    if (!rd.ready) { const r = done(fail('CHATGPT_NOT_READY', { why: rd.why }, { why: rd.code })); current = null; return r; }
    let held = false;
    try {
      // Let a reply ChatGPT is still writing (a relay, an Akọwe prompt) finish and be captured first.
      if (typeof d.prepare === 'function') { current.phase = 'waiting'; try { await d.prepare(token); } catch (_) {} }
      if (token.cancelled) return done(fail('CANCELLED'));
      if (typeof d.hold === 'function') { try { d.hold(true, { job: id }); held = true; } catch (_) {} }
      if (typeof d.makeWay === 'function') { current.phase = 'waiting'; try { await d.makeWay(token); } catch (_) {} }
      if (token.cancelled) return done(fail('CANCELLED'));
      const fresh = !!job.newChat || (!!opts.freshChatPerSeries && !!job.series && job.series !== lastSeries);
      if (fresh && typeof d.newChat === 'function') {
        current.phase = 'new-chat';
        log('chatgpt-image', { step: 'new-chat', job: id, why: job.newChat ? 'asked' : 'new series' });
        let nc = null; try { nc = await d.newChat(); } catch (_) { nc = { ok: false }; }
        if (!nc || nc.ok === false) return done(fail('CHATGPT_NOT_READY', { why: 'a new ChatGPT chat could not be opened' }));
        await waitForInput(opts.newChatWaitMs, token);
      }
      if (job.series) lastSeries = job.series;
      const base = await scan();
      if (!base || !base.ok) return done(fail('CHATGPT_NOT_READY', { why: `the ChatGPT page can't be read (${(base && base.error) || 'no answer'})` }));
      if (base.loggedOut) return done(fail('CHATGPT_NOT_READY', { why: 'ChatGPT looks logged out — open its pane and log in' }));
      if (base.inputFound === false) return done(fail('CHATGPT_NOT_READY', { why: 'ChatGPT\'s message box isn\'t on the page (logged out, or the page changed — use 🎯)' }));
      if (base.notice && LIMIT_RE.test(base.notice)) return done(fail('IMAGE_LIMIT', { reason: firstSentence(base.notice) }));
      const baseline = { turns: Number(base.turns) || 0, srcs: new Set(base.srcs || []) };
      if (token.cancelled) return done(fail('CANCELLED'));
      current.phase = 'sending';
      let s;
      try { s = await d.send(String(job.text || ''), { cancelToken: token }); } catch (e) { s = { ok: false, error: String((e && e.message) || e) }; }
      if (!s || !s.ok) return done(sendFailure(s));
      current.phase = 'drawing';
      current.sentAt = now();
      log('chatgpt-image', { step: 'sent', job: id, purpose: job.purpose, view: job.view });
      const timeoutMs = Math.max(500, Number(job.timeoutMs) || opts.timeoutMs);
      let prevKey = ''; let stable = 0; let prevText = null; let textSince = 0; let readFails = 0; let pick = null;
      while (now() - current.sentAt < timeoutMs) {
        if (token.cancelled) return done(fail('CANCELLED'));
        await sleep(opts.pollMs);
        const sc = await scan();
        if (!sc || !sc.ok) { if (++readFails >= 20) return done(fail('CHATGPT_NOT_READY', { why: 'the ChatGPT page stopped answering' })); continue; }
        readFails = 0;
        if (sc.loggedOut) return done(fail('CHATGPT_NOT_READY', { why: 'ChatGPT logged out while drawing — open its pane and log in' }));
        if (sc.notice && LIMIT_RE.test(sc.notice)) return done(fail('IMAGE_LIMIT', { reason: firstSentence(sc.notice) }));
        if (!(sc.turns > baseline.turns) || !sc.last) continue;
        const cand = pickImage(sc, baseline);
        if (cand) {
          current.phase = cand.blurred ? 'drawing' : 'finishing';
          const key = `${cand.src}|${cand.nw}x${cand.nh}|${cand.blurred ? 'b' : ''}`;
          if (key === prevKey) stable++; else { prevKey = key; stable = 1; }
          if (!cand.blurred && stable >= opts.stableReads && (!sc.generating || stable >= opts.stableReadsWriting)) { pick = cand; break; }
          continue;
        }
        if (sc.generating || sc.last.progress) { textSince = 0; prevText = null; continue; }
        const text = String(sc.last.text || '').trim();
        if (!text) continue;
        if (text !== prevText) { prevText = text; textSince = now(); continue; }
        const quiet = now() - textSince;
        const kind = classifyText(text);
        if (kind === 'limit' && quiet >= opts.textSettleMs) return done(fail('IMAGE_LIMIT', { reason: firstSentence(text) }));
        if (kind === 'refused' && quiet >= opts.textSettleMs) return done(fail('IMAGE_REFUSED', { reason: firstSentence(text) }));
        if (quiet >= opts.noImageMs) return done(fail('IMAGE_REFUSED', { reason: firstSentence(text), words: true }));
      }
      if (!pick) return done(fail('IMAGE_TIMEOUT', { ms: timeoutMs }));
      current.phase = 'saving';
      const f = await fetchBytes(pick.src);
      if (!f.ok) return done(fail('IMAGE_FETCH_FAILED', { why: f.why }));
      const record = Object.assign({}, job.record || {}, {
        engine: 'chatgpt', backend: 'chatgpt', label: 'ChatGPT', purpose: job.purpose || 'free', view: job.view || undefined,
        prompt: (job.record && job.record.prompt) || job.text, chatgptPrompt: job.text, width: f.info.width || pick.nw, height: f.info.height || pick.nh,
        from: job.from || 'images-tab', series: job.series || undefined, newChat: job.newChat ? true : undefined, fetchedVia: f.how, converted: f.converted || undefined,
        seconds: Math.round((now() - current.sentAt) / 1000),
      });
      let saved;
      try { saved = sdImages.saveGeneration(d.imagesDir(), [f.buf.toString('base64')], record, { prefix: job.prefix || (job.purpose && job.purpose !== 'free' ? `${job.purpose}${job.view ? `-${job.view}` : ''}` : 'chatgpt') }); }
      catch (e) { return done(fail('IMAGE_FETCH_FAILED', { why: `the picture couldn't be saved: ${(e && e.message) || e}` }, { error: 'SAVE_FAILED', code: 'SAVE_FAILED' })); }
      if (!saved || !saved.length) return done(fail('IMAGE_FETCH_FAILED', { why: 'nothing was saved' }));
      for (const sv of saved) { try { if (typeof d.recordImage === 'function') d.recordImage({ path: sv.path, prompt: sv.record.prompt, seed: null, model: 'chatgpt', from: record.from, sha256: sv.sha256 }); } catch (_) {} }
      const out = {
        ok: true, engine: 'chatgpt', backend: 'chatgpt', purpose: record.purpose, view: job.view || undefined, seed: null, warnings: [], settings: saved[0].record,
        images: saved.map((sv) => ({ path: sv.path, url: fileUrl(sv.path), json: sv.json, sha256: sv.sha256, width: record.width, height: record.height })),
      };
      if (job.returnImage) out.images.forEach((im) => { im.imageBase64 = f.buf.toString('base64'); });
      return done(out);
    } catch (e) {
      return done(fail('IMAGE_FETCH_FAILED', { why: `something went wrong: ${(e && e.message) || e}` }, { error: 'INTERNAL', code: 'INTERNAL' }));
    } finally {
      current = null;
      if (held) { try { d.hold(false, { job: id }); } catch (_) {} }
      if (typeof d.afterJob === 'function') { try { await d.afterJob(); } catch (_) {} }
    }
  }

  // One at a time: two image jobs never type into ChatGPT at once.
  function generate(job) {
    const j = job || {};
    if (!String(j.text || '').trim()) return Promise.resolve(fail('CHATGPT_NOT_READY', { why: 'there is nothing to ask ChatGPT to draw' }, { error: 'NEED_PROMPT', code: 'NEED_PROMPT', message: 'Send a prompt (what to draw) and/or a characterLock.' }));
    queued++;
    const p = chain.then(() => { queued--; return run(j); }, () => { queued--; return run(j); });
    chain = p.then(() => {}, () => {});
    return p.catch((e) => fail('IMAGE_FETCH_FAILED', { why: String((e && e.message) || e) }));
  }

  return { generate, status, settings, cancel, readiness, scan: () => scan(), options: () => Object.assign({}, opts) };
}

function defaultSelectors() {
  let S = null;
  try { S = require('./selectors').chatgpt; } catch (_) { S = null; }
  const s = S || {};
  return { image: s.IMAGE_CANDIDATES || DEFAULT_IMAGE_CANDIDATES, assistant: s.ASSISTANT_CANDIDATES || [], stop: s.STOP_CANDIDATES || [], input: s.INPUT_CANDIDATES || [], user: USER_SELECTORS };
}

module.exports = {
  createChatGptImage, buildScanScript, buildFetchScript, buildConvertScript, sniff, classifyText, firstSentence, explain, defaultSelectors,
  DEFAULTS, MARKER, LIMIT_RE, REFUSE_RE, PROGRESS_RE, DEFAULT_IMAGE_CANDIDATES,
};
