'use strict';
// test/fake-dom.js — a tiny, dependency-free stand-in for a browser DOM, just
// big enough to run the REAL page scripts the self-repair code injects into a
// pane (self-repair.js pageKit: page search, alternative selectors, the teach
// watcher, page signals) in plain Node. NOT a browser: no layout, no CSS
// cascade, no events beyond what the tests dispatch by hand. jsdom-free on
// purpose (P18 tests must run where jsdom isn't installed).
//
//   const { parseHTML } = require('./fake-dom');
//   const doc = parseHTML('<div data-x="1"><p>hi</p></div>', { url: 'https://chatgpt.com/' });
//   doc.querySelectorAll('div[data-x] > p')
//   runScript(script, doc) -> runs a page-script string with `document`,
//                             `window` and `location` bound to the fake page.
//
// Selector support: tag, *, #id, .class, [a], [a=v], [a~=v], [a*=v], [a^=v],
// [a$=v], [a|=v] (+ " i" flag), :not(list), :has(list), :first-child,
// :last-child, descendant (" ") and child (">") combinators, comma lists.
// Visibility: an element is hidden (zero-size rect) when it or an ancestor has
// the `hidden` attribute or style display:none.

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'param', 'track']);
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title']);

class Node {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; this.ownerDocument = null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
  get textContent() {
    if (this.nodeType === 3) return this.data;
    let s = '';
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    setOwner(n, this.ownerDocument || (this.nodeType === 9 ? this : null));
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this;
    setOwner(n, this.ownerDocument || (this.nodeType === 9 ? this : null));
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let c = n; c; c = c.parentNode) if (c === this) return true; return false; }
  // Only DOCUMENT_POSITION_FOLLOWING (4) / PRECEDING (2) / CONTAINS (8) / CONTAINED_BY (16).
  compareDocumentPosition(other) {
    if (other === this) return 0;
    if (this.contains(other)) return 16 | 4;
    if (other.contains(this)) return 8 | 2;
    const order = (this.ownerDocument || this)._order();
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
}
function setOwner(n, doc) { if (!doc) return; n.ownerDocument = doc; for (const c of n.childNodes) setOwner(c, doc); }

class Text extends Node { constructor(data) { super(3); this.data = String(data); } get nodeName() { return '#text'; } }

class Element extends Node {
  constructor(tag) {
    super(1);
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = [];
    this._listeners = {};
    this._value = null;
    const self = this;
    this.style = {
      get cssText() { return self.getAttribute('style') || ''; },
      set cssText(v) { self.setAttribute('style', String(v)); },
      get display() { const m = /display\s*:\s*([a-z-]+)/i.exec(self.getAttribute('style') || ''); return m ? m[1] : ''; },
      set display(v) { const s = (self.getAttribute('style') || '').replace(/display\s*:\s*[a-z-]+;?/ig, ''); self.setAttribute('style', v ? `${s};display:${v}` : s); },
      get cursor() { return ''; }, set cursor(_) {},
    };
    this.classList = {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (c) => { if (!self.classList.contains(c)) self.setAttribute('class', `${self.className} ${c}`.trim()); },
      remove: (c) => self.setAttribute('class', self.className.split(/\s+/).filter((x) => x && x !== c).join(' ')),
    };
  }
  get nodeName() { return this.tagName; }
  get attributes() { return this._attrs.map((a) => ({ name: a.name, value: a.value })); }
  getAttribute(n) { const a = this._attrs.find((x) => x.name === String(n).toLowerCase()); return a ? a.value : null; }
  setAttribute(n, v) { const k = String(n).toLowerCase(); const a = this._attrs.find((x) => x.name === k); if (a) a.value = String(v); else this._attrs.push({ name: k, value: String(v) }); }
  removeAttribute(n) { this._attrs = this._attrs.filter((x) => x.name !== String(n).toLowerCase()); }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return ''; }
  set innerHTML(v) { this.textContent = ''; if (v) { const frag = parseInto(this.ownerDocument, String(v)); for (const c of frag) this.appendChild(c); } }
  // textarea / input value (defaults to the text inside / the value attribute)
  get value() { if (this._value != null) return this._value; return this.localName === 'textarea' ? this.textContent : (this.getAttribute('value') || ''); }
  set value(v) { this._value = String(v); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get type() { return this.getAttribute('type') || (this.localName === 'button' ? 'submit' : 'text'); }
  get isContentEditable() {
    for (let e = this; e && e.nodeType === 1; e = e.parentElement) {
      const v = e.getAttribute('contenteditable');
      if (v === null) continue;
      return v !== 'false';
    }
    return false;
  }
  get hidden() { return this.hasAttribute('hidden'); }
  getBoundingClientRect() {
    for (let e = this; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hasAttribute('hidden') || /display\s*:\s*none/i.test(e.getAttribute('style') || '')) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  }
  matches(sel) { return matchesList(this, parseList(sel)); }
  closest(sel) { const list = parseList(sel); for (let e = this; e && e.nodeType === 1; e = e.parentElement) if (matchesList(e, list)) return e; return null; }
  querySelectorAll(sel) { const list = parseList(sel); return descendants(this).filter((e) => matchesList(e, list)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn, _cap) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    const path = [];
    for (let e = this; e; e = e.parentNode) path.push(e);
    for (const n of path) for (const fn of (n._listeners && n._listeners[ev.type]) || []) { try { fn(ev); } catch (_) {} }
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopImmediatePropagation() {} }); }
  focus() {}
  scrollIntoView() {}
}

class Document extends Node {
  constructor(url) {
    super(9);
    this.ownerDocument = null;
    this._listeners = {};
    this.location = { href: url || 'about:blank', hostname: hostOf(url), pathname: pathOf(url) };
    this.title = '';
  }
  get documentElement() { return this.childNodes.find((c) => c.nodeType === 1) || null; }
  get body() { const h = this.documentElement; return h ? (h.children.find((c) => c.localName === 'body') || null) : null; }
  get head() { const h = this.documentElement; return h ? (h.children.find((c) => c.localName === 'head') || null) : null; }
  createElement(tag) { const e = new Element(tag); e.ownerDocument = this; return e; }
  createTextNode(t) { const n = new Text(t); n.ownerDocument = this; return n; }
  getElementById(id) { return descendants(this).find((e) => e.id === id) || null; }
  querySelectorAll(sel) { const list = parseList(sel); return descendants(this).filter((e) => matchesList(e, list)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { for (const fn of this._listeners[ev.type] || []) { try { fn(ev); } catch (_) {} } return true; }
  _order() { return descendants(this); }
}
function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }
function pathOf(u) { try { return new URL(u).pathname; } catch (_) { return '/'; } }
function descendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

// ---- a tolerant mini HTML parser ------------------------------------------------
function decode(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'); }
function parseInto(doc, html) {
  const root = doc.createElement('#fragment');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const s = String(html);
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const j = s.indexOf('-->', i + 4); i = j < 0 ? s.length : j + 3; continue; }
    if (s.startsWith('<!', i)) { const j = s.indexOf('>', i); i = j < 0 ? s.length : j + 1; continue; }
    if (s[i] === '<' && s[i + 1] === '/') {
      const j = s.indexOf('>', i);
      const name = s.slice(i + 2, j < 0 ? s.length : j).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === name) { stack.length = k; break; }
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (s[i] === '<' && /[a-zA-Z]/.test(s[i + 1] || '')) {
      const m = /^<([a-zA-Z][\w:-]*)/.exec(s.slice(i));
      const tag = m[1].toLowerCase();
      let k = i + m[0].length;
      const el = doc.createElement(tag);
      let selfClose = false;
      while (k < s.length) {
        while (/\s/.test(s[k])) k++;
        if (s[k] === '>') { k++; break; }
        if (s[k] === '/' && s[k + 1] === '>') { selfClose = true; k += 2; break; }
        const am = /^([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(s.slice(k));
        if (!am) { k++; continue; }
        el.setAttribute(am[1], decode(am[2] != null ? am[2] : am[3] != null ? am[3] : am[4] != null ? am[4] : ''));
        k += am[0].length;
      }
      top().appendChild(el);
      i = k;
      if (RAWTEXT.has(tag)) {
        const end = s.toLowerCase().indexOf(`</${tag}`, i);
        const raw = s.slice(i, end < 0 ? s.length : end);
        if (raw) el.appendChild(doc.createTextNode(decode(raw)));
        const close = end < 0 ? s.length : s.indexOf('>', end);
        i = close < 0 ? s.length : close + 1;
        continue;
      }
      if (!selfClose && !VOID.has(tag)) stack.push(el);
      continue;
    }
    const j = s.indexOf('<', i + 1);
    const txt = s.slice(i, j < 0 ? s.length : j);
    if (txt) top().appendChild(doc.createTextNode(decode(txt)));
    i = j < 0 ? s.length : j;
  }
  const kids = root.childNodes.slice();
  for (const c of kids) root.removeChild(c);
  return kids;
}
function parseHTML(html, opts) {
  const doc = new Document((opts && opts.url) || 'https://example.test/');
  const nodes = parseInto(doc, html);
  let htmlEl = nodes.find((n) => n.nodeType === 1 && n.localName === 'html');
  if (!htmlEl) {
    htmlEl = doc.createElement('html');
    const body = doc.createElement('body');
    htmlEl.appendChild(doc.createElement('head'));
    htmlEl.appendChild(body);
    for (const n of nodes) body.appendChild(n);
  } else if (!htmlEl.children.find((c) => c.localName === 'body')) {
    const body = doc.createElement('body');
    for (const c of htmlEl.childNodes.slice()) body.appendChild(c);
    htmlEl.appendChild(body);
  }
  doc.appendChild(htmlEl);
  if (opts && opts.title) doc.title = opts.title;
  return doc;
}

// ---- selectors ---------------------------------------------------------------------
const cache = new Map();
function splitTop(s, sep) {
  const out = []; let depth = 0, q = null, cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseList(sel) {
  const key = String(sel);
  if (cache.has(key)) return cache.get(key);
  const list = splitTop(key, ',').map((x) => x.trim()).filter(Boolean).map(parseComplex);
  if (!list.length) throw new Error(`bad selector: ${key}`);
  cache.set(key, list);
  return list;
}
// complex: [{ compound, comb }] where comb joins it to the PREVIOUS part (' ' or '>')
function parseComplex(s) {
  const parts = [];
  let i = 0, cur = '', depth = 0, q = null, comb = null;
  const flush = () => { if (cur.trim()) { parts.push({ compound: parseCompound(cur.trim()), comb }); comb = ' '; } cur = ''; };
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
      if (ch !== '>') throw new Error(`unsupported combinator ${ch}`);
      flush(); comb = '>'; continue;
    }
    if (depth === 0 && /\s/.test(ch)) { if (cur.trim()) { flush(); } continue; }
    cur += ch;
  }
  flush();
  if (parts.length) parts[0].comb = null;
  return parts;
}
function parseCompound(s) {
  const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const m0 = /^(\*|[a-zA-Z][\w-]*)/.exec(s);
  if (m0) { c.tag = m0[1] === '*' ? null : m0[1].toLowerCase(); i = m0[0].length; }
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { const m = /^#([\w-]+)/.exec(s.slice(i)); c.ids.push(m[1]); i += m[0].length; }
    else if (ch === '.') { const m = /^\.([\w-]+)/.exec(s.slice(i)); if (!m) throw new Error(`bad class in ${s}`); c.classes.push(m[1]); i += m[0].length; }
    else if (ch === '[') {
      let j = i + 1, q = null;
      for (; j < s.length; j++) { const x = s[j]; if (q) { if (x === q) q = null; continue; } if (x === '"' || x === "'") q = x; else if (x === ']') break; }
      const body = s.slice(i + 1, j).trim();
      const m = /^([\w:-]+)\s*(?:([~*^$|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?)?$/.exec(body);
      if (!m) throw new Error(`bad attribute selector [${body}]`);
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5], ci: !!m[6] });
      i = j + 1;
    } else if (ch === ':') {
      const m = /^:([\w-]+)/.exec(s.slice(i));
      const name = m[1]; i += m[0].length;
      let arg = null;
      if (s[i] === '(') {
        let depth = 0, j = i;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') { depth--; if (!depth) break; } }
        arg = s.slice(i + 1, j); i = j + 1;
      }
      if (!['not', 'has', 'first-child', 'last-child'].includes(name)) throw new Error(`unsupported pseudo :${name}`);
      c.pseudos.push({ name, list: arg != null ? parseList(arg) : null });
    } else throw new Error(`bad selector part '${s.slice(i)}'`);
  }
  return c;
}
function attrOk(el, a) {
  const v = el.getAttribute(a.name);
  if (v === null) return false;
  if (!a.op) return true;
  const x = a.ci ? v.toLowerCase() : v;
  const w = a.ci ? String(a.value).toLowerCase() : String(a.value);
  switch (a.op) {
    case '=': return x === w;
    case '~=': return x.split(/\s+/).includes(w);
    case '*=': return w !== '' && x.includes(w);
    case '^=': return w !== '' && x.startsWith(w);
    case '$=': return w !== '' && x.endsWith(w);
    case '|=': return x === w || x.startsWith(`${w}-`);
    default: return false;
  }
}
function compoundOk(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  if (c.classes.length) { const cls = el.className.split(/\s+/); for (const k of c.classes) if (!cls.includes(k)) return false; }
  for (const a of c.attrs) if (!attrOk(el, a)) return false;
  for (const p of c.pseudos) {
    if (p.name === 'not' && matchesList(el, p.list)) return false;
    if (p.name === 'has' && !descendants(el).some((d) => matchesList(d, p.list))) return false;
    if (p.name === 'first-child' && (!el.parentElement || el.parentElement.children[0] !== el)) return false;
    if (p.name === 'last-child' && (!el.parentElement || el.parentElement.children[el.parentElement.children.length - 1] !== el)) return false;
  }
  return true;
}
function matchesComplex(el, parts, idx) {
  const part = parts[idx];
  if (!compoundOk(el, part.compound)) return false;
  if (idx === 0) return true;
  if (part.comb === '>') { const p = el.parentElement; return !!p && matchesComplex(p, parts, idx - 1); }
  for (let p = el.parentElement; p; p = p.parentElement) if (matchesComplex(p, parts, idx - 1)) return true;
  return false;
}
function matchesList(el, list) { return list.some((parts) => matchesComplex(el, parts, parts.length - 1)); }

// Run an injected page-script string against a fake page (the same string main.js
// hands to webContents.executeJavaScript). Returns whatever the script returns
// (awaited if it is a promise).
function makeWindow(doc) {
  const win = { document: doc, location: doc.location, setTimeout, clearTimeout, setInterval, clearInterval, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  win.window = win;
  return win;
}
async function runScript(script, doc) {
  const win = doc.__window || (doc.__window = makeWindow(doc));
  const fn = new Function('document', 'window', 'location', 'getComputedStyle', `return (${String(script).trim().replace(/;\s*$/, '')});`);
  return fn(doc, win, doc.location, win.getComputedStyle);
}

// Simple helpers for tests that need to change the page like a user would.
function typeInto(el, text) {
  if (el.localName === 'textarea' || el.localName === 'input') el.value = String(text);
  else { el.textContent = ''; const p = el.ownerDocument.createElement('p'); p.textContent = String(text); el.appendChild(p); }
}
function append(doc, parent, html) { const nodes = parseInto(doc, html); for (const n of nodes) parent.appendChild(n); return nodes.filter((n) => n.nodeType === 1); }

module.exports = { parseHTML, runScript, typeInto, append, Element, Document, Text };
