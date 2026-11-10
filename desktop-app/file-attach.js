'use strict';
/**
 * file-attach.js — put a real file (a picture, a PDF) into an AI pane's chat, and make sure it shows there.
 *
 * Sites change how their "attach" works without warning (claude.ai, 2026-11: there was no <input type=file> in the page
 * any more, so the old "find the input" step failed with NO_FILE_INPUT_FOUND every time). This tries, in order:
 *   input   an <input type=file> already in the page — also inside open shadow roots and same-origin frames — found by
 *           the site's candidates first, then any file input whose accept= takes pictures (or has no accept=)
 *   deep    the same through DevTools' own DOM tree (it also sees CLOSED shadow roots)
 *   reveal  click the composer's attach / "+" / paperclip button (and then an "Upload a file" menu item) by its
 *           aria-label / data-testid / title / text, while DevTools intercepts the file chooser it opens — no window
 *           pops up — or picks up the file input that appears
 *   paste   a paste into the composer carrying the file (ClipboardEvent + DataTransfer)
 *   drop    a drop of the file on the composer (DragEvent + DataTransfer)
 * After each step the page is checked for the attachment (the file input holding it, a thumbnail / preview / file chip
 * near the composer, a new picture, the file's name, a "Remove" button) before the next step is tried. Nothing found to
 * use → NO_FILE_INPUT_FOUND; something was tried but the page never showed the file → ATTACH_NOT_SEEN.
 *
 * The orchestration takes a DevTools session `dbg` ({ sendCommand(method, params), on/removeListener('message') } —
 * Electron's webContents.debugger), so it is the same for ChatGPT, Claude and Gemini and unit-testable with a fake.
 * Logs carry codes and counts only (never the file's contents or the chat's text).
 */
const fs = require('fs');
const path = require('path');

const METHODS = ['input', 'deep', 'reveal', 'paste', 'drop'];
const MAX_INLINE_BYTES = 25 * 1024 * 1024; // paste / drop carry the bytes through DevTools; bigger files skip them
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function mimeOf(p) { return MIME[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream'; }

// Buttons that open the attach menu / the file chooser, and the menu items that then pick "a file from this computer".
// Matched against aria-label, data-testid, title and the visible text (≤ 40 chars). Never anything that removes,
// connects another service, or takes a screenshot / photo.
const REVEAL_RX = '(attach|upload|paperclip|paper-clip|add (a |an )?(files?|photos?|images?|pictures?|content|attachments?)|add files|files? (and|or|&) photos|insert (a |an )?(file|image|photo|picture)|open (the )?(attachments?|upload|plus|file)[- ]?(menu)?|plus[-_ ]?(menu|button)|input[-_ ]?plus|file[-_ ]?(upload|picker|input|button)|^\\+$|^add$)';
const MENU_RX = '(upload|add (a |an )?(files?|photos?|images?)|add files|files? (and|or|&) photos|from (your |this )?(computer|device)|browse|choose (a )?files?|^attach|local files?)';
const NO_RX = '(remove|delete|clear|drive|github|notion|gmail|calendar|dropbox|onedrive|sharepoint|connector|integration|project|screenshot|camera|capture|record|research|search|voice|mic|style|tool|settings|share|link|emoji|gif)';
const PREVIEW_SEL = [
  '[data-testid*="attachment" i]', '[data-testid*="thumbnail" i]', '[data-testid*="file-preview" i]', '[data-testid*="file-chip" i]',
  '[data-testid*="uploaded" i]', '[data-testid*="file-card" i]', '[class*="attachment" i]', '[class*="thumbnail" i]', '[class*="file-preview" i]',
  '[class*="file-chip" i]', '[aria-label^="remove" i]', '[aria-label*="remove file" i]', '[aria-label*="remove attachment" i]', '[aria-label*="remove image" i]',
].join(',');

// Shared page-side helpers (a plain string so it can be put into any Runtime.evaluate expression).
function pageLib(o) {
  const cfg = JSON.stringify({
    composer: (o && o.composer) || [], candidates: (o && o.candidates) || [], name: (o && o.name) || '',
    preview: PREVIEW_SEL, reveal: REVEAL_RX, menu: MENU_RX, no: NO_RX,
  });
  return `
    const CFG = ${cfg};
    const roots = () => {
      const out = [document]; const seen = new Set();
      const walk = (r) => {
        let all = [];
        try { all = r.querySelectorAll('*'); } catch (_) { return; }
        for (const el of all) {
          if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); out.push(el.shadowRoot); walk(el.shadowRoot); }
          if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d && !seen.has(d)) { seen.add(d); out.push(d); walk(d); } } catch (_) {} }
        }
      };
      walk(document); return out;
    };
    const deepAll = (sel) => { const out = []; for (const r of roots()) { try { out.push(...r.querySelectorAll(sel)); } catch (_) {} } return out; };
    const visible = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (_) { return false; } };
    const composer = () => {
      for (const sel of CFG.composer) { const hit = deepAll(sel).find(visible); if (hit) return hit; }
      const a = document.activeElement; if (a && (a.isContentEditable || a.tagName === 'TEXTAREA')) return a;
      return deepAll('[contenteditable="true"],textarea').find(visible) || null;
    };
    const acceptsPictures = (inp) => {
      const a = String(inp.getAttribute('accept') || '').trim().toLowerCase();
      if (!a) return 1;
      if (/image|\\*\\/\\*|\\.png|\\.jpe?g|\\.webp/.test(a)) return 2;
      return -1; // accept= that leaves pictures out (e.g. only .pdf, or audio/*)
    };
    const near = (a, b) => { if (!a || !b) return false; let p = b; for (let i = 0; i < 7 && p; i++) { if (p.contains && p.contains(a)) return true; p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null; } return false; };
    const findInput = () => {
      const ed = composer(); let best = null; let bs = -1;
      const listed = new Set(); for (const sel of CFG.candidates) for (const el of deepAll(sel)) listed.add(el);
      for (const inp of deepAll('input[type="file" i]')) {
        if (inp.disabled) continue;
        const acc = acceptsPictures(inp); if (acc < 0) continue;
        const s = acc + (listed.has(inp) ? 1 : 0) + (near(inp, ed) ? 2 : 0);
        if (s > bs) { bs = s; best = inp; }
      }
      return best;
    };
    const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-testid'), el.getAttribute('title'), (el.textContent || '').trim().length <= 40 ? (el.textContent || '').trim() : ''].filter(Boolean).map(String);
    const evidence = () => {
      const ed = composer();
      let files = 0; for (const i of deepAll('input[type="file" i]')) if (!ed || near(i, ed)) files += (i.files && i.files.length) || 0; // an input far from the composer (a profile picture, a project upload) proves nothing
      const previews = deepAll(CFG.preview).length;
      const blobImgs = deepAll('img').filter((im) => /^(blob|data):/.test(String(im.currentSrc || im.src || ''))).length;
      let box = ed; for (let i = 0; i < 5 && box && box.parentElement; i++) box = box.parentElement;
      const nearImgs = box ? box.querySelectorAll('img,canvas,[role="img"]').length : 0;
      let names = 0;
      if (CFG.name) for (const r of roots()) { const b = r.body || r; const t = (b && (b.innerText || b.textContent)) || ''; names += t.split(CFG.name).length - 1; }
      return { files, previews, blobImgs, nearImgs, names };
    };`;
}

/** Runtime.evaluate (returnByValue: false) → the best file input element, or null. */
function buildFinderExpression(o) { return `(() => { ${pageLib(o)}\n return findInput(); })()`; }
/** Runtime.evaluate (returnByValue: true) → counts of signs that a file is attached. */
function buildEvidenceExpression(o) { return `(() => { ${pageLib(o)}\n return evidence(); })()`; }
/**
 * Runtime.evaluate (returnByValue: true) → the attach button (level 1) or menu item (level 2) to click:
 * { found, x, y, inView, how } — it is marked with data-ai-attach-target so a fallback click can find it again.
 */
function buildRevealExpression(o, level, peek) {
  return `(() => { ${pageLib(o)}
    const RX = new RegExp(${level === 2 ? 'CFG.menu' : 'CFG.reveal'}, 'i'); const NO = new RegExp(CFG.no, 'i');
    const ed = composer(); const er = ed ? ed.getBoundingClientRect() : null;
    const sel = ${level === 2 ? `'[role="menuitem"],[role="option"],[role="menuitemradio"],[role="menu"] button,[role="menu"] [tabindex],[role="listbox"] [tabindex],[data-radix-popper-content-wrapper] button,[data-radix-popper-content-wrapper] [role],label[for],button,[role="button"]'` : `'button,[role="button"],label[for],[aria-haspopup],input[type="button"]'`};
    const tried = new Set(String(document.documentElement.getAttribute('data-ai-attach-tried') || '').split('|').filter(Boolean));
    let best = null; let bd = Infinity;
    for (const el of deepAll(sel)) {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const labels = labelOf(el); if (!labels.length) continue;
      if (!labels.some((t) => RX.test(t)) || labels.some((t) => NO.test(t))) continue;
      const r = el.getBoundingClientRect(); const key = Math.round(r.left) + ',' + Math.round(r.top) + ',' + labels[0];
      if (tried.has(key)) continue;
      const d = er ? Math.hypot((r.left + r.width / 2) - (er.left + er.width / 2), (r.top + r.height / 2) - (er.top + er.height / 2)) : 0;
      if (d < bd) { bd = d; best = { el, key }; }
    }
    if (!best) return { found: false };
    if (${peek ? 'true' : 'false'}) return { found: true };
    for (const old of deepAll('[data-ai-attach-target]')) old.removeAttribute('data-ai-attach-target');
    tried.add(best.key); document.documentElement.setAttribute('data-ai-attach-tried', Array.from(tried).join('|'));
    best.el.setAttribute('data-ai-attach-target', '1');
    try { best.el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    const r = best.el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    let top = null; try { top = document.elementFromPoint(x, y); } catch (_) {}
    const inView = !!top && (top === best.el || best.el.contains(top) || (top.shadowRoot && top === best.el.getRootNode().host));
    return { found: true, x, y, inView };
  })()`;
}
/** The fallback click (when the button can't be clicked with the mouse): pointer + mouse events, then click(). */
function buildSyntheticClickExpression() {
  return `(() => { const el = (function f(r) { const h = r.querySelector('[data-ai-attach-target]'); if (h) return h; for (const e of r.querySelectorAll('*')) if (e.shadowRoot) { const x = f(e.shadowRoot); if (x) return x; } return null; })(document);
    if (!el) return false; const o = { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: 'mouse', isPrimary: true };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {} el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) {} el.dispatchEvent(new MouseEvent('mouseup', o)); el.click(); return true; })()`;
}
/** paste / drop: the file rebuilt in the page from base64 and handed to the composer. → { ok, target, handled } */
function buildCarryExpression(o, kind, file) {
  return `(() => { ${pageLib(o)}
    const F = ${JSON.stringify({ name: file.name, type: file.type })};
    const bin = atob(${JSON.stringify(file.b64)}); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], F.name, { type: F.type, lastModified: Date.now() });
    const dt = new DataTransfer(); dt.items.add(file);
    const ed = composer(); const target = ed || document.body;
    try { target.focus(); } catch (_) {}
    const give = (ev, prop) => { if (!ev[prop]) { try { Object.defineProperty(ev, prop, { value: dt }); } catch (_) {} } return ev; };
    let handled = false;
    if (${JSON.stringify(kind)} === 'paste') {
      const ev = give(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }), 'clipboardData');
      target.dispatchEvent(ev); handled = ev.defaultPrevented;
    } else {
      const r = target.getBoundingClientRect(); const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const ev = give(new DragEvent(type, Object.assign({ dataTransfer: dt, bubbles: true, cancelable: true, composed: true }, at)), 'dataTransfer');
        try { dt.dropEffect = 'copy'; } catch (_) {}
        target.dispatchEvent(ev); if (type === 'drop') handled = ev.defaultPrevented;
      }
    }
    return { ok: true, target: ed ? 'composer' : 'body', handled };
  })()`;
}

function grew(before, after) {
  if (!before || !after) return false;
  return ['files', 'previews', 'blobImgs', 'nearImgs', 'names'].some((k) => (Number(after[k]) || 0) > (Number(before[k]) || 0));
}

// DevTools' DOM tree (pierce: true) → backendNodeIds of every <input type=file> that takes pictures, closed shadow roots too.
function fileInputsInTree(root) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeName === 'INPUT' && Array.isArray(n.attributes)) {
      const a = {}; for (let i = 0; i + 1 < n.attributes.length; i += 2) a[String(n.attributes[i]).toLowerCase()] = String(n.attributes[i + 1]);
      const acc = (a.accept || '').toLowerCase();
      if ((a.type || '').toLowerCase() === 'file' && !('disabled' in a) && (!acc || /image|\*\/\*|\.png|\.jpe?g|\.webp/.test(acc))) out.push({ backendNodeId: n.backendNodeId, score: acc ? 2 : 1 });
    }
    for (const k of n.children || []) walk(k);
    for (const k of n.shadowRoots || []) walk(k);
    if (n.contentDocument) walk(n.contentDocument);
    if (n.templateContent) walk(n.templateContent);
  };
  walk(root);
  return out.sort((x, y) => y.score - x.score);
}

/**
 * Attach `filePath` through the DevTools session `dbg` (already attached by the caller).
 * o: { composer: [selectors], candidates: [file input selectors], verify = true, verifyMs, revealWaitMs, methods, readFile, sleep, log }
 * → { ok: true, how, verified } | { ok: false, error: 'NO_FILE_INPUT_FOUND' | 'ATTACH_NOT_SEEN' | ..., tried: ['input:none', 'reveal:not-seen', ...] }
 */
async function attachFile(dbg, filePath, o = {}) {
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const verify = o.verify !== false;
  const verifyMs = Number(o.verifyMs) >= 0 ? Number(o.verifyMs) : 5000;
  const revealWaitMs = Number(o.revealWaitMs) >= 0 ? Number(o.revealWaitMs) : 1500;
  const methods = (Array.isArray(o.methods) && o.methods.length ? o.methods : METHODS).filter((m) => METHODS.includes(m));
  const name = path.basename(String(filePath || ''));
  const lib = { composer: o.composer || [], candidates: o.candidates || [], name: name.length >= 5 ? name : '' };
  const tried = [];
  const usedNodes = new Set();
  let anyTried = false;
  const evalValue = async (expression, extra) => {
    const r = await dbg.sendCommand('Runtime.evaluate', Object.assign({ expression, returnByValue: true, awaitPromise: false }, extra || {}));
    if (r && r.exceptionDetails) throw new Error('EVAL_EXCEPTION');
    return r && r.result ? r.result.value : undefined;
  };
  const snapshot = async () => { try { return (await evalValue(buildEvidenceExpression(lib))) || null; } catch (_) { return null; } };
  // has the page taken it? polls up to verifyMs (a site may upload first, then show the chip)
  const seen = async (before) => {
    if (!canCheck) return true;
    const end = Date.now() + verifyMs;
    for (;;) {
      const now = await snapshot();
      if (grew(before, now)) return true;
      if (Date.now() >= end) return false;
      await sleep(Math.min(250, Math.max(10, verifyMs / 10)));
    }
  };
  const setFiles = async (target) => { await dbg.sendCommand('DOM.setFileInputFiles', Object.assign({ files: [filePath] }, target)); };
  const findInputObject = async () => {
    const r = await dbg.sendCommand('Runtime.evaluate', { expression: buildFinderExpression(lib), returnByValue: false });
    return r && r.result && r.result.subtype !== 'null' && r.result.objectId ? r.result.objectId : null;
  };
  const release = async (objectId) => { try { await dbg.sendCommand('Runtime.releaseObject', { objectId }); } catch (_) {} };
  const done = (how, verified) => ({ ok: true, how, verified, tried: tried.concat(`${how}:ok`) });

  let before = await snapshot();
  // a page that can't report anything (a script error, an old test stand-in) can't be checked: the old "set it and go"
  const canCheck = verify && !!before;

  // 1. a file input already in the page (open shadow roots and frames included)
  if (methods.includes('input')) {
    let objectId = null;
    try { objectId = await findInputObject(); } catch (_) { tried.push('input:eval-failed'); }
    if (objectId) {
      anyTried = true;
      try { const d = await dbg.sendCommand('DOM.describeNode', { objectId }); if (d && d.node && d.node.backendNodeId) usedNodes.add(d.node.backendNodeId); } catch (_) {}
      try { await setFiles({ objectId }); } catch (_) { tried.push('input:set-failed'); objectId = await release(objectId); }
      if (objectId) { await release(objectId); if (await seen(before)) return done('input', canCheck); tried.push('input:not-seen'); before = (await snapshot()) || before; }
    } else if (!tried.length) tried.push('input:none');
  }

  // 2. DevTools' own tree: closed shadow roots too
  if (methods.includes('deep')) {
    try {
      const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const found = fileInputsInTree(doc && doc.root);
      if (!found.length) tried.push('deep:none');
      const fresh = found.filter((f) => !usedNodes.has(f.backendNodeId)); // never the same input twice (a second copy of the file)
      if (found.length && !fresh.length) tried.push('deep:same-input');
      for (const f of fresh.slice(0, 3)) {
        anyTried = true;
        try { await setFiles({ backendNodeId: f.backendNodeId }); } catch (_) { tried.push('deep:set-failed'); continue; }
        if (await seen(before)) return done('deep', canCheck);
        tried.push('deep:not-seen'); before = (await snapshot()) || before;
      }
    } catch (_) { tried.push('deep:failed'); }
  }

  // 3. click the attach / "+" button (then "Upload a file"), catching the file chooser it opens
  if (methods.includes('reveal')) {
    let intercept = false;
    let chooser = null;
    const onMsg = (_e, method, params) => { if (method === 'Page.fileChooserOpened' && params) chooser = params; };
    try {
      await dbg.sendCommand('Page.enable', {});
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      intercept = true;
    } catch (_) { tried.push('reveal:no-intercept'); } // never click without it: a real file window would pop up
    if (intercept) {
      try { if (dbg.on) dbg.on('message', onMsg); } catch (_) {}
      let clicks = 0; let ok = null;
      try {
        for (let level = 1, step = 0; step < 4 && level <= 2; step++) {
          let t = null;
          try { t = await evalValue(buildRevealExpression(lib, level)); } catch (_) { t = null; }
          if (!t || !t.found) { if (level === 1 && clicks === 0) tried.push('reveal:no-button'); break; }
          clicks++; anyTried = true;
          chooser = null;
          if (t.inView) {
            try {
              for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
            } catch (_) { await evalValue(buildSyntheticClickExpression(), { userGesture: true }).catch(() => {}); }
          } else await evalValue(buildSyntheticClickExpression(), { userGesture: true }).catch(() => {});
          // what did the click do? a file chooser, a file input, or a menu to look into
          const end = Date.now() + revealWaitMs;
          let menu = false;
          let next = null;
          while (Date.now() < end && !chooser) {
            await sleep(60);
            if (chooser) break;
            let id = null; try { id = await findInputObject(); } catch (_) {}
            if (id) { next = id; break; }
            if (level === 1) { try { const m = await evalValue(buildRevealExpression(lib, 2, true)); if (m && m.found) { menu = true; break; } } catch (_) {} }
          }
          if (chooser && chooser.backendNodeId) {
            try { await setFiles({ backendNodeId: chooser.backendNodeId }); if (await seen(before)) { ok = done('reveal', canCheck); return ok; } tried.push('reveal:not-seen'); } catch (_) { tried.push('reveal:set-failed'); }
            break;
          }
          if (next) {
            try { await setFiles({ objectId: next }); await release(next); if (await seen(before)) { ok = done('reveal', canCheck); return ok; } tried.push('reveal:not-seen'); } catch (_) { tried.push('reveal:set-failed'); }
            break;
          }
          if (menu) { level = 2; continue; }
          // nothing happened: try the next-nearest matching button at this level
        }
        if (clicks && !tried.some((x) => x.startsWith('reveal:'))) tried.push('reveal:nothing-opened');
      } finally {
        try { if (dbg.removeListener) dbg.removeListener('message', onMsg); } catch (_) {}
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) {}
        try { await evalValue("document.documentElement.removeAttribute('data-ai-attach-tried')"); } catch (_) {}
        if (clicks && !ok) { // close a menu we left open
          try { for (const type of ['rawKeyDown', 'keyUp']) await dbg.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); } catch (_) {}
        }
      }
      before = (await snapshot()) || before;
    }
  }

  // 4–5. paste, then drop, into the composer
  const carry = methods.filter((m) => m === 'paste' || m === 'drop');
  if (carry.length) {
    let buf = null;
    try {
      const size = fs.statSync(filePath).size;
      if (size > MAX_INLINE_BYTES) tried.push('paste:too-big');
      else buf = (o.readFile || fs.readFileSync)(filePath);
    } catch (_) { tried.push('paste:no-file'); }
    if (buf) {
      const file = { name: name || 'file', type: mimeOf(filePath), b64: Buffer.from(buf).toString('base64') };
      for (const kind of carry) {
        let r = null;
        try { r = await evalValue(buildCarryExpression(lib, kind, file)); } catch (_) { tried.push(`${kind}:eval-failed`); continue; }
        if (!r || !r.ok) { tried.push(`${kind}:failed`); continue; }
        anyTried = true;
        if (canCheck ? await seen(before) : r.handled) return done(kind, canCheck);
        tried.push(`${kind}:not-seen`); before = (await snapshot()) || before;
      }
    }
  }
  return { ok: false, error: anyTried ? 'ATTACH_NOT_SEEN' : 'NO_FILE_INPUT_FOUND', tried };
}

module.exports = { attachFile, buildFinderExpression, buildEvidenceExpression, buildRevealExpression, buildCarryExpression, fileInputsInTree, grew, mimeOf, METHODS, REVEAL_RX, MENU_RX, NO_RX };
